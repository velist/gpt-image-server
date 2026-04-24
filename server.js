const express = require('express');
const https = require('https');
const http = require('http');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const app = express();

// --- SQLite ---
const Database = require('better-sqlite3');
const dbDir = path.join(__dirname, 'data');
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
`);

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
  if (width < 1 || height < 1 || width > 4000 || height > 4000) return '宽高必须在 1-4000 像素之间';
  return null;
}

function validateApiKey(keyStr) {
  const row = db.prepare('SELECT * FROM keys WHERE key = ?').get(keyStr);
  if (!row) return { ok: false, error: '无效的 API Key' };
  if (!row.enabled) return { ok: false, error: 'API Key 已禁用' };
  if (row.expires_at && new Date(row.expires_at) < new Date())
    return { ok: false, error: 'API Key 已过期' };
  if (row.max_images > 0 && row.used_images >= row.max_images)
    return { ok: false, error: '生成额度已用尽' };
  return { ok: true, key: row };
}

function keyToJSON(row) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    maxImages: row.max_images,
    usedImages: row.used_images,
    remaining: row.max_images > 0 ? row.max_images - row.used_images : -1,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    enabled: !!row.enabled,
    lastUsedAt: row.last_used_at
  };
}

function allKeysJSON() {
  return db.prepare('SELECT * FROM keys ORDER BY created_at DESC').all().map(keyToJSON);
}

function restoreKeysFromBackupFile() {
  if (db.prepare('SELECT COUNT(*) as c FROM keys').get().c > 0) return;
  const backupPath = path.join(__dirname, KEY_BACKUP_PATH);
  if (!fs.existsSync(backupPath)) return;
  const keys = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  const stmt = db.prepare(`INSERT OR IGNORE INTO keys (id, key, name, max_images, used_images, expires_at, created_at, enabled, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const tx = db.transaction(items => {
    for (const k of items) {
      stmt.run(k.id || uuidv4(), k.key, k.name || '', k.maxImages ?? -1, k.usedImages || 0, k.expiresAt || null, k.createdAt || new Date().toISOString(), k.enabled === false ? 0 : 1, k.lastUsedAt || null);
    }
  });
  tx(keys);
  console.log(`Restored ${keys.length} keys from ${KEY_BACKUP_PATH}`);
}

async function updateGitHubKeyBackup() {
  if (!GITHUB_TOKEN) return;
  const content = JSON.stringify(allKeysJSON(), null, 2);
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${KEY_BACKUP_PATH}`;
  const headers = {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'gpt-image-server'
  };
  let sha;
  try {
    const current = await fetch(`${url}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers });
    if (current.ok) sha = (await current.json()).sha;
  } catch {}
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Backup image keys', branch: GITHUB_BRANCH, content: Buffer.from(content).toString('base64'), sha })
  });
  if (!res.ok) console.error('GitHub key backup failed:', await res.text());
}

let backupTimer;
function scheduleKeyBackup() {
  if (!GITHUB_TOKEN) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => updateGitHubKeyBackup().catch(err => console.error('GitHub key backup failed:', err)), 2000);
}

restoreKeysFromBackupFile();

// --- Middleware ---
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
    const req = mod.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Upstream timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// --- User API: Generate ---
app.post('/api/generate', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: '缺少 X-API-Key 请求头' });

  const v = validateApiKey(apiKey);
  if (!v.ok) return res.status(403).json({ error: v.error });

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: '缺少 prompt 参数' });
  const sizeError = validateSize(req.body.size);
  if (sizeError) return res.status(400).json({ error: sizeError });

  const body = { ...req.body };
  delete body.prompt;
  body.prompt = prompt;
  if (!body.model) body.model = 'gpt-image-2';
  if (!body.response_format) body.response_format = 'b64_json';

  try {
    const result = await proxyRequest('/images/generations', 'POST', {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (process.env.UPSTREAM_API_KEY || UPSTREAM_KEY)
    }, JSON.stringify(body));

    const contentType = result.headers['content-type'] || '';
    if (result.status === 200) {
      db.prepare("UPDATE keys SET used_images = used_images + 1, last_used_at = ? WHERE id = ?")
        .run(new Date().toISOString(), v.key.id);
      scheduleKeyBackup();
    }

    res.status(result.status);
    for (const [k, v2] of Object.entries(result.headers)) {
      if (!['transfer-encoding', 'content-length', 'connection'].includes(k.toLowerCase()))
        res.setHeader(k, v2);
    }
    res.send(result.body);
  } catch (e) {
    res.status(502).json({ error: '上游请求失败: ' + e.message });
  }
});

