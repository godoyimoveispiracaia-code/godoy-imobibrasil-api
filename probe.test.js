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

test('provider failure in HTTP 200 stops and classifies without exposing message', async () => {
  let count = 0;
  const result = await runProbe(env, async () => {
    count++;
    return Response.json({ status: false, message: 'Login ou senha incorretos para synthetic-user', token: 'must-not-use' });
  });
  assert.equal(count, 1);
  assert.equal(result.loginSummary.explicitFailure, true);
  assert.equal(result.loginSummary.errorClass, 'credentials_rejected');
  assert.doesNotMatch(JSON.stringify(result), /synthetic|incorretos|must-not-use/);
});

test('discovers access token within additional known response containers', async () => {
  let count = 0;
  const result = await runProbe(env, async () => Response.json(++count === 1 ?
    { retorno: { dados: { jwt: 'private-access-token' } } } : { statusConta: true }), async () => {});
  assert.equal(result.tokenPointer, '/retorno/dados/jwt');
  assert.equal(count, 2);
  assert.doesNotMatch(JSON.stringify(result), /private-access-token/);
});

test('dynamic schema keys are redacted and prevent use of token', async () => {
  let count = 0;
  const result = await runProbe(env, async () => {
    count++;
    return Response.json({ private_customer_name: { token: 'fake-token' } });
  });
  assert.equal(count, 1);
  assert.equal(result.tokenPathRedacted, true);
  assert.doesNotMatch(JSON.stringify(result), /private_customer_name|fake-token/);
});
