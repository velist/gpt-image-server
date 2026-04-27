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

const TASK_TTL_MS = 60 * 60 * 1000;
const TERMINAL_TASK_RETENTION_MS = 24 * 60 * 60 * 1000;

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

function createGenerateTask(keyId, body) {
  const id = crypto.randomBytes(16).toString('hex');
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
    try {
      const req = row.request_json ? JSON.parse(row.request_json) : null;
      if (req && req.file_path && fs.existsSync(req.file_path)) {
        // Edit task - launch via edit runner
        runEditTask(row.id, row.key_id, req.file_path);
      } else {
        runGenerateTask(row.id, row.key_id, req || {});
      }
    } catch (err) {
      const now = nowIso();
      db.prepare("UPDATE generate_tasks SET status = 'error', error = ?, updated_at = ?, completed_at = ?, last_error_at = ? WHERE id = ?")
        .run('恢复任务失败: ' + err.message, now, now, now, row.id);
    }
  }
}

const finishGenerateTaskSuccess = db.transaction((taskId, keyId, resultJson) => {
  const now = nowIso();
  db.prepare("UPDATE generate_tasks SET status = 'done', result_json = ?, error = NULL, updated_at = ?, completed_at = ? WHERE id = ?")
    .run(resultJson, now, now, taskId);
  db.prepare("UPDATE keys SET used_images = used_images + 1, last_used_at = ? WHERE id = ?")
    .run(now, keyId);
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
  const backupPath = path.join(__dirname, KEY_BACKUP_PATH);
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

async function restoreKeysFromBackupFile() {
  const backupPath = path.join(__dirname, KEY_BACKUP_PATH);
  try {
    const remote = await fetchGitHubKeyBackup();
    if (remote && Array.isArray(remote.keys)) {
      replaceKeysFromBackup(remote.keys);
      writeLocalKeyBackup(remote.content);
      console.log(`Restored ${remote.keys.length} keys from GitHub backup`);
      return;
    }
  } catch (err) {
    console.error('GitHub key restore failed:', err.message);
  }
  if (!fs.existsSync(backupPath)) return;
  const keys = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  replaceKeysFromBackup(Array.isArray(keys) ? keys : []);
  console.log(`Restored ${Array.isArray(keys) ? keys.length : 0} keys from local backup`);
}

async function updateGitHubKeyBackup() {
  const keyContent = JSON.stringify(allKeysJSON(), null, 2);
  // Always save local backup first
  writeLocalKeyBackup(keyContent);

  if (!GITHUB_TOKEN || !gitHubTokenValid) {
    console.warn('[KEY BACKUP] GitHub 不可用，仅保存了本地备份。重启/重新部署后可能丢失！');
    return false;
  }

  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${KEY_BACKUP_PATH}`;
    const headers = {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'gpt-image-server'
    };
    let sha;
    const current = await fetch(`${url}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers });
    if (current.ok) sha = (await current.json()).sha;
    else if (current.status === 401) { gitHubTokenValid = false; throw new Error('GITHUB_TOKEN 已失效，请更新 Token！'); }
    else if (current.status !== 404) throw new Error(`GitHub 读取当前备份失败: HTTP ${current.status}`);
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Backup image keys', branch: GITHUB_BRANCH, content: Buffer.from(keyContent).toString('base64'), sha })
    });
    if (!res.ok) {
      if (res.status === 401) { gitHubTokenValid = false; throw new Error('GITHUB_TOKEN 已失效，请更新 Token！'); }
      throw new Error(`GitHub 写入备份失败: HTTP ${res.status}`);
    }
    console.log('[KEY BACKUP] GitHub 备份成功');
    return true;
  } catch (err) {
    console.error('[KEY BACKUP] GitHub 同步失败:', err.message);
    console.error('[KEY BACKUP] Key 数据仅保存在本地，重新部署后会丢失！');
    return false;
  }
}

async function persistKeysToGitHub() {
  return updateGitHubKeyBackup();
}

let backupTimer;
function scheduleKeyBackup() {
  if (!GITHUB_TOKEN) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => persistKeysToGitHub().catch(err => console.error('GitHub key backup failed:', err.message)), 2000);
}

function startPeriodicKeyBackup() {
  if (!GITHUB_TOKEN) {
    console.log('GitHub key backup disabled: GITHUB_TOKEN is not set');
    return;
  }
  setTimeout(() => scheduleKeyBackup(), 10000);
  setInterval(() => scheduleKeyBackup(), 5 * 60 * 1000);
}

