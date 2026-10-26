const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const install = require('../api-distribution');
const githubBackup = require('../distribution-backup');

test('encrypted backup round trip, conflicts, invalid secret and outage', async () => {
  let file;
  let conflict = false;
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET') return { status: file ? 200 : 404, ok: !!file, json: async () => file };
    const body = JSON.parse(options.body);
    if (conflict) { conflict = false; return { status: 409, ok: false }; }
    assert.equal(body.sha, file?.sha);
    assert.ok(body.message.includes('[skip render]'));
    file = { sha: String(Number(file?.sha || 0) + 1), content: body.content };
    return { status: 200, ok: true, json: async () => ({ content: { sha: file.sha } }) };
  };
  const config = { token: 'mock', repo: 'mock/repo', branch: 'master', secret: 'test-only-secret', fetchImpl };
  const store = githubBackup(config);
  assert.equal(await store.load(), null);
  const state = { version: 1, keys: [{ name: 'private customer', used_images: 5 }], requests: [] };
  await store.save(state);
  assert.equal(Buffer.from(file.content, 'base64').toString().includes('private customer'), false);
  const restored = githubBackup(config);
  assert.deepEqual(await restored.load(), state);
  conflict = true;
  await restored.save({ ...state, requests: [{ id: 'new' }] });
  assert.equal((await githubBackup(config).load()).requests.length, 1);
  await assert.rejects(githubBackup({ ...config, secret: 'wrong' }).load());
  await assert.rejects(githubBackup({ ...config, fetchImpl: async () => ({ status: 503, ok: false }) }).load());
});

test('persist before dispatch; recover quotas on empty disk; fail closed on backup errors', async t => {
  let remote = null;
  let failSave = false;
  let upstreamCalls = 0;
  const store = {
    async load() { return structuredClone(remote); },
    async save(data) { if (failSave) throw new Error('simulated persistence outage'); remote = structuredClone(data); }
  };
  const servers = [], databases = [];
  t.after(() => { servers.forEach(s => s.close()); databases.forEach(d => d.close()); });
  async function start() {
    const db = new Database(':memory:'); databases.push(db);
    const app = express(); app.use(express.json());
    const { ready } = install(app, db, { store, authAdmin: () => ({ role: 'admin' }), validateSize: () => null, upstreamKey: () => 'test',
      proxyRequest: async () => {
        upstreamCalls++;
        assert.equal(remote.requests.filter(r => r.status === 'pending').length, 1);
        assert.equal(remote.keys[0].reserved_images, 1);
        return { status: 200, body: Buffer.from('{"data":[{"b64_json":"image"}]}') };
      }
    });
    await ready;
    const server = app.listen(0, '127.0.0.1'); servers.push(server);
    await new Promise(resolve => server.once('listening', resolve));
    return async (path, body, key = '') => {
      const res = await fetch('http://127.0.0.1:' + server.address().port + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: body && JSON.stringify(body) });
      return { status: res.status, data: await res.json() };
    };
  }
  const first = await start();
  const created = await first('/api/admin/distribution', { name: 'durable client', maxImages: 3 });
  assert.equal(created.status, 201);
  assert.equal(remote.keys.length, 1);
  assert.equal((await first('/v1/images/generations', { prompt: 'cat' }, created.data.key)).status, 200);
  assert.equal(remote.keys[0].used_images, 1);
  assert.equal(remote.keys[0].reserved_images, 0);
  const second = await start();
  assert.equal((await second('/v1/usage', null, created.data.key)).data.usedImages, 1);
  failSave = true;
  assert.equal((await second('/v1/images/generations', { prompt: 'cat' }, created.data.key)).status, 503);
  assert.equal(upstreamCalls, 1);
  assert.equal((await second('/v1/usage', null, created.data.key)).status, 503);
  failSave = false;
  const third = await start();
  assert.equal((await third('/v1/usage', null, created.data.key)).data.reservedImages, 0);
  assert.equal((await third('/v1/usage', null, created.data.key)).data.usedImages, 1);
});
