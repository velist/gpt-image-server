const express = require('express');
const https = require('https');
const http = require('http');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

// Load .env manually if no dotenv
if (!process.env.UPSTREAM_API_BASE) {
  try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
      }
    }
  } catch {}
}

// Config
const UPSTREAM_BASE = process.env.UPSTREAM_API_BASE || 'https://api.duckcoding.ai/v1';
const UPSTREAM_KEY = process.env.UPSTREAM_API_KEY || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const PORT = parseInt(process.env.PORT) || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'velist/gpt-image-server';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'master';
const KEY_BACKUP_PATH = 'data/keys-backup.json';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const app = express();

// --- SQLite ---
const Database = require('better-sqlite3');
const dbDir = process.env.IMAGE_DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(path.join(dbDir, 'keys.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS keys (
    id TEXT PRIMARY KEY,
    key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    max_images INTEGER NOT NULL DEFAULT -1,
    used_images INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    enabled INTEGER NOT NULL DEFAULT 1,
    last_used_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_keys_key ON keys(key);

  CREATE TABLE IF NOT EXISTS generate_tasks (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    key_id TEXT NOT NULL,
    request_json TEXT NOT NULL,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    expires_at TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error_at TEXT,
    FOREIGN KEY (key_id) REFERENCES keys(id)
  );
  CREATE INDEX IF NOT EXISTS idx_generate_tasks_status ON generate_tasks(status);
  CREATE INDEX IF NOT EXISTS idx_generate_tasks_expires_at ON generate_tasks(expires_at);
  CREATE INDEX IF NOT EXISTS idx_generate_tasks_created_at ON generate_tasks(created_at);
`);

// Task owners can now come from either credential table. Preserve existing task rows on upgrade.
if (db.pragma('foreign_key_list(generate_tasks)').length) db.transaction(() => {
  const def = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='generate_tasks'").get().sql;
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='generate_tasks' AND sql IS NOT NULL").all();
  db.exec(def.replace('generate_tasks','shared_tasks').replace(/,\s*FOREIGN KEY\s*\(key_id\) REFERENCES keys\(id\)/i,''));
  db.exec('INSERT INTO shared_tasks SELECT * FROM generate_tasks; DROP TABLE generate_tasks; ALTER TABLE shared_tasks RENAME TO generate_tasks');
  for(const {sql} of indexes) db.exec(sql);
})();
// --- Helpers ---
function generateKey() {
  return 'sk-gi-' + crypto.randomBytes(24).toString('hex');
}

function authAdmin(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  try { return jwt.verify(auth.slice(7), JWT_SECRET); }
  catch { return null; }
}

function validateSize(size) {
  if (size === undefined || size === null) return null;
  const match = String(size).match(/^(\d+)x(\d+)$/);
  if (!match) return '尺寸格式应为 宽x高，例如 1024x1024';
  const width = parseInt(match[1], 10);
  const height = parseInt(match[2], 10);
  if (width < 1 || height < 1 || width > 3840 || height > 3840) return '宽高必须在 1-3840 像素之间';
  return null;
}

async function workbenchKey(req,res) {
  try { await quota.check(); } catch { res.status(503).json({error:'额度持久化暂不可用'}); return; }
  const row = quota.resolve(req.headers['x-api-key']);
  if (!row || !row.enabled || (row.expires_at && Date.parse(row.expires_at)<=Date.now())) {
    res.status(403).json({error:'密钥无效、已停用或已到期'}); return;
  }
  return row;
}
async function hold(row,n,id,res) {
  if (!Number.isInteger(n) || n<1 || n>10) { res.status(400).json({error:'n 须为 1–10 的整数'}); return false; }
  try { const error = await quota.reserve(row.id,n,id); if (!error) return true;
    res.status(429).json({error}); } catch { res.status(503).json({error:'无法持久化预占额度'}); } return false;
}
function imageCount(raw,max) {
  const items=JSON.parse(raw).data;
  if (!Array.isArray(items)||!items.length||items.length>max||items.some(i=>!(typeof i?.url==='string'&&i.url.length || typeof i?.b64_json==='string'&&i.b64_json.length))) throw Error('上游图片数据异常');
  return items.length;
}
function keyToJSON(row) {
  const balance = quota.view(quota.siteRow(row));
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    maxImages: row.max_images,
    usedImages: balance.usedImages, reservedImages: balance.reservedImages,
    remaining: balance.remaining,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    enabled: !!row.enabled,
    lastUsedAt: balance.lastUsedAt
  };
}

function allKeysJSON() {
  return db.prepare('SELECT * FROM keys ORDER BY created_at DESC').all().map(keyToJSON);
}

const TASK_TTL_MS = 60 * 60 * 1000;
const TERMINAL_TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// --- Result images persistence ---
const RESULTS_DIR = path.join(dbDir, 'results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

function mimeExtFromFormat(format) {
  const f = String(format || '').toLowerCase();
  if (f === 'jpeg' || f === 'jpg') return 'jpg';
  if (f === 'webp') return 'webp';
  return 'png';
}

// Decode b64_json images to disk, return a result_json string with url refs.
function persistResultImagesToDisk(taskId, upstreamBody, outputFormat) {
  let parsed;
  try { parsed = JSON.parse(upstreamBody); } catch { return upstreamBody; }
  if (!parsed || !Array.isArray(parsed.data)) return upstreamBody;
  const ext = mimeExtFromFormat(outputFormat);
  const newData = parsed.data.map((item, idx) => {
    if (item && typeof item.b64_json === 'string' && item.b64_json.length > 0) {
      try {
        const buf = Buffer.from(item.b64_json, 'base64');
        const fname = `${taskId}-${idx}.${ext}`;
        fs.writeFileSync(path.join(RESULTS_DIR, fname), buf);
        const rest = { ...item };
        delete rest.b64_json;
        return { ...rest, url: `/results-files/${fname}` };
      } catch (err) {
        console.error('[RESULTS] write failed for task=' + taskId + ' idx=' + idx + ':', err.message);
        return item;
      }
    }
    return item;
  });
  return JSON.stringify({ ...parsed, data: newData });
}

function deleteResultFilesForTask(taskId) {
  try {
    const prefix = taskId + '-';
    for (const f of fs.readdirSync(RESULTS_DIR)) {
      if (f.startsWith(prefix)) {
        try { fs.unlinkSync(path.join(RESULTS_DIR, f)); } catch {}
      }
    }
  } catch {}
}

function nowIso() {
  return new Date().toISOString();
}

function taskRowToStatusJSON(row) {
  return {
    status: row.status,
    error: row.error || undefined,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : undefined
  };
}

function createGenerateTask(keyId, body, id) {
  const now = nowIso();
  const expiresAt = new Date(Date.now() + TASK_TTL_MS).toISOString();
  db.prepare(`INSERT INTO generate_tasks (id, status, key_id, request_json, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, 'queued', keyId, JSON.stringify(body), now, now, expiresAt);
  return id;
}

function getGenerateTask(taskId) {
  return db.prepare('SELECT * FROM generate_tasks WHERE id = ?').get(taskId);
}

function markExpiredTasks() {
  const now = nowIso();
  db.prepare("UPDATE generate_tasks SET status = 'expired', error = COALESCE(error, '任务已过期'), updated_at = ?, completed_at = COALESCE(completed_at, ?), last_error_at = COALESCE(last_error_at, ?) WHERE status IN ('queued','running') AND expires_at <= ?")
    .run(now, now, now, now);
}

function deleteOldTerminalTasks() {
  const cutoff = new Date(Date.now() - TERMINAL_TASK_RETENTION_MS).toISOString();
  const toDel = db.prepare("SELECT id FROM generate_tasks WHERE status IN ('done','error','expired') AND updated_at <= ?").all(cutoff);
  for (const row of toDel) deleteResultFilesForTask(row.id);
  db.prepare("DELETE FROM generate_tasks WHERE status IN ('done','error','expired') AND updated_at <= ?")
    .run(cutoff);
}

function startTaskCleanupLoop() {
  markExpiredTasks();
  deleteOldTerminalTasks();
  setInterval(() => {
    markExpiredTasks();
    deleteOldTerminalTasks();
  }, 10 * 60 * 1000);
}

async function recoverPendingTasksOnStartup() {
  markExpiredTasks();
  const rows = db.prepare("SELECT id, key_id, request_json FROM generate_tasks WHERE status IN ('queued','running') AND expires_at > ? ORDER BY created_at ASC").all(nowIso());
  for (const row of rows) {
    db.prepare("UPDATE generate_tasks SET status='error',error='服务重启，任务未重试；请核对记录',completed_at=?,updated_at=? WHERE id=?").run(nowIso(),nowIso(),row.id);
  }
}

const finishGenerateTaskSuccess = db.transaction((taskId, keyId, resultJson) => {
  const now = nowIso();
  db.prepare("UPDATE generate_tasks SET status = 'done', result_json = ?, error = NULL, updated_at = ?, completed_at = ? WHERE id = ?")
    .run(resultJson, now, now, taskId);

});

let gitHubTokenValid = false;

async function verifyGitHubToken() {
  if (!GITHUB_TOKEN) {
    console.log('[KEY BACKUP] GITHUB_TOKEN 未配置 — Key 备份已禁用');
    return false;
  }
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'gpt-image-server' }
    });
    if (res.ok) {
      console.log('[KEY BACKUP] GitHub Token 有效，备份功能正常');
      return true;
    }
    if (res.status === 401) {
      console.error('[KEY BACKUP] GITHUB_TOKEN 已失效 (Bad credentials)！请到 GitHub 生成新的 Personal Access Token 并更新 Render 环境变量！');
      return false;
    }
    console.error(`[KEY BACKUP] GitHub Token 验证异常: HTTP ${res.status}`);
    return false;
  } catch (err) {
    console.error('[KEY BACKUP] GitHub Token 验证网络失败:', err.message);
    return false;
  }
}

