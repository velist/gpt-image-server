const crypto = require('crypto');

// Separate credentials and accounting from website keys. Store only SHA-256 hashes.
module.exports = function installDistribution(app, db, { authAdmin, proxyRequest, upstreamKey, validateSize, store }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS distribution_keys (
      id TEXT PRIMARY KEY, key_hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL,
      name TEXT NOT NULL, max_images INTEGER NOT NULL, used_images INTEGER NOT NULL DEFAULT 0,
      reserved_images INTEGER NOT NULL DEFAULT 0, expires_at TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, max_concurrent INTEGER NOT NULL DEFAULT 2,
      created_at TEXT NOT NULL, last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS distribution_requests (
      id TEXT PRIMARY KEY, key_id TEXT NOT NULL, requested INTEGER NOT NULL,
      charged INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, error TEXT,
      created_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS distribution_requests_key ON distribution_requests(key_id, created_at);
  `);
  let unavailable = false;
  let writes = Promise.resolve();
  const snapshot = () => ({ version: 1,
    keys: db.prepare('SELECT * FROM distribution_keys ORDER BY id').all(),
    requests: db.prepare('SELECT * FROM distribution_requests ORDER BY id').all() });
  const restore = db.transaction(data => {
    if (data.version !== 1 || !Array.isArray(data.keys) || !Array.isArray(data.requests)) throw new Error('分发备份无效');
    db.prepare('DELETE FROM distribution_requests').run();
    db.prepare('DELETE FROM distribution_keys').run();
    const insertKey = db.prepare(`INSERT INTO distribution_keys (id,key_hash,prefix,name,max_images,used_images,reserved_images,expires_at,enabled,max_concurrent,created_at,last_used_at)
      VALUES (@id,@key_hash,@prefix,@name,@max_images,@used_images,@reserved_images,@expires_at,@enabled,@max_concurrent,@created_at,@last_used_at)`);
    const insertRequest = db.prepare(`INSERT INTO distribution_requests (id,key_id,requested,charged,status,error,created_at,completed_at)
      VALUES (@id,@key_id,@requested,@charged,@status,@error,@created_at,@completed_at)`);
    for (const row of data.keys) insertKey.run(row);
    for (const row of data.requests) insertRequest.run(row);
  });
  async function durable(action) {
    const operation = writes.then(async () => {
      if (unavailable) throw new Error('分发持久化不可用');
      const before = store && JSON.stringify(snapshot());
      const result = action();
      if (store && before !== JSON.stringify(snapshot())) {
        try { await store.save(snapshot()); }
        catch (error) { unavailable = true; console.error('[DISTRIBUTION] backup failed; requests paused:', error.message); throw error; }
      }
      return result;
    });
    writes = operation.catch(() => {});
    return operation;
  }
  const ready = (async () => {
    try {
      if (store) {
        const data = await store.load();
        if (data) restore(data);
        else if (db.prepare('SELECT COUNT(*) AS n FROM distribution_keys').get().n) throw new Error('远程分发备份丢失，拒绝以本地状态覆盖');
      }
      const changed = db.prepare("UPDATE distribution_requests SET status='uncertain', error='服务重启，请核对上游记录后结算' WHERE status='pending'").run().changes;
      if (store && changed) await store.save(snapshot());
    } catch (error) { unavailable = true; console.error('[DISTRIBUTION] initialization failed:', error.message); }
  })();
  const available = async (req, res, next) => {
    await ready;
    await writes;
    if (unavailable) return res.status(503).json({ error: { message: '分发持久化暂不可用，请管理员检查备份配置后重启服务' } });
    next();
  };
  app.use('/api/admin/distribution', available);
  app.use('/v1', available);
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const fail = (res, status, message) => res.status(status).json({ error: { message } });
  const view = row => ({ id: row.id, name: row.name, prefix: row.prefix,
    maxImages: row.max_images, usedImages: row.used_images, reservedImages: row.reserved_images,
    remaining: row.max_images === -1 ? -1 : Math.max(0, row.max_images - row.used_images - row.reserved_images),
    expiresAt: row.expires_at, enabled: !!row.enabled, maxConcurrent: row.max_concurrent,
    createdAt: row.created_at, lastUsedAt: row.last_used_at });
  function fields(body, row) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('参数必须是 JSON 对象');
    const name = body.name ?? row?.name ?? '';
    const max = body.maxImages ?? row?.max_images ?? 100;
    const concurrent = body.maxConcurrent ?? row?.max_concurrent ?? 2;
    const expiry = body.expiresAt === undefined ? row?.expires_at ?? null : body.expiresAt;
    const enabled = body.enabled ?? (row ? !!row.enabled : true);
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('客户名称须为 1–100 个字符');
    if (!Number.isSafeInteger(max) || max < -1) throw new Error('额度须为非负整数，或 -1（不限）');
    if (row && max !== -1 && max < row.used_images + row.reserved_images) throw new Error('额度不能低于已用与预占张数之和');
    if (!Number.isInteger(concurrent) || concurrent < 1 || concurrent > 10) throw new Error('并发限制须为 1–10');
    if (expiry !== null && (typeof expiry !== 'string' || !Number.isFinite(Date.parse(expiry)))) throw new Error('到期时间无效');
    if (typeof enabled !== 'boolean') throw new Error('启用状态无效');
    return [name.trim(), max, expiry === null ? null : new Date(expiry).toISOString(), enabled ? 1 : 0, concurrent];
  }
  app.use('/api/admin/distribution', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (authAdmin(req)?.role !== 'admin') return fail(res, 401, '请先登录管理后台');
    next();
  });
  app.get('/api/admin/distribution', (req, res) => {
    res.json({ data: db.prepare('SELECT * FROM distribution_keys ORDER BY created_at DESC').all().map(view) });
  });
  app.post('/api/admin/distribution', async (req, res) => {
    try {
      const values = fields(req.body);
      const id = crypto.randomUUID();
      const key = 'sk-dist-' + crypto.randomBytes(32).toString('hex');
      await durable(() => db.prepare(`INSERT INTO distribution_keys (id, key_hash, prefix, name, max_images, expires_at, enabled, max_concurrent, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, hash(key), key.slice(0, 16), ...values, new Date().toISOString()));
      res.status(201).json({ ...view(db.prepare('SELECT * FROM distribution_keys WHERE id = ?').get(id)), key });
    } catch (err) { fail(res, unavailable ? 503 : 400, unavailable ? '持久化失败，分发服务已暂停，请联系管理员' : err.message); }
  });
  app.patch('/api/admin/distribution/:id', async (req, res) => {
    try {
      const row = db.prepare('SELECT * FROM distribution_keys WHERE id = ?').get(req.params.id);
      if (!row) return fail(res, 404, '密钥不存在');
      await durable(() => {
        const latest = db.prepare('SELECT * FROM distribution_keys WHERE id = ?').get(row.id);
        return db.prepare('UPDATE distribution_keys SET name=?, max_images=?, expires_at=?, enabled=?, max_concurrent=? WHERE id=?')
          .run(...fields(req.body, latest), row.id);
      });
      res.json(view(db.prepare('SELECT * FROM distribution_keys WHERE id = ?').get(row.id)));
    } catch (err) { fail(res, unavailable ? 503 : 400, unavailable ? '持久化失败，分发服务已暂停，请联系管理员' : err.message); }
  });
  app.get('/api/admin/distribution/:id/requests', (req, res) => {
    res.json({ data: db.prepare('SELECT * FROM distribution_requests WHERE key_id = ? ORDER BY created_at DESC LIMIT 100').all(req.params.id) });
  });
  const settleLocal = db.transaction((id, count, status, error) => {
    const request = db.prepare('SELECT * FROM distribution_requests WHERE id = ?').get(id);
    if (!request || !['pending', 'uncertain'].includes(request.status)) return;
    db.prepare('UPDATE distribution_keys SET reserved_images=reserved_images-?, used_images=used_images+? WHERE id=?')
      .run(request.requested, count, request.key_id);
    db.prepare('UPDATE distribution_requests SET charged=?, status=?, error=?, completed_at=? WHERE id=?')
      .run(count, status, error, new Date().toISOString(), id);
  });
  const settle = (id, count, status, error) => durable(() => settleLocal(id, count, status, error));
  // A restart cannot establish whether the upstream already generated images. Keep reservation for review.
  app.post('/api/admin/distribution/:id/requests/:requestId/settle', async (req, res) => {
    const row = db.prepare('SELECT * FROM distribution_requests WHERE id=? AND key_id=?').get(req.params.requestId, req.params.id);
    if (!row) return fail(res, 404, '请求不存在');
    if (row.status !== 'uncertain') return fail(res, 409, '仅可人工结算待核对请求');
    const count = req.body?.charged;
    if (!Number.isInteger(count) || count < 0 || count > row.requested) return fail(res, 400, '结算张数无效');
    try {
      await durable(() => {
        if (db.prepare('SELECT status FROM distribution_requests WHERE id=?').get(row.id).status !== 'uncertain') throw new Error('请求已结算');
        settleLocal(row.id, count, 'reviewed', '管理员核对结算');
      });
      res.json({ ok: true });
    } catch (error) { fail(res, unavailable ? 503 : 409, unavailable ? '持久化失败，请联系管理员' : error.message); }
  });
  app.use('/v1', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    const match = /^Bearer (\S+)$/i.exec(req.headers.authorization || '');
    const row = match && db.prepare('SELECT * FROM distribution_keys WHERE key_hash=?').get(hash(match[1]));
    if (!row) return fail(res, 401, '无效的分发 API Key');
    if (!row.enabled) return fail(res, 403, 'API Key 已停用');
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return fail(res, 403, 'API Key 已到期');
    req.distributionKey = row;
    next();
  });
  app.get('/v1/usage', (req, res) => res.json(view(req.distributionKey)));
  app.get('/v1/models', (req, res) => res.json({ object: 'list', data: [{ id: 'gpt-image-2', object: 'model', owned_by: 'site' }] }));
  const reserve = db.transaction((keyId, n, id) => {
    const row = db.prepare('SELECT * FROM distribution_keys WHERE id=?').get(keyId);
    if (!row.enabled || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) return '密钥已停用或到期';
    if (row.max_images !== -1 && row.used_images + row.reserved_images + n > row.max_images) return '剩余张数不足';
    const active = db.prepare("SELECT COUNT(*) AS n FROM distribution_requests WHERE key_id=? AND status IN ('pending','uncertain')").get(keyId).n;
    if (active >= row.max_concurrent) return '已达到并发限制，请稍后重试';
    const now = new Date().toISOString();
    db.prepare('UPDATE distribution_keys SET reserved_images=reserved_images+?, last_used_at=? WHERE id=?').run(n, now, keyId);
    db.prepare("INSERT INTO distribution_requests (id,key_id,requested,status,created_at) VALUES (?,?,?,'pending',?)").run(id, keyId, n, now);
    return null;
  });
  app.post('/v1/images/generations', async (req, res) => {
    const input = req.body;
    if (!input || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 32000) return fail(res, 400, 'prompt 须为 1–32000 字符');
    const n = input.n === undefined ? 1 : input.n;
    if (!Number.isInteger(n) || n < 1 || n > 10) return fail(res, 400, 'n 须为 1–10 的整数');
    if (input.model !== undefined && input.model !== 'gpt-image-2') return fail(res, 400, '仅支持 gpt-image-2');
    const sizeError = input.size === 'auto' ? null : validateSize(input.size);
    if (sizeError) return fail(res, 400, sizeError);
    if (input.response_format !== undefined && !['b64_json', 'url'].includes(input.response_format)) return fail(res, 400, 'response_format 须为 b64_json 或 url');
    const body = { model: 'gpt-image-2', prompt: input.prompt, n, response_format: input.response_format || 'b64_json' };
    for (const key of ['size', 'quality', 'background', 'output_format', 'output_compression', 'moderation']) {
      if (input[key] !== undefined) body[key] = input[key];
    }
    const id = crypto.randomUUID();
    let error;
    try { error = await durable(() => reserve(req.distributionKey.id, n, id)); }
    catch { return fail(res, 503, '无法持久化预占额度，未发送生图请求，请联系管理员'); }
    if (error) return fail(res, 429, error);
    res.setHeader('X-Request-Id', id);
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
    try {
      const result = await proxyRequest('/images/generations', 'POST', {
        'Content-Type': 'application/json', Authorization: 'Bearer ' + upstreamKey()
      }, JSON.stringify(body));
      if (result.status >= 400 && result.status < 500) {
        await settle(id, 0, 'failed', '上游拒绝请求 HTTP ' + result.status);
        return fail(res, 502, '上游拒绝请求，额度已退回；请联系管理员并提供请求 ID');
      }
      if (result.status !== 200) throw new Error('上游响应异常');
      const data = JSON.parse(result.body.toString('utf8'));
      if (!Array.isArray(data.data) || !data.data.length || data.data.length > n || data.data.some(item => !item || !(typeof item.b64_json === 'string' && item.b64_json.length || typeof item.url === 'string' && item.url.length))) throw new Error('上游图片数据异常');
      await settle(id, data.data.length, 'success', null);
      res.json(data);
    } catch {
      if (unavailable) return fail(res, 503, '结算持久化失败，请联系管理员核对请求 ID，勿自动重试');
      try {
        await durable(() => db.prepare("UPDATE distribution_requests SET status='uncertain', error='上游结果不确定，请核对后结算' WHERE id=? AND status='pending'").run(id));
      } catch { return fail(res, 503, '异常记录持久化失败，请联系管理员，勿自动重试'); }
      fail(res, 502, '上游结果不确定，额度暂时预占；请联系管理员并提供请求 ID，勿自动重试');
    }
  });
  return { ready };
};