// --- User API: Edit ---
app.post('/api/edit', upload.single('image'), async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: '缺少 X-API-Key 请求头' });

  const v = validateApiKey(apiKey);
  if (!v.ok) return res.status(403).json({ error: v.error });

  if (!req.file) return res.status(400).json({ error: '缺少参考图片' });
  const prompt = req.body.prompt;
  if (!prompt) return res.status(400).json({ error: '缺少 prompt 参数' });
  const sizeError = validateSize(req.body.size);
  if (sizeError) return res.status(400).json({ error: sizeError });

  // Build multipart
  const boundary = '----FormBoundary' + crypto.randomBytes(16).toString('hex');
  const parts = [];

  const addField = (name, value) => {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  };
  const addFile = (name, filename, data, contentType) => {
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
    parts.push(Buffer.concat([Buffer.from(head), data, Buffer.from('\r\n')]));
  };

  addField('model', req.body.model || 'gpt-image-2');
  addField('prompt', prompt);
  addFile('image', req.file.originalname || 'image.png', req.file.buffer, req.file.mimetype);
  if (req.body.size) addField('size', req.body.size);
  if (req.body.quality) addField('quality', req.body.quality);
  if (req.body.output_format) addField('output_format', req.body.output_format);
  if (req.body.background) addField('background', req.body.background);
  if (req.body.response_format) addField('response_format', req.body.response_format);

  // Handle mask file if present
  if (req.body.mask_file) {
    // mask sent as separate field - not standard, skip
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const bodyBuf = Buffer.concat(parts);

  try {
    const result = await proxyRequest('/images/edits', 'POST', {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Authorization': 'Bearer ' + (process.env.UPSTREAM_API_KEY || UPSTREAM_KEY),
      'Content-Length': bodyBuf.length
    }, bodyBuf);

    if (result.status === 200) {
      db.prepare("UPDATE keys SET used_images = used_images + 1, last_used_at = ? WHERE id = ?")
        .run(new Date().toISOString(), v.key.id);
      scheduleKeyBackup();
    }

    res.status(result.status);
    for (const [k, v2] of Object.entries(result.headers)) {
      if (!['transfer-encoding', 'connection'].includes(k.toLowerCase()))
        res.setHeader(k, v2);
    }
    res.send(result.body);
  } catch (e) {
    res.status(502).json({ error: '上游请求失败: ' + e.message });
  }
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
app.post('/api/admin/keys', (req, res) => {
  const { name, maxImages = -1, usedImages = 0, expiresAt = null, enabled = true, key: providedKey } = req.body;
  const id = uuidv4();
  const key = providedKey || generateKey();
  if (!/^sk-gi-[a-f0-9]{48}$/.test(key)) return res.status(400).json({ error: 'Key 格式无效' });
  const exists = db.prepare('SELECT * FROM keys WHERE key = ?').get(key);
  if (exists) return res.json(keyToJSON(exists));
  db.prepare(`INSERT INTO keys (id, key, name, max_images, used_images, expires_at, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, key, name || '', maxImages, usedImages, expiresAt, enabled ? 1 : 0);
  scheduleKeyBackup();
  res.json(keyToJSON(db.prepare('SELECT * FROM keys WHERE id = ?').get(id)));
});

// --- Admin API: Batch Create ---
app.post('/api/admin/keys/batch', (req, res) => {
  const { count = 1, name, maxImages = -1, expiresAt = null } = req.body;
  const stmt = db.prepare(`INSERT INTO keys (id, key, name, max_images, expires_at) VALUES (?, ?, ?, ?, ?)`);
  const keys = [];
  for (let i = 0; i < Math.min(count, 100); i++) {
    const id = uuidv4();
    const key = generateKey();
    stmt.run(id, key, (name || '批量Key') + (count > 1 ? ` #${i + 1}` : ''), maxImages, expiresAt);
    keys.push(keyToJSON(db.prepare('SELECT * FROM keys WHERE id = ?').get(id)));
  }
  scheduleKeyBackup();
  res.json({ data: keys, count: keys.length });
});

// --- Admin API: Update Key ---
app.patch('/api/admin/keys/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM keys WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Key 不存在' });
  const { name, maxImages, expiresAt, enabled, resetUsage } = req.body;
  if (name !== undefined) db.prepare('UPDATE keys SET name = ? WHERE id = ?').run(name, req.params.id);
  if (maxImages !== undefined) db.prepare('UPDATE keys SET max_images = ? WHERE id = ?').run(maxImages, req.params.id);
  if (expiresAt !== undefined) db.prepare('UPDATE keys SET expires_at = ? WHERE id = ?').run(expiresAt, req.params.id);
  if (enabled !== undefined) db.prepare('UPDATE keys SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, req.params.id);
  if (resetUsage) db.prepare('UPDATE keys SET used_images = 0 WHERE id = ?').run(req.params.id);
  scheduleKeyBackup();
  res.json(keyToJSON(db.prepare('SELECT * FROM keys WHERE id = ?').get(req.params.id)));
});

// --- Admin API: Delete Key ---
app.delete('/api/admin/keys/:id', (req, res) => {
  const r = db.prepare('DELETE FROM keys WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Key 不存在' });
  scheduleKeyBackup();
  res.json({ ok: true });
});

// --- Admin API: Stats ---
app.get('/api/admin/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM keys').get().c;
  const active = db.prepare('SELECT COUNT(*) as c FROM keys WHERE enabled = 1').get().c;
  const expired = db.prepare("SELECT COUNT(*) as c FROM keys WHERE expires_at IS NOT NULL AND expires_at < ?").get(new Date().toISOString()).c;
  const totalUsed = db.prepare('SELECT COALESCE(SUM(used_images),0) as s FROM keys').get().s;
  const todayUsed = db.prepare("SELECT COALESCE(SUM(used_images),0) as s FROM keys WHERE date(last_used_at) = date(?)").get(new Date().toISOString()).s;
  res.json({ totalKeys: total, activeKeys: active, expiredKeys: expired, totalImages: totalUsed, todayImages: todayUsed });
});

// --- User API: Key info ---
app.get('/api/key-info', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: '缺少 X-API-Key 请求头' });
  const v = validateApiKey(apiKey);
  if (!v.ok) return res.status(403).json({ error: v.error });
  res.json(keyToJSON(v.key));
});

// --- Serve admin page ---
app.get('/imgadmin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --- Start ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`GPT-Image-2 Server running on http://0.0.0.0:${PORT}`);
  console.log(`  User UI:  http://localhost:${PORT}`);
  console.log(`  Admin UI: http://localhost:${PORT}/admin`);
});