function writeLocalKeyBackup(content) {
  const backupPath = path.join(dbDir, 'keys-backup.json');
  fs.writeFileSync(backupPath, content, 'utf8');
  console.log(`[KEY BACKUP] \u672c\u5730\u5907\u4efd\u5df2\u66f4\u65b0: ${backupPath} (${content.length} bytes)`);
}

function replaceKeysFromBackup(items) {
  const stmt = db.prepare(`INSERT INTO keys (id, key, name, max_images, used_images, expires_at, created_at, enabled, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const tx = db.transaction(keys => {
    db.prepare('DELETE FROM keys').run();
    for (const k of keys) {
      stmt.run(k.id || uuidv4(), k.key, k.name || '', k.maxImages ?? -1, k.usedImages || 0, k.expiresAt || null, k.createdAt || new Date().toISOString(), k.enabled === false ? 0 : 1, k.lastUsedAt || null);
    }
  });
  tx(items);
}

async function fetchGitHubKeyBackup() {
  if (!GITHUB_TOKEN || !gitHubTokenValid) return null;
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${KEY_BACKUP_PATH}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'gpt-image-server'
    }
  });
  if (res.status === 404) return null;
  if (res.status === 401) { gitHubTokenValid = false; console.error('[KEY BACKUP] GITHUB_TOKEN 已失效！'); return null; }
  if (!res.ok) throw new Error(`GitHub \u8bfb\u53d6\u5907\u4efd\u5931\u8d25: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  const fileContent = Buffer.from((data.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
  return { sha: data.sha, content: fileContent, keys: JSON.parse(fileContent) };
}

const siteStore = GITHUB_TOKEN && require('./distribution-backup')({ token:GITHUB_TOKEN, repo:GITHUB_REPO,
  branch:GITHUB_BRANCH, secret:process.env.DISTRIBUTION_BACKUP_SECRET, file:'data/workbench-backup.enc.json' });
async function restoreKeysFromBackupFile() {
  const local = path.join(dbDir,'keys-backup.json');
  if (siteStore) {
    const saved = await siteStore.load();
    if (saved) {
      if (saved.version!==1 || !Array.isArray(saved.keys)) throw Error('工作台密钥备份格式错误');
      replaceKeysFromBackup(saved.keys); return;
    }
    if (!gitHubTokenValid) throw Error('无法核对旧密钥备份');
    const old = await fetchGitHubKeyBackup();
    if (!gitHubTokenValid) throw Error('无法核对旧密钥备份');
    if (old) { if (!Array.isArray(old.keys)) throw Error('旧密钥备份格式错误'); replaceKeysFromBackup(old.keys); }
    else if (fs.existsSync(local)) replaceKeysFromBackup(JSON.parse(fs.readFileSync(local,'utf8')));
    await siteStore.save({version:1,keys:allKeysJSON()}); return;
  }
  if (fs.existsSync(local)) replaceKeysFromBackup(JSON.parse(fs.readFileSync(local,'utf8')));
}
let siteWrites=Promise.resolve();
async function persistKeysToGitHub() {
  const operation=siteWrites.then(async()=>{
    const keys=allKeysJSON();
    if (siteStore) await siteStore.save({version:1,keys});
    else writeLocalKeyBackup(JSON.stringify(keys));
  });
  siteWrites=operation.catch(()=>{}); return operation;
}
const startup = (async () => {
  gitHubTokenValid = await verifyGitHubToken();
  await quota.ready;
  await quota.check();
  await restoreKeysFromBackupFile();

  startTaskCleanupLoop();
  await recoverPendingTasksOnStartup();
})();

// --- Middleware ---
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Examples gallery (优秀示例) ---
const EXAMPLES_DIR = path.join(__dirname, '优秀示例');
app.use('/examples-assets', express.static(EXAMPLES_DIR, {
  fallthrough: true,
  maxAge: '7d',
}));

// --- Persisted result images (b64 落盘后通过 URL 访问) ---
app.use('/results-files', express.static(RESULTS_DIR, {
  fallthrough: false,
  maxAge: '7d',
  setHeaders(res) {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  },
}));
app.get('/api/examples', (req, res) => {
  try {
    if (!fs.existsSync(EXAMPLES_DIR)) return res.json({ items: [] });
    const files = fs.readdirSync(EXAMPLES_DIR);
    const stems = new Set();
    for (const f of files) {
      const dot = f.lastIndexOf('.');
      if (dot > 0) stems.add(f.slice(0, dot));
    }
    // Normalize a field that could be string or object into a display string
    const _str = (v) => {
      if (!v) return '';
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return v.join('，');
      if (typeof v === 'object') {
        const parts = Object.values(v).filter(p => typeof p === 'string' && p.trim());
        return parts.join(' · ') || '';
      }
      return String(v);
    };
    const items = [];
    for (const stem of stems) {
      const jsonPath = path.join(EXAMPLES_DIR, stem + '.json');
      if (!fs.existsSync(jsonPath)) continue;
      const imageExt = ['png', 'jpg', 'jpeg', 'webp'].find(ext =>
        fs.existsSync(path.join(EXAMPLES_DIR, stem + '.' + ext))
      );
      if (!imageExt) continue;
      let data;
      try { data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')); }
      catch { continue; }
      items.push({
        id: stem,
        name: stem,
        image: '/examples-assets/' + encodeURIComponent(stem + '.' + imageExt),
        prompt: data.main_prompt || data.prompt || data.mainPrompt || '',
        style: _str(data.style),
        keyElements: data.key_elements || '',
        composition: _str(data.composition),
        lightingAndColors: data.lighting_and_colors || _str(data.style?.lighting) || '',
        details: data.details || '',
        aspectRatio: data.aspect_ratio || (data.generation_parameters && data.generation_parameters.aspect_ratio) || '',
        negativePrompt: data.negative_prompt || '',
      });
    }
    items.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    res.json({ items });
  } catch (err) {
    console.error('GET /api/examples failed:', err);
    res.status(500).json({ error: 'examples_load_failed' });
  }
});

// CORS for API routes
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- Upstream Proxy ---
function proxyRequest(targetPath, method, headers, body) {
  return new Promise((resolve, reject) => {
    const base = UPSTREAM_BASE.endsWith('/') ? UPSTREAM_BASE : UPSTREAM_BASE + '/';
    const relPath = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath;
    const url = new URL(relPath, base);
    const mod = url.protocol === 'https:' ? https : http;
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: { ...headers, host: url.hostname },
      rejectUnauthorized: false,
      timeout: 300000
    };
    let responseStarted = false;
    const onTerminalError = err => {
      if (responseStarted) {
        console.error('[proxy] late socket/req error:', err && (err.code || err.message));
        return;
      }
      reject(err);
    };
    const req = mod.request(opts, res => {
      responseStarted = true;
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf });
      });
      res.on('error', err => {
        // If we already have some data, use what we got
        if (chunks.length) {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body: buf });
        } else {
          reject(err);
        }
      });
    });
    req.on('error', onTerminalError);
    // Guard against unhandled TLSSocket 'error' (EPIPE on write) that crashes the process.
    req.on('socket', socket => {
      socket.on('error', onTerminalError);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Upstream timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// --- User API: Generate ---
async function runGenerateTask(taskId, keyId, body) {
  const task = getGenerateTask(taskId);
  if (!task) return;
  const now = nowIso();
  if (new Date(task.expires_at) <= new Date()) {
    await quota.settle(taskId,0,'failed','任务已过期');
    db.prepare("UPDATE generate_tasks SET status = 'expired', error = COALESCE(error, '任务已过期'), updated_at = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?")
      .run(now, now, taskId);
    return;
  }

  db.prepare("UPDATE generate_tasks SET status = 'running', error = NULL, updated_at = ?, started_at = COALESCE(started_at, ?), attempt_count = attempt_count + 1 WHERE id = ?")
    .run(now, now, taskId);

  try {
    const reqHeaders = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (process.env.UPSTREAM_API_KEY || UPSTREAM_KEY)
    };
    const result = await proxyRequest('/images/generations', 'POST', reqHeaders, JSON.stringify(body));

    if (result.status === 200) {
      const responseBody = result.body.toString('utf8');
      const parsed = JSON.parse(responseBody);
      console.log(`[GENERATE] task=${taskId} success, upstream returned ${(parsed.data||[]).length} images`);
      await quota.settle(taskId,imageCount(responseBody,JSON.parse(task.request_json).n || 1),'success',null);
      const persistedJson = persistResultImagesToDisk(taskId, responseBody, body.output_format);
      finishGenerateTaskSuccess(taskId, keyId, persistedJson);

    } else {
      if (result.status>=400 && result.status<500) await quota.settle(taskId,0,'failed','上游拒绝请求'); else await quota.uncertain(taskId);
      let errorMessage = '';
      try {
        const errBody = JSON.parse(result.body.toString('utf8'));
        errorMessage = typeof errBody.error === 'string' ? errBody.error : JSON.stringify(errBody.error || errBody);
      } catch {
        errorMessage = result.body.toString('utf8') || ('HTTP ' + result.status);
      }
      const failedAt = nowIso();
      db.prepare("UPDATE generate_tasks SET status = 'error', error = ?, updated_at = ?, completed_at = ?, last_error_at = ? WHERE id = ?")
        .run(errorMessage, failedAt, failedAt, failedAt, taskId);
    }
  } catch (e) {
    await quota.uncertain(taskId).catch(()=>{});
    const failedAt = nowIso();
    db.prepare("UPDATE generate_tasks SET status = 'error', error = ?, updated_at = ?, completed_at = ?, last_error_at = ? WHERE id = ?")
      .run('上游请求失败: ' + e.message, failedAt, failedAt, failedAt, taskId);
  }
}

app.post('/api/generate', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: '缺少 X-API-Key 请求头' });

  const row = await workbenchKey(req,res); if (!row) return;

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: '缺少 prompt 参数' });
  const sizeError = validateSize(req.body.size);
  if (sizeError) return res.status(400).json({ error: sizeError });

  const body = { ...req.body };
  delete body.prompt;
  body.prompt = prompt;
  if (!body.model) body.model = 'gpt-image-2';
  if (!body.response_format) body.response_format = 'b64_json';

  const taskId = crypto.randomBytes(16).toString('hex');
  if (!await hold(row,body.n === undefined ? 1 : body.n,taskId,res)) return;
  try { createGenerateTask(row.id, body, taskId); } catch(e) { await quota.settle(taskId,0,'failed','创建任务失败'); throw e; }
  runGenerateTask(taskId, row.id, body);
  res.status(202).json({ taskId });
});

