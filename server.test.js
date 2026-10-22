import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp, configuration } from './server.js';

// Synthetic fields and credentials, unrelated to the real API contract.
const synthetic = {
  ADMIN_API_KEY: 'synthetic-admin-key-for-testing-only-0000',
  IMOBIBRASIL_USERNAME: 'synthetic-user', IMOBIBRASIL_PASSWORD: 'synthetic-password',
  IMOBIBRASIL_USER_FIELD: 'testUser', IMOBIBRASIL_PASSWORD_FIELD: 'testPassword',
  IMOBIBRASIL_LOGIN_ENCODING: 'json', IMOBIBRASIL_TOKEN_POINTER: '/result/testToken',
  IMOBIBRASIL_STATUS_POINTER: '/result/testActive', IMOBIBRASIL_STATUS_EXPECTED_JSON: 'true',
  IMOBIBRASIL_ENABLED: 'true', IMOBIBRASIL_CONTRACT_CONFIRMED: 'true',
};
const auth = { Authorization: `Bearer ${synthetic.ADMIN_API_KEY}` };
async function launch(t, options) {
  const server = createApp(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return (path, opts) => fetch(`http://127.0.0.1:${server.address().port}${path}`, opts);
}

test('health does not imply API readiness; admin fails closed without key', async t => {
  const request = await launch(t, { env: {}, fetcher: () => assert.fail('unexpected upstream request') });
  assert.equal((await request('/healthz')).status, 200);
  assert.equal((await request('/v1/status')).status, 503);
  assert.equal((await request('/v1/validate', { method: 'POST' })).status, 503);
});

test('unauthorized and disabled requests never contact the upstream', async t => {
  const request = await launch(t, { env: { ...synthetic, IMOBIBRASIL_ENABLED: 'false' }, fetcher: () => assert.fail('unexpected upstream request') });
  assert.equal((await request('/v1/status')).status, 401);
  assert.equal((await request('/v1/validate', { method: 'POST', headers: auth })).status, 503);
  const status = await (await request('/v1/status', { headers: auth })).json();
  assert.equal(status.enabled, false);
  assert.equal(status.automaticSync, false);
});

test('unconfirmed and incomplete contracts remain blocked', async t => {
  const request = await launch(t, { env: { ...synthetic, IMOBIBRASIL_CONTRACT_CONFIRMED: 'false' }, fetcher: () => assert.fail('unexpected upstream request') });
  assert.equal((await request('/v1/validate', { method: 'POST', headers: auth })).status, 503);
  assert.equal(configuration({ ...synthetic, IMOBIBRASIL_TOKEN_POINTER: '' }).ready, false);
  assert.equal(configuration({ ...synthetic, IMOBIBRASIL_USER_FIELD: 'origin' }).ready, false);
});

test('validation spaces requests, uses fixed hosts, returns only sanitized results', async t => {
  const calls = [];
  let clock = 1000000;
  const request = await launch(t, { env: synthetic, now: () => clock, sleep: async ms => { clock += ms; }, fetcher: async (url, opts) => {
    calls.push({ url, opts, clock });
    return Response.json(calls.length === 1 ? { result: { testToken: 'synthetic-token' } } : { result: { testActive: true }, privateData: 'do-not-expose' });
  } });
  const response = await request('/v1/validate', { method: 'POST', headers: auth });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'https://api1.imobibrasil.app/v1/app/account/login');
  assert.equal(calls[1].url, 'https://api2.imobibrasil.app/v1/app/account/status');
  assert.equal(calls[1].opts.method, 'GET');
  assert.equal(calls[0].opts.redirect, 'error');
  assert.ok(calls[1].clock - calls[0].clock >= 6100);
  assert.deepEqual(JSON.parse(calls[0].opts.body), { testUser: 'synthetic-user', testPassword: 'synthetic-password', manterLogin: true, origin: 'API' });
  assert.equal(calls[1].opts.headers['X-Authorization'], 'Bearer synthetic-token');
  assert.doesNotMatch(JSON.stringify(result), /synthetic|do-not-expose/);
});

test('HTTP 200 with inactive JSON is a validation failure', async t => {
  let count = 0;
  const request = await launch(t, { env: synthetic, sleep: async () => {}, fetcher: async () => Response.json(++count === 1 ? { result: { testToken: 'test-token' } } : { result: { testActive: false } }) });
  const response = await request('/v1/validate', { method: 'POST', headers: auth });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).ok, false);
});

test('401 stops further logins without automatic retries', async t => {
  let count = 0;
  const request = await launch(t, { env: synthetic, fetcher: async () => { count++; return new Response('sensitive error body', { status: 401 }); } });
  assert.equal((await request('/v1/validate', { method: 'POST', headers: auth })).status, 502);
  assert.equal((await request('/v1/validate', { method: 'POST', headers: auth })).status, 503);
  assert.equal(count, 1);
});

test('429 preserves Retry-After and suppresses retries', async t => {
  let count = 0;
  const request = await launch(t, { env: synthetic, now: () => 1000, sleep: async () => {}, fetcher: async () => { count++; return new Response('', { status: 429, headers: { 'Retry-After': '120' } }); } });
  assert.equal((await request('/v1/validate', { method: 'POST', headers: auth })).status, 502);
  assert.equal((await request('/v1/validate', { method: 'POST', headers: auth })).status, 429);
  assert.equal(count, 1);
});