(async () => {
  gitHubTokenValid = await verifyGitHubToken();
  await restoreKeysFromBackupFile();
  startPeriodicKeyBackup();
  startTaskCleanupLoop();
  await recoverPendingTasksOnStartup();
})().catch(err => console.error('Startup initialization failed:', err));

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
async function runGenerateTask(taskId, keyId, body) {
  const task = getGenerateTask(taskId);
  if (!task) return;
  const now = nowIso();
  if (new Date(task.expires_at) <= new Date()) {
    db.prepare("UPDATE generate_tasks SET status = 'expired', error = COALESCE(error, '任务已过期'), updated_at = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?")
      .run(now, now, taskId);
    return;
  }

  db.prepare("UPDATE generate_tasks SET status = 'running', error = NULL, updated_at = ?, started_at = COALESCE(started_at, ?), attempt_count = attempt_count + 1 WHERE id = ?")
    .run(now, now, taskId);

  try {
    console.log(`[GENERATE] task=${taskId} n=${body.n||1} size=${body.size||'default'} model=${body.model||'default'}`);
    const result = await proxyRequest('/images/generations', 'POST', {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (process.env.UPSTREAM_API_KEY || UPSTREAM_KEY)
    }, JSON.stringify(body));

    if (result.status === 200) {
      const responseBody = result.body.toString('utf8');
      const parsed = JSON.parse(responseBody);
      console.log(`[GENERATE] task=${taskId} success, upstream returned ${(parsed.data||[]).length} images`);
      finishGenerateTaskSuccess(taskId, keyId, responseBody);
      await persistKeysToGitHub().catch(err => console.error('GitHub key backup failed:', err.message));
    } else {
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
    const failedAt = nowIso();
    db.prepare("UPDATE generate_tasks SET status = 'error', error = ?, updated_at = ?, completed_at = ?, last_error_at = ? WHERE id = ?")
      .run('上游请求失败: ' + e.message, failedAt, failedAt, failedAt, taskId);
  }
}

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

  const taskId = createGenerateTask(v.key.id, body);
  runGenerateTask(taskId, v.key.id, body);
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
    "SELECT gt.id, gt.status, gt.created_at, gt.completed_at, gt.result_json IS NOT NULL as has_result FROM generate_tasks gt JOIN keys k ON gt.key_id = k.id WHERE k.key LIKE ? ORDER BY gt.created_at DESC LIMIT 20"
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
    try { fs.unlinkSync(filePath); } catch {}
    db.prepare("UPDATE generate_tasks SET status = 'error', error = ?, updated_at = ?, completed_at = ?, last_error_at = ? WHERE id = ?")
      .run('读取临时文件失败: ' + e.message, now, now, now, taskId);
    return;
  }

  try {
    console.log(`[EDIT] task=${taskId} prompt=${(JSON.parse(task.request_json).prompt||'').slice(0,60)}`);
    const result = await proxyRequest('/images/edits', 'POST', {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Authorization': 'Bearer ' + (process.env.UPSTREAM_API_KEY || UPSTREAM_KEY)
    }, bodyBuf);

    if (result.status === 200) {
      const responseBody = result.body.toString('utf8');
      try {
        const parsed = JSON.parse(responseBody);
        console.log(`[EDIT] task=${taskId} success, upstream returned ${(parsed.data||[]).length} images`);
      } catch {}
      finishGenerateTaskSuccess(taskId, keyId, responseBody);
      // finishGenerateTaskSuccess already bumps used_images, just need GitHub persist
      await persistKeysToGitHub().catch(err => console.error('GitHub key backup failed:', err.message));
    } else {
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

  const v = validateApiKey(apiKey);
  if (!v.ok) return res.status(403).json({ error: v.error });

  if (!req.file) return res.status(400).json({ error: '缺少参考图片' });
  const prompt = req.body.prompt;
  if (!prompt) return res.status(400).json({ error: '缺少 prompt 参数' });
  const isAutoSize = req.body.size === 'auto';
  const sizeError = isAutoSize ? null : validateSize(req.body.size);
  if (sizeError) return res.status(400).json({ error: sizeError });

  // Save image to disk for async processing
  const taskId = crypto.randomBytes(16).toString('hex');
  const filePath = path.join(__dirname, 'data', 'edit-' + taskId + '.bin');
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
    .run(taskId, 'queued', v.key.id, JSON.stringify(requestData), now, now, expiresAt);

  // Launch async runner
  runEditTask(taskId, v.key.id, filePath).catch(err => {
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
    const { name, maxImages, expiresAt, enabled, resetUsage } = req.body;
    if (name !== undefined) db.prepare('UPDATE keys SET name = ? WHERE id = ?').run(name, req.params.id);
    if (maxImages !== undefined) db.prepare('UPDATE keys SET max_images = ? WHERE id = ?').run(maxImages, req.params.id);
    if (expiresAt !== undefined) db.prepare('UPDATE keys SET expires_at = ? WHERE id = ?').run(expiresAt, req.params.id);
    if (enabled !== undefined) db.prepare('UPDATE keys SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, req.params.id);
    if (resetUsage) db.prepare('UPDATE keys SET used_images = 0 WHERE id = ?').run(req.params.id);
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