app.get('/api/tasks/:id', (req, res) => {
  const task = getGenerateTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在或已过期' });
  if (new Date(task.expires_at) <= new Date() && !['done', 'error', 'expired'].includes(task.status)) {
    const now = nowIso();
    db.prepare("UPDATE generate_tasks SET status = 'expired', error = COALESCE(error, '任务已过期'), updated_at = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?")
      .run(now, now, task.id);
    return res.json({ status: 'expired', error: '任务已过期', createdAt: new Date(task.created_at).getTime() });
  }
  if (task.status === 'done') return res.json({ status: 'done', resultUrl: `/api/tasks/${req.params.id}/result` });
  if (task.status === 'expired') return res.json({ status: 'expired', error: task.error || '任务已过期', createdAt: new Date(task.created_at).getTime() });
  res.json(taskRowToStatusJSON(task));
});

app.get('/api/admin/tasks/by-key/:keyPrefix', (req, res) => {
  const auth = authAdmin(req);
  if (!auth) return res.status(401).json({ error: '未授权' });
  const rows = db.prepare(
    "SELECT gt.id, gt.status, gt.created_at, gt.completed_at, gt.result_json IS NOT NULL as has_result FROM generate_tasks gt JOIN keys k ON (gt.key_id = k.id OR gt.key_id = 'site:' || k.id) WHERE k.key LIKE ? ORDER BY gt.created_at DESC LIMIT 20"
  ).all('%' + req.params.keyPrefix + '%');
  res.json(rows);
});

