import test from 'node:test';
import assert from 'node:assert/strict';
import { runProbe } from './probe.js';

const env = { IMOBIBRASIL_BUILD_PROBE: 'true', IMOBIBRASIL_USERNAME: 'synthetic-user',
  IMOBIBRASIL_PASSWORD: 'synthetic-password', IMOBIBRASIL_USER_FIELD: 'login',
  IMOBIBRASIL_PASSWORD_FIELD: 'password', IMOBIBRASIL_LOGIN_ENCODING: 'json' };

test('build probe is disabled unless explicitly configured', async () => {
  assert.equal((await runProbe({}, () => assert.fail('unexpected network'))).skipped, true);
});

test('probe makes one login and one spaced GET, never returns secret values', async () => {
  const calls = [];
  let waited = 0;
  const result = await runProbe(env, async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'error');
    return Response.json(calls.length === 1 ? { data: { token: 'synthetic-token', password: 'sensitive' } } :
      { status: true, data: { statusConta: 'ativo', website: 'www.godoyimoveispiracaia.com.br', owner: 'private-name' } });
  }, async ms => { waited += ms; });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(waited, 6100);
  assert.equal(result.tokenPointer, '/data/token');
  assert.equal(result.accountDomainMatch, true);
  assert.doesNotMatch(JSON.stringify(result), /synthetic|sensitive|private-name|password/);
});

test('probe stops at credential rejection and does not expose error body', async () => {
  let count = 0;
  const result = await runProbe(env, async () => {
    count++;
    return new Response('sensitive error', { status: 401 });
  });
  assert.equal(count, 1);
  assert.equal(result.loginHttpStatus, 401);
  assert.doesNotMatch(JSON.stringify(result), /sensitive/);
});

test('ambiguous tokens prevent any subsequent account request', async () => {
  let count = 0;
  const result = await runProbe(env, async () => {
    count++;
    return Response.json({ token: 'fake-one', data: { token: 'fake-two' } });
  });
  assert.equal(count, 1);
  assert.equal(result.tokenCandidateCount, 2);
});
