const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const install = require('../api-distribution');

test('distribution integration: credentials, limits, accounting, failures and isolation', async t => {
  const db = new Database(':memory:');
  const app = express();
  app.use(express.json());
  let upstreamCalls = 0;
  let respond = async body => ({ status: 200, body: Buffer.from(JSON.stringify({ data: Array.from({ length: body.n }, () => ({ b64_json: 'aW1hZ2U=' })) })) });
  install(app, db, {
    authAdmin: req => req.headers.authorization === 'Bearer admin-test' ? { role: 'admin' } : null,
    upstreamKey: () => 'private-upstream-test',
    validateSize: size => size && !/^\d+x\d+$/.test(size) ? '尺寸无效' : null,
    proxyRequest: async (path, method, headers, body) => {
      upstreamCalls++;
      assert.equal(headers.Authorization, 'Bearer private-upstream-test');
      assert.equal(path, '/images/generations');
      return respond(JSON.parse(body));
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.close(); db.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function call(path, key, method = 'GET', body) {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  }
  const admin = (path = '', method, body) => call('/api/admin/distribution' + path, 'admin-test', method, body);
  const create = async options => {
    const result = await admin('', 'POST', { name: '测试客户', maxImages: 3, ...options });
    assert.equal(result.status, 201);
    return result.data;
  };
  const generate = (key, n = 1, extra = {}) => call('/v1/images/generations', key, 'POST', { prompt: 'cat', n, ...extra });

  assert.equal((await call('/api/admin/distribution', 'invalid')).status, 401);
  assert.equal((await admin('', 'POST', { name: 'a', maxImages: -2 })).status, 400);
  assert.equal((await admin('', 'POST', { name: 'a', expiresAt: 'invalid' })).status, 400);
  const customer = await create();
  assert.equal(db.prepare('SELECT key_hash FROM distribution_keys').get().key_hash.includes(customer.key), false);
  assert.equal(JSON.stringify((await admin()).data).includes(customer.key), false);
  assert.equal((await generate('invalid')).status, 401);
  assert.equal((await generate('sk-gi-' + 'a'.repeat(48))).status, 401);
  for (const n of [0, -1, 1.2, '2', 11, null]) assert.equal((await generate(customer.key, n)).status, 400);
  assert.equal((await generate(customer.key, 1, { model: 'other' })).status, 400);
  assert.equal(upstreamCalls, 0);
  assert.equal((await generate(customer.key, 2)).status, 200);
  assert.equal((await generate(customer.key, 2)).status, 429);
  let usage = (await call('/v1/usage', customer.key)).data;
  assert.equal(usage.usedImages, 2); assert.equal(usage.remaining, 1); assert.equal(usage.reservedImages, 0);
  assert.equal((await admin('/' + customer.id, 'PATCH', { maxImages: 1 })).status, 400);
  assert.equal((await admin('/' + customer.id, 'PATCH', { maxImages: 5 })).status, 200);
  await admin('/' + customer.id, 'PATCH', { enabled: false });
  assert.equal((await generate(customer.key)).status, 403);
  await admin('/' + customer.id, 'PATCH', { enabled: true, expiresAt: '2000-01-01T00:00:00Z' });
  assert.equal((await generate(customer.key)).status, 403);
  await admin('/' + customer.id, 'PATCH', { expiresAt: null });

  const parallel = await create({ maxImages: 2, maxConcurrent: 2 });
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  respond = body => new Promise(resolve => { release = () => resolve({ status: 200, body: Buffer.from(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] })) }); entered(); });
  const first = generate(parallel.key, 2);
  await started;
  assert.equal((await generate(parallel.key)).status, 429);
  release(); assert.equal((await first).status, 200);
  usage = (await call('/v1/usage', parallel.key)).data;
  assert.equal(usage.usedImages, 1); assert.equal(usage.remaining, 1);

  const capped = await create({ maxImages: -1, maxConcurrent: 1 });
  let enteredAgain;
  const startedAgain = new Promise(resolve => { enteredAgain = resolve; });
  respond = () => new Promise(resolve => { release = () => resolve({ status: 400, body: Buffer.from('{}') }); enteredAgain(); });
  const running = generate(capped.key);
  await startedAgain;
  assert.equal((await generate(capped.key)).status, 429);
  release(); assert.equal((await running).status, 502);
  usage = (await call('/v1/usage', capped.key)).data;
  assert.equal(usage.usedImages, 0); assert.equal(usage.reservedImages, 0);

  respond = async () => { throw new Error('network timeout secret'); };
  const failed = await generate(customer.key);
  assert.equal(failed.status, 502);
  assert.equal(JSON.stringify(failed).includes('secret'), false);
  let logs = (await admin('/' + customer.id + '/requests')).data.data;
  const uncertain = logs.find(r => r.status === 'uncertain');
  assert.ok(uncertain);
  usage = (await call('/v1/usage', customer.key)).data;
  assert.equal(usage.reservedImages, 1);
  assert.equal((await admin(`/${parallel.id}/requests/${uncertain.id}/settle`, 'POST', { charged: 0 })).status, 404);
  assert.equal((await admin(`/${customer.id}/requests/${uncertain.id}/settle`, 'POST', { charged: 2 })).status, 400);
  assert.equal((await admin(`/${customer.id}/requests/${uncertain.id}/settle`, 'POST', { charged: 0 })).status, 200);
  assert.equal((await admin(`/${customer.id}/requests/${uncertain.id}/settle`, 'POST', { charged: 0 })).status, 409);
  assert.equal((await call('/v1/usage', customer.key)).data.reservedImages, 0);
  assert.equal((await generate((await create({ maxImages: 0 })).key)).status, 429);

  // Install again to simulate a restart while an upstream request was in flight.
  db.prepare("INSERT INTO distribution_requests(id,key_id,requested,status,created_at) VALUES('restart',?,1,'pending',?)").run(customer.id, new Date().toISOString());
  db.prepare('UPDATE distribution_keys SET reserved_images=reserved_images+1 WHERE id=?').run(customer.id);
  install(express(), db, {});
  assert.equal(db.prepare("SELECT status FROM distribution_requests WHERE id='restart'").get().status, 'uncertain');
  assert.equal((await call('/v1/usage', customer.key)).data.reservedImages, 1);
});