app.get('/api/tasks/:id/result', (req, res) => {
  const task = getGenerateTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在或已过期' });
  if (task.status !== 'done') return res.status(409).json({ error: '任务尚未完成' });
  try {
    res.json(JSON.parse(task.result_json));
  } catch {
    res.status(500).json({ error: '任务结果损坏' });
  }
});

// --- User API: Edit (async task pool) ---
async function runEditTask(taskId, keyId, filePath) {
  const task = getGenerateTask(taskId);
  if (!task) return;
  const now = nowIso();
  if (new Date(task.expires_at) <= new Date()) {
    await quota.settle(taskId,0,'failed','任务已过期');
    db.prepare("UPDATE generate_tasks SET status = 'expired', error = COALESCE(error, '任务已过期'), updated_at = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?")
      .run(now, now, taskId);
    try { fs.unlinkSync(filePath); } catch {}
    return;
  }

  db.prepare("UPDATE generate_tasks SET status = 'running', error = NULL, updated_at = ?, started_at = COALESCE(started_at, ?), attempt_count = attempt_count + 1 WHERE id = ?")
    .run(now, now, taskId);

  let bodyBuf, boundary;
  try {
    const reqData = JSON.parse(task.request_json);
    const imgBuffer = fs.readFileSync(filePath);
    boundary = '----FormBoundary' + crypto.randomBytes(16).toString('hex');
    const parts = [];

    const addField = (name, value) => {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    };
    const addFile = (name, filename, data, contentType) => {
      const head = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
      parts.push(Buffer.concat([Buffer.from(head), data, Buffer.from('\r\n')]));
    };

    addField('model', reqData.model || 'gpt-image-2');
    addField('prompt', reqData.prompt);
    addFile('image', reqData.image_originalname || 'image.png', imgBuffer, reqData.image_mimetype || 'image/png');
    if (reqData.size) addField('size', reqData.size);
    if (reqData.quality) addField('quality', reqData.quality);
    if (reqData.output_format) addField('output_format', reqData.output_format);
    if (reqData.background) addField('background', reqData.background);
    if (reqData.response_format) addField('response_format', reqData.response_format);
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    bodyBuf = Buffer.concat(parts);
  } catch (e) {
    await quota.settle(taskId,0,'failed','读取参考图失败');
    try { fs.unlinkSync(filePath); } catch {}
    db.prepare("UPDATE generate_tasks SET status = 'error', error = ?, updated_at = ?, completed_at = ?, last_error_at = ? WHERE id = ?")
      .run('读取临时文件失败: ' + e.message, now, now, now, taskId);
    return;
  }

  try {
    const editHeaders = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Authorization': 'Bearer ' + (process.env.UPSTREAM_API_KEY || UPSTREAM_KEY)
    };
    const result = await proxyRequest('/images/edits', 'POST', editHeaders, bodyBuf);

    if (result.status === 200) {
      const responseBody = result.body.toString('utf8');
      try {
        const parsed = JSON.parse(responseBody);
        console.log(`[EDIT] task=${taskId} success, upstream returned ${(parsed.data||[]).length} images`);
      } catch {}
      let editOutputFormat = 'png';
      try { editOutputFormat = JSON.parse(task.request_json).output_format || 'png'; } catch {}
      await quota.settle(taskId,imageCount(responseBody,JSON.parse(task.request_json).n || 1),'success',null);
      const persistedJson = persistResultImagesToDisk(taskId, responseBody, editOutputFormat);
      finishGenerateTaskSuccess(taskId, keyId, persistedJson);

    } else {
      if (result.status>=400 && result.status<500) await quota.settle(taskId,0,'failed','上游拒绝请求'); else await quota.uncertain(taskId);
      let errorMessage = '';
      try {
        const errBody = JSON.parse(result.body.toString('utf8'));
        errorMessage = typeof errBody.error === 'string' ? errBody.error : JSON.stringify(errBody.error || errBody);
      } catch {
        errorMessage = result.body.toString('utf8') || ('HTTP ' + result.status);
      }
      const failedAt = nowIso();
      db.prepare("UPDATE generate_tasks SET status = 'error', error = ?, updated_at = ?, completed_at = ?, last_error_at = ? WHERE id = ?")
        .run(errorMessage, failedAt, failedAt, failedAt, taskId);
    }
  } catch (e) {
    await quota.uncertain(taskId).catch(()=>{});
    const failedAt = nowIso();
    db.prepare("UPDATE generate_tasks SET status = 'error', error = ?, updated_at = ?, completed_at = ?, last_error_at = ? WHERE id = ?")
      .run('上游请求失败: ' + e.message, failedAt, failedAt, failedAt, taskId);
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

app.post('/api/edit', upload.single('image'), async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: '缺少 X-API-Key 请求头' });

  const row = await workbenchKey(req,res); if (!row) return;

  if (!req.file) return res.status(400).json({ error: '缺少参考图片' });
  const prompt = req.body.prompt;
  if (!prompt) return res.status(400).json({ error: '缺少 prompt 参数' });
  const isAutoSize = req.body.size === 'auto';
  const sizeError = isAutoSize ? null : validateSize(req.body.size);
  if (sizeError) return res.status(400).json({ error: sizeError });

  // Save image to disk for async processing
  const taskId = crypto.randomBytes(16).toString('hex');
  const filePath = path.join(dbDir, 'edit-' + taskId + '.bin');
  if (!await hold(row,1,taskId,res)) return;
  try {
  fs.writeFileSync(filePath, req.file.buffer);

  const requestData = {
    prompt,
    model: req.body.model || 'gpt-image-2',
    size: isAutoSize ? '' : (req.body.size || ''),
    quality: req.body.quality || '',
    output_format: req.body.output_format || '',
    background: req.body.background || '',
    response_format: req.body.response_format || 'b64_json',
    image_mimetype: req.file.mimetype,
    image_originalname: req.file.originalname || 'image.png',
    file_path: filePath
  };

  // Insert task (reuse task infra, request_json carries edit params)
  const now = nowIso();
  const expiresAt = new Date(Date.now() + TASK_TTL_MS).toISOString();
  db.prepare(`INSERT INTO generate_tasks (id, status, key_id, request_json, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(taskId, 'queued', row.id, JSON.stringify(requestData), now, now, expiresAt);

  } catch(e) { try { fs.unlinkSync(filePath); } catch {} await quota.settle(taskId,0,'failed','创建任务失败'); throw e; }
  // Launch async runner
  runEditTask(taskId, row.id, filePath).catch(err => {
    console.error('[EDIT] runner crashed:', err.message);
    try { fs.unlinkSync(filePath); } catch {}
  });

  res.status(202).json({ taskId });
});

// --- Admin API: Login ---
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== (process.env.ADMIN_PASSWORD || ADMIN_PASSWORD))
    return res.status(401).json({ error: '密码错误' });
  const token = jwt.sign({ role: 'admin', iat: Math.floor(Date.now() / 1000) }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// Admin middleware
app.use('/api/admin', (req, res, next) => {
  const user = authAdmin(req);
  if (!user) return res.status(401).json({ error: '未授权' });
  next();
});

// --- Admin API: List Keys ---
const quota = require('./api-distribution')(app, db, {
  siteKeys: { byKey: key => db.prepare('SELECT * FROM keys WHERE key=?').get(key), byId: id => db.prepare('SELECT * FROM keys WHERE id=?').get(id) },
  authAdmin, proxyRequest, validateSize,
  store: GITHUB_TOKEN ? require('./distribution-backup')({
    token: GITHUB_TOKEN, repo: GITHUB_REPO, branch: GITHUB_BRANCH,
    secret: process.env.DISTRIBUTION_BACKUP_SECRET
  }) : undefined,
  upstreamKey: () => process.env.UPSTREAM_API_KEY || UPSTREAM_KEY
});

app.get('/api/admin/keys', (req, res) => {
  const { page = 1, limit = 50, search = '' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  let where = '';
  const params = [];
  if (search) {
    where = 'WHERE name LIKE ? OR key LIKE ?';
    params.push(`%${search}%`, `%${search}%`);
  }
  const total = db.prepare(`SELECT COUNT(*) as c FROM keys ${where}`).get(...params).c;
  const rows = db.prepare(`SELECT * FROM keys ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, parseInt(limit), offset);
  res.json({ data: rows.map(keyToJSON), total, page: parseInt(page), limit: parseInt(limit) });
});

