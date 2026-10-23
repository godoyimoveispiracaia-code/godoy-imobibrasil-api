import test from 'node:test';
import assert from 'node:assert/strict';
import { runReadProbe } from './read-probe.js';

const env = { IMOBIBRASIL_READ_PROBE: 'true', IMOBIBRASIL_BUILD_PROBE: 'false',
  IMOBIBRASIL_ENABLED: 'false', IMOBIBRASIL_CONTRACT_CONFIRMED: 'false',
  IMOBIBRASIL_USERNAME: 'synthetic-user', IMOBIBRASIL_PASSWORD: 'synthetic-password',
  IMOBIBRASIL_USER_FIELD: 'login', IMOBIBRASIL_PASSWORD_FIELD: 'password', IMOBIBRASIL_LOGIN_ENCODING: 'json' };
const list = data => ({ status: true, resultSet: { page: 1, per_page: 1, total_pages: 1, total_items: data.length, data } });
const normal = path => {
  if (path === 'account/login') return { status: true, resultSet: { token: 'synthetic-token', created_in: 100, expires_in: 2592100, user: { site: 'https://www.godoyimoveispiracaia.com.br' } } };
  if (path === 'account/perfil') return { status: true, resultSet: { nome: 'Godoy Imóveis Piracaia', statusConta: false } };
  if (path === 'account/permissao') return { status: true, resultSet: { permissoes: {} } };
  if (path.startsWith('imovel/lista')) return list([{ codigoImovel: 4306887, referenciaImovel: '369041' }]);
  if (path.startsWith('pessoa/lista')) return list([{ codigoPessoa: 111, nomeResponsavel: 'private-person', cpf: 'private-document' }]);
  if (path.startsWith('mensagem/lista')) return list([{ codigoMensagem: 222, assunto: 'private-message' }]);
  if (path.startsWith('lead/lista')) return list([{ codigoLead: 333, nome: 'private-lead' }]);
  if (path.startsWith('negocio/lista')) return list([]);
  assert.fail('unexpected route');
};
test('read diagnostic disabled by default and rejects active integration configuration', async () => {
  assert.equal((await runReadProbe({}, () => assert.fail())).skipped, true);
  assert.equal((await runReadProbe({ ...env, IMOBIBRASIL_ENABLED: 'true' }, () => assert.fail())).error, 'unsafe_or_incomplete_configuration');
});
test('validates documented CRM reads despite statusConta=false, with no writes or PII', async () => {
  const calls = [], waits = [], logs = [];
  const result = await runReadProbe(env, async (url, options) => {
    const path = url.split('/v1/app/')[1]; calls.push({ path, options });
    assert.equal(options.redirect, 'error');
    if (calls.length > 1) {
      assert.equal(options.method, 'GET');
      assert.equal(options.headers['X-Authorization'], 'Bearer synthetic-token');
      assert.equal(options.body, undefined);
    } else assert.deepEqual(JSON.parse(options.body), { login: 'synthetic-user', password: 'synthetic-password', manterLogin: true, origin: 'API' });
    return Response.json(normal(path));
  }, async ms => waits.push(ms), value => logs.push(value));
  assert.equal(result.identityVerified, true);
  assert.equal(result.requestCount, 8);
  assert.equal(waits.length, 7);
  assert.ok(waits.every(ms => ms === 6100));
  assert.equal(result.loginSiteMatches, true);
  assert.equal(result.tokenLifetimeSeconds, 2592000);
  assert.ok(calls.some(c => c.path === 'pessoa/lista?page=1&per_page=1&tipoCadastro=cliente'));
  assert.ok(calls.some(c => c.path === 'imovel/lista?page=1&per_page=1&referenciaImovel=369041'));
  assert.ok(calls.some(c => c.path === 'negocio/lista?page=1&per_page=1'));
  assert.equal(calls.some(c => /account\/status|corretor\/|cliente\//.test(c.path)), false);
  assert.equal(result.checks.find(c => c.name === 'deals').sampleCount, 0);
  assert.equal(result.writes, 0);
  assert.doesNotMatch(JSON.stringify([result, logs]), /synthetic|private-person|private-message|private-document|private-lead/);
});
test('wrong property ID or reference prevents private CRM reads', async () => {
  let calls = 0;
  const result = await runReadProbe(env, async url => {
    calls++;
    const path = url.split('/v1/app/')[1];
    return Response.json(path.startsWith('imovel/lista') ? list([{ codigoImovel: 4306887, referenciaImovel: 'wrong' }]) : normal(path));
  }, async () => {});
  assert.equal(calls, 3);
  assert.equal(result.identityVerified, false);
});
test('HTTP 401 and 429 stop remaining reads, without exposing provider errors', async () => {
  for (const status of [401, 429]) {
    let calls = 0;
    const result = await runReadProbe(env, async url => {
      calls++;
      const path = url.split('/v1/app/')[1];
      return path.startsWith('pessoa/lista') ? new Response('private-provider-error', { status, headers: { 'Retry-After': '60' } }) : Response.json(normal(path));
    }, async () => {});
    assert.equal(calls, 5);
    assert.equal(result.checks.at(-1).httpStatus, status);
    assert.doesNotMatch(JSON.stringify(result), /private-provider-error/);
  }
});
test('provider failure in HTTP 200 stops subsequent reads', async () => {
  let calls = 0;
  const result = await runReadProbe(env, async url => {
    calls++;
    const path = url.split('/v1/app/')[1];
    return Response.json(path.startsWith('pessoa/lista') ? { status: false, message: 'private-error' } : normal(path));
  }, async () => {});
  assert.equal(calls, 5);
  assert.equal(result.checks.at(-1).readAccepted, false);
});
test('incorrect login tenant stops before all subsequent requests', async () => {
  for (const site of ['https://other.example.com', 'https://godoyimoveispiracaia.com.br.other.example.com']) {
    let calls = 0;
    const result = await runReadProbe(env, async () => {
      calls++;
      return Response.json({ status: true, resultSet: { token: 'synthetic-token', user: { site } } });
    }, async () => {});
    assert.equal(calls, 1);
    assert.equal(result.identityVerified, false);
    assert.equal(result.stoppedReason, 'login_tenant_not_matched');
  }
});
test('missing site or public http/bare site still requires the exact property anchor', async () => {
  for (const site of [undefined, 'http://www.godoyimoveispiracaia.com.br', 'www.godoyimoveispiracaia.com.br']) {
    const paths = [];
    const result = await runReadProbe(env, async url => {
      const path = url.split('/v1/app/')[1]; paths.push(path);
      const body = normal(path);
      if (path === 'account/login') body.resultSet.user.site = site;
      return Response.json(body);
    }, async () => {});
    assert.equal(result.identityVerified, true);
    assert.equal(paths.length, 8);
    assert.ok(paths.indexOf('imovel/lista?page=1&per_page=1&referenciaImovel=369041') < paths.findIndex(p => p.startsWith('pessoa/lista')));
  }
});
