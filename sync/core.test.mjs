import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collect, phone, aliases, payload, synchronizeOne, siteMatches } from './core.mjs';
import { openState, knownContacts, makeAPI } from './worker.mjs';

const now = Date.parse('2026-10-23T18:00:00Z');
const event = { id: 'a'.repeat(64), phone: '5511987654321', at: now - 1000, account: 'PRINCIPAL', text: 'Quero informações', origin: 3 };
const convo = (override = {}) => ({ conta: 'PRINCIPAL', telefone: event.phone, jid: event.phone + '@s.whatsapp.net',
  mensagens: [{ sentido: 'entrada', quando: new Date(now - 1000).toISOString(), conta: 'PRINCIPAL', texto: 'Informações' }], ...override });
function source(conversas) { return { geradoEm: new Date(now).toISOString(), conversas }; }
function config() { return { activatedAt: now - 10000, now, excludedPhones: ['5511911111111'] }; }
function state(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'godoy-sync-'));
  const filename = path.join(dir, 'state.sqlite');
  const s = openState(filename); t.after(() => { try { s.close(); } catch {} rmSync(dir, { recursive: true }); });
  return { s, filename };
}
test('snapshot ingestion excludes history, outbound, groups, own contacts and opt-out', () => {
  const base = convo();
  const fixtures = [base, convo({ conta: 'CORRETOR' }), convo({ jid: '123@g.us' }), convo({ telefone: '5511911111111' }),
    convo({ mensagens: [{ ...base.mensagens[0], sentido: 'saida' }] }),
    convo({ mensagens: [{ ...base.mensagens[0], quando: new Date(now - 20000).toISOString() }] }),
    convo({ mensagens: [{ ...base.mensagens[0], texto: 'pare' }] })];
  const rows = collect(source(fixtures), config());
  assert.equal(rows.length, 1); assert.equal(rows[0].origin, 3);
  assert.deepEqual(collect(source([base]), { ...config(), activatedAt: now }), []);
});
test('snapshot replay and two WhatsApp accounts produce one contact', () => {
  const a = convo(), b = convo({ conta: 'SECUNDÁRIO', mensagens: [{ ...a.mensagens[0], conta: 'SECUNDÁRIO' }] });
  assert.equal(collect(source([a, b, a]), config()).length, 1);
  assert.deepEqual(collect(source([a]), config()), collect(source([a]), config()));
});
test('stale or unrecognized export never creates a lead', () => {
  assert.throws(() => collect({ conversas: [] }, config()));
  assert.throws(() => collect({ ...source([]), geradoEm: '2020-01-01' }, config()));
});
test('source is WhatsApp even when a message contains a social link; no inferred deal status', () => {
  const e = { ...event, text: 'https://instagram.com/p/test' };
  const p = payload(e);
  assert.equal(p.origem, 3); assert.equal(p.status, 1); assert.equal(p.temperatura, 0);
  assert.equal(p.codigoPessoa, undefined); assert.equal(p.codigoImovel, undefined);
  assert.ok(p.mensagem.includes('[GodoySync:'));
});
test('phone canonicalization detects Brazilian old mobile forms conservatively', () => {
  assert.equal(phone('(11) 98765-4321'), event.phone);
  assert.ok(aliases('11987654321').includes('551187654321'));
  assert.equal(phone('123'), null);
  assert.ok(siteMatches('http://www.godoyimoveispiracaia.com.br/'));
  assert.equal(siteMatches('https://godoyimoveispiracaia.com.br.attacker.test'), false);
});
test('durable success survives restart without another POST', async t => {
  const { s, filename } = state(t); let writes = 0;
  const dependencies = { store: s, knownPhones: new Set(), ownership: s.ownership,
    api: async () => { writes++; assert.equal(s.get(event.phone).status, 'sending'); return { status: true, resultSet: 42 }; } };
  assert.equal(await synchronizeOne(event, dependencies), 'created');
  s.close(); const reopened = openState(filename);
  try { assert.equal(await synchronizeOne(event, { ...dependencies, store: reopened, ownership: reopened.ownership }), 'created'); }
  finally { reopened.close(); }
  assert.equal(writes, 1);
});
test('POST timeout after acceptance is held after restart and never retried', async t => {
  const { s, filename } = state(t); let writes = 0;
  const api = async () => { writes++; throw new Error('lost response'); };
  assert.equal(await synchronizeOne(event, { store: s, knownPhones: new Set(), ownership: s.ownership, api }), 'review');
  s.close(); const reopened = openState(filename);
  try {
    assert.equal(await synchronizeOne(event, { store: reopened, knownPhones: new Set(), ownership: reopened.ownership, api }), 'review');
    assert.equal(await synchronizeOne(event, { store: reopened, knownPhones: new Set([event.phone]), ownership: reopened.ownership, api }), 'existing');
  } finally { reopened.close(); }
  assert.equal(writes, 1);
});
test('existing person or lead prevents creation and modification', async t => {
  const { s } = state(t);
  assert.equal(await synchronizeOne(event, { store: s, knownPhones: new Set([event.phone]), ownership: s.ownership,
    api: () => assert.fail('no network write allowed') }), 'existing');
});
test('lease prevents concurrent workers on the same durable state', t => {
  const { filename } = state(t);
  assert.throws(() => openState(filename), /another_worker/);
});
const paged = (data, page = 1, total_pages = 1, total_items = data.length) => ({ status: true, resultSet: { data, page, total_pages, total_items } });
test('CRM inventory includes all people, all active leads and lead history', async () => {
  const paths = [];
  const known = await knownContacts(async p => {
    paths.push(p);
    return p.startsWith('pessoa') ? paged([{ codigoPessoa: 1, telefone2: '11987654321' }]) : paged([]);
  });
  assert.ok(known.has(event.phone)); assert.equal(paths.length, 3); assert.ok(paths.some(p => p.includes('historico=true')));
});
test('partial, repeated or changing pagination aborts before a create can be considered', async () => {
  await assert.rejects(() => knownContacts(async () => paged([], 1, 1, 1)));
  await assert.rejects(() => knownContacts(async p => paged([{ codigoPessoa: 1 }], p.includes('page=2&') ? 2 : 1, 2, 2)));
  await assert.rejects(() => knownContacts(async () => ({ status: true, resultSet: [] })));
});
test('unknown contact phone schema and mismatched WhatsApp identity abort safely', async () => {
  await assert.rejects(() => knownContacts(async () => paged([{codigoPessoa: 1, mobile: '11987654321'}])), /unknown_phone_schema/);
  assert.deepEqual(collect(source([convo({jid:'5511966666666@s.whatsapp.net'})]), config()), []);
});
test('API cannot call modification or photography endpoints', async t => {
  const { s } = state(t);
  const api = makeAPI(s, {}, () => assert.fail('forbidden route reached network'));
  for (const [route, method] of [['imovel/excluir/1','POST'],['lead/atualizar/dados/1','POST'],['imovel/foto/excluir/1','GET']]) {
    await assert.rejects(() => api.request(route,{method}), /route_not_allowed/);
  }
});
test('startup verifies tenant, property and WhatsApp origin before private writes', async t => {
  const { s } = state(t); const calls = [];
  const api = makeAPI(s, {IMOBIBRASIL_USERNAME:'synthetic-user',IMOBIBRASIL_PASSWORD:'synthetic-secret'}, async (url, options) => {
    const route = url.split('/v1/app/')[1]; calls.push(route);
    assert.equal(options.redirect, 'error');
    if (route === 'account/login') {
      assert.equal(options.headers['X-Authorization'], undefined);
      assert.deepEqual(JSON.parse(options.body), {login:'synthetic-user',password:'synthetic-secret',manterLogin:true,origin:'API'});
      return Response.json({status:true,resultSet:{token:'synthetic-token',user:{site:'https://godoyimoveispiracaia.com.br'}}});
    }
    assert.equal(options.headers['X-Authorization'], 'Bearer synthetic-token');
    assert.equal(options.method,'GET');
    if (route === 'account/perfil') return Response.json({status:true,resultSet:{statusConta:false}});
    if (route.startsWith('imovel/')) return Response.json(paged([{codigoImovel:4306887,referenciaImovel:'369041'}]));
    if (route === 'lead/origem/captacao/lista') return Response.json({status:true,resultSet:[{value:3,descricao:'WhatsApp Lead'}]});
    assert.fail('unexpected route');
  }, async () => {});
  await api.login(); assert.equal(calls.length,4);
});
test('wrong tenant stops startup immediately after login', async t => {
  const { s } = state(t); let calls = 0;
  const api = makeAPI(s,{IMOBIBRASIL_USERNAME:'synthetic',IMOBIBRASIL_PASSWORD:'synthetic'},async()=>{
    calls++; return Response.json({status:true,resultSet:{token:'synthetic',user:{site:'other.test'}}});
  },async()=>{});
  await assert.rejects(()=>api.login(),/tenant_or_token_not_confirmed/); assert.equal(calls,1);
});
test('401, 403 and 429 pause durably; no credential or raw response is logged', async t => {
  for (const code of [401, 403, 429]) {
    const { s } = state(t);
    const api = makeAPI(s, {}, async () => new Response('private upstream detail', { status: code }), async () => {});
    await assert.rejects(() => api.request('account/perfil'), new RegExp(`provider_http_${code}`));
    assert.equal(s.meta('paused'), 'http_' + code);
    await assert.rejects(() => api.request('account/perfil'), /paused_review_required/);
  }
});