// --- Admin API: Create Key ---
app.post('/api/admin/keys', async (req, res) => {
  try {
    const { name, maxImages = -1, usedImages = 0, expiresAt = null, enabled = true, key: providedKey } = req.body;
    const id = uuidv4();
    const key = providedKey || generateKey();
    if (!/^sk-gi-[a-f0-9]{48}$/.test(key)) return res.status(400).json({ error: 'Key 格式无效' });
    const exists = db.prepare('SELECT * FROM keys WHERE key = ?').get(key);
    if (exists) return res.json(keyToJSON(exists));
    db.prepare(`INSERT INTO keys (id, key, name, max_images, used_images, expires_at, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, key, name || '', maxImages, usedImages, expiresAt, enabled ? 1 : 0);
    await persistKeysToGitHub();
    res.json(keyToJSON(db.prepare('SELECT * FROM keys WHERE id = ?').get(id)));
  } catch (e) {
    res.status(502).json({ error: e.message || 'GitHub 持久化失败' });
  }
});

// --- Admin API: Batch Create ---
app.post('/api/admin/keys/batch', async (req, res) => {
  try {
    const { count = 1, name, maxImages = -1, expiresAt = null } = req.body;
    const stmt = db.prepare(`INSERT INTO keys (id, key, name, max_images, expires_at) VALUES (?, ?, ?, ?, ?)`);
    const keys = [];
    for (let i = 0; i < Math.min(count, 100); i++) {
      const id = uuidv4();
      const key = generateKey();
      stmt.run(id, key, (name || '批量Key') + (count > 1 ? ` #${i + 1}` : ''), maxImages, expiresAt);
      keys.push(keyToJSON(db.prepare('SELECT * FROM keys WHERE id = ?').get(id)));
    }
    await persistKeysToGitHub();
    res.json({ data: keys, count: keys.length });
  } catch (e) {
    res.status(502).json({ error: e.message || 'GitHub 持久化失败' });
  }
});

