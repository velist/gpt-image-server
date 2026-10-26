const crypto = require('crypto');
const zlib = require('zlib');

// The repository may be public. Encrypt customer names, quotas and request history.
module.exports = function githubDistributionBackup({ token, repo, branch, secret, fetchImpl = fetch }) {
  const file = 'data/distribution-backup.json';
  const url = `https://api.github.com/repos/${repo}/contents/${file}`;
  let sha;
  const key = secret && crypto.createHash('sha256').update(secret).digest();
  async function api(method, suffix = '', body) {
    if (!token || !key) throw new Error('API 分发持久化配置缺失');
    const response = await fetchImpl(url + suffix, {
      method, headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'gpt-image-distribution' },
      body: body && JSON.stringify(body), signal: AbortSignal.timeout(20000)
    });
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) {
      const error = new Error('GitHub 持久化请求失败 HTTP ' + response.status);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  return {
    async load() {
      const result = await api('GET', '?ref=' + encodeURIComponent(branch));
      if (!result) { sha = undefined; return null; }
      sha = result.sha;
      const envelope = JSON.parse(Buffer.from(result.content, 'base64').toString('utf8'));
      if (envelope.version !== 1) throw new Error('不支持的分发备份版本');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
      return JSON.parse((envelope.compression === 'gzip' ? zlib.gunzipSync(plaintext) : plaintext).toString('utf8'));
    },
    async save(snapshot) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(zlib.gzipSync(JSON.stringify(snapshot))), cipher.final()]);
      const envelope = JSON.stringify({ version: 1, compression: 'gzip', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
      const body = {
        message: 'Persist encrypted API distribution state [skip ci] [skip render]', branch,
        content: Buffer.from(envelope).toString('base64'), ...(sha ? { sha } : {})
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await api('PUT', '', body);
          sha = result.content.sha;
          return;
        } catch (error) {
          if (![409, 422].includes(error.status) || attempt === 2) throw error;
          const current = await api('GET', '?ref=' + encodeURIComponent(branch));
          if (current?.sha !== sha) throw new Error('远程分发数据已变化，暂停写入以避免覆盖');
        }
      }
    }
  };
};