// --- Admin API: Update Key ---
app.patch('/api/admin/keys/:id', async (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM keys WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Key 不存在' });
    const { name, maxImages, expiresAt, enabled, resetUsage, usedImages } = req.body;
    if (name !== undefined) db.prepare('UPDATE keys SET name = ? WHERE id = ?').run(name, req.params.id);
    if (maxImages !== undefined) db.prepare('UPDATE keys SET max_images = ? WHERE id = ?').run(maxImages, req.params.id);
    if (expiresAt !== undefined) db.prepare('UPDATE keys SET expires_at = ? WHERE id = ?').run(expiresAt, req.params.id);
    if (enabled !== undefined) db.prepare('UPDATE keys SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, req.params.id);
    if (resetUsage || usedImages !== undefined) await quota.resetSiteUsage(row.id,resetUsage ? 0 : usedImages);
    if (resetUsage) db.prepare('UPDATE keys SET used_images = 0 WHERE id = ?').run(req.params.id);
    else if (usedImages !== undefined) db.prepare('UPDATE keys SET used_images = ? WHERE id = ?').run(usedImages, req.params.id);
    await persistKeysToGitHub();
    res.json(keyToJSON(db.prepare('SELECT * FROM keys WHERE id = ?').get(req.params.id)));
  } catch (e) {
    res.status(502).json({ error: e.message || 'GitHub 持久化失败' });
  }
});

// --- Admin API: Delete Key ---
app.delete('/api/admin/keys/:id', async (req, res) => {
  try {
    const r = db.prepare('DELETE FROM keys WHERE id = ?').run(req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'Key 不存在' });
    await persistKeysToGitHub();
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message || 'GitHub 持久化失败' });
  }
});


// --- Admin API: Export Keys (backup) ---
app.get('/api/admin/keys/export', (req, res) => {
  const exportData = {
    exportedAt: new Date().toISOString(),
    keys: allKeysJSON()
  };
  res.setHeader('Content-Disposition', 'attachment; filename="keys-backup-' + new Date().toISOString().slice(0,10) + '.json"');
  res.json(exportData);
});

// --- Admin API: Import Keys (restore) ---
app.post('/api/admin/keys/import', (req, res) => {
  try {
    const { keys } = req.body;
    if (!Array.isArray(keys) || !keys.length) return res.status(400).json({ error: '缺少 keys 数组' });
    let imported = 0, skipped = 0;
    const stmt = db.prepare('INSERT OR IGNORE INTO keys (id, key, name, max_images, used_images, expires_at, created_at, enabled, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const k of keys) {
      if (!k.key || !/^sk-gi-[a-f0-9]{48}$/.test(k.key)) { skipped++; continue; }
      const r = stmt.run(k.id || uuidv4(), k.key, k.name || '', k.maxImages ?? -1, k.usedImages || 0, k.expiresAt || null, k.createdAt || new Date().toISOString(), k.enabled === false ? 0 : 1, k.lastUsedAt || null);
      if (r.changes) imported++; else skipped++;
    }
    persistKeysToGitHub().catch(err => console.error('[KEY BACKUP] 导入后同步GitHub失败:', err.message));
    res.json({ imported, skipped, total: imported + skipped });
  } catch (e) {
    res.status(502).json({ error: e.message || '导入失败' });
  }
});

// --- Admin API: Stats ---
app.get('/api/admin/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM keys').get().c;
  const active = db.prepare('SELECT COUNT(*) as c FROM keys WHERE enabled = 1').get().c;
  const expired = db.prepare("SELECT COUNT(*) as c FROM keys WHERE expires_at IS NOT NULL AND expires_at < ?").get(new Date().toISOString()).c;
  const balances = allKeysJSON();
  const totalUsed = balances.reduce((n,k)=>n+k.usedImages,0);
  const todayUsed = balances.filter(k=>k.lastUsedAt?.slice(0,10)===nowIso().slice(0,10)).reduce((n,k)=>n+k.usedImages,0);
  res.json({ totalKeys: total, activeKeys: active, expiredKeys: expired, totalImages: totalUsed, todayImages: todayUsed });
});

app.get('/api/version', (req, res) => {
  res.json({ version: '2026-11-17-shared-quota', commit: process.env.RENDER_GIT_COMMIT || null });
});

// --- User API: Key info ---
app.get('/api/key-info', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: '缺少 X-API-Key 请求头' });
  const row = await workbenchKey(req,res); if (!row) return;
  res.json(quota.view(row));
});

// --- Serve admin page ---
app.get('/imgadmin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --- Start ---
Promise.all([startup,quota.ready]).then(() => app.listen(PORT, '0.0.0.0', () => {
  console.log(`GPT-Image-2 Server running on http://0.0.0.0:${PORT}`);
  console.log(`  User UI:  http://localhost:${PORT}`);
  console.log(`  Admin UI: http://localhost:${PORT}/admin`);
})).catch(err=>{console.error('startup failed:',err.message);process.exit(1)});
