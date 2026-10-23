import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { extractToken } from '../probe.js';
import { BASE, collect, phone, aliases, siteMatches, page, recordPhones, synchronizeOne } from './core.mjs';

export function openState(filename, owner = randomUUID()) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS leads (phone TEXT PRIMARY KEY, status TEXT NOT NULL, event TEXT NOT NULL, externalId TEXT, updatedAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY, owner TEXT, expires INTEGER NOT NULL);
    INSERT OR IGNORE INTO lease VALUES(1,'',0);`);
  const meta = key => db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
  const put = (key, value) => db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key, String(value));
  const ownership = () => {
    const r = db.prepare('UPDATE lease SET owner=?, expires=? WHERE id=1 AND (owner=? OR expires<?)').run(owner, Date.now() + 120000, owner, Date.now());
    if (!r.changes) throw new Error('another_worker_is_active');
  };
  ownership();
  const timer = setInterval(() => { try { ownership(); } catch { /* Checked again before each API request/write. */ } }, 10000);
  timer.unref();
  return { meta, put, ownership,
    get: p => db.prepare('SELECT * FROM leads WHERE phone=?').get(p),
    set(p, status, event, externalId = null) {
      ownership();
      db.prepare('INSERT OR REPLACE INTO leads VALUES(?,?,?,?,?)').run(p, status, event, externalId, Date.now());
    },
    summary() { return db.prepare('SELECT status, count(*) AS total FROM leads GROUP BY status').all(); },
    close() { clearInterval(timer); db.prepare('UPDATE lease SET expires=0 WHERE owner=?').run(owner); db.close(); }
  };
}
async function boundedJSON(res) {
  if (!res.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new Error('invalid_content_type');
  const chunks = []; let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > 2097152) throw new Error('response_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function makeAPI(store, env, fetcher = fetch, sleep = ms => new Promise(r => setTimeout(r, ms))) {
  let token;
  async function request(route, options = {}) {
    const method = options.method || 'GET';
    if ((method === 'POST' && !['account/login', 'lead/inserir'].includes(route)) ||
        (method === 'GET' && !/^(?:account\/perfil|lead\/origem\/captacao\/lista|imovel\/lista\?page=1&per_page=1&referenciaImovel=369041|(?:pessoa|lead)\/lista\?(?:historico=true&)?page=\d+&per_page=100)$/.test(route)) ||
        !['GET', 'POST'].includes(method)) throw new Error('route_not_allowed');
    store.ownership();
    if (store.meta('paused')) throw new Error('paused_review_required');
    const wait = Math.max(0, Number(store.meta('nextRequestAt') || 0) - Date.now());
    if (wait) await sleep(wait);
    store.ownership();
    store.put('nextRequestAt', Date.now() + 6100);
    const response = await fetcher(BASE + route, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/json', ...(token ? { 'X-Authorization': `Bearer ${token}` } : {}),
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403, 429].includes(response.status)) store.put('paused', `http_${response.status}`);
      throw new Error(`provider_http_${response.status}`);
    }
    const body = await boundedJSON(response);
    if (body.status !== true) throw new Error('provider_rejected');
    return body;
  }
  return { request,
    async login() {
      if (!env.IMOBIBRASIL_USERNAME || !env.IMOBIBRASIL_PASSWORD) throw new Error('credentials_missing');
      const result = await request('account/login', { method: 'POST', body: {
        login: env.IMOBIBRASIL_USERNAME, password: env.IMOBIBRASIL_PASSWORD, manterLogin: true, origin: 'API' } });
      token = extractToken(result);
      if (!token || /[\r\n]/.test(token) || !siteMatches(result.resultSet?.user?.site)) throw new Error('tenant_or_token_not_confirmed');
      await request('account/perfil');
      const anchor = page(await request('imovel/lista?page=1&per_page=1&referenciaImovel=369041'));
      if (anchor.data.length !== 1 || String(anchor.data[0].codigoImovel) !== '4306887' || String(anchor.data[0].referenciaImovel) !== '369041') throw new Error('property_identity_mismatch');
      const origins = await request('lead/origem/captacao/lista');
      if (!Array.isArray(origins.resultSet) || !origins.resultSet.some(x => Number(x.value) === 3 && /whatsapp/i.test(x.descricao))) throw new Error('whatsapp_origin_not_confirmed');
    }
  };
}
export async function knownContacts(request) {
  const result = new Set();
  for (const route of ['pessoa/lista', 'lead/lista', 'lead/lista?historico=true']) {
    let total, seen = 0, seenIds = new Set();
    for (let n = 1; n <= 100; n++) {
      const p = page(await request(`${route}${route.includes('?') ? '&' : '?'}page=${n}&per_page=100`));
      if (p.page !== n || p.total_pages > 100 || (n > 1 && p.total_items !== total)) throw new Error('unstable_or_excessive_catalog');
      total = p.total_items;
      for (const row of p.data) {
        const fields = route.startsWith('pessoa') ? ['telefone1','telefone2','telefone3'] : ['telefone'];
        if (!fields.some(k => Object.hasOwn(row, k)) || fields.some(k =>
          row[k] != null && !['string', 'number'].includes(typeof row[k]))) throw new Error('unknown_phone_schema');
        const key = String(route.startsWith('pessoa') ? row.codigoPessoa : row.codigoLead);
        if (!/^[1-9]\d*$/.test(key) || seenIds.has(key)) throw new Error('invalid_or_repeated_record');
        seenIds.add(key); seen++;
        for (const p of recordPhones(row)) result.add(p);
      }
      if (n >= p.total_pages) {
        if (seen !== total) throw new Error('incomplete_catalog');
        break;
      }
      if (!p.data.length || n === 100) throw new Error('incomplete_catalog');
    }
  }
  return result;
}
export async function main(env = process.env) {
  const root = env.GODOY_CRM_HOME;
  if (!root) throw new Error('home_missing');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (config.enabled !== true || !Array.isArray(config.excludedPhones) || !config.excludedPhones.length ||
      config.excludedPhones.some(x => !phone(x))) throw new Error('configuration_incomplete');
  const source = path.resolve(config.source);
  if (path.basename(source) !== 'acompanhamento.json') throw new Error('invalid_source');
  const readSnapshot = () => {
    if (fs.statSync(source).size > 10 * 1024 * 1024) throw new Error('source_too_large');
    return JSON.parse(fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, ''));
  };
  const store = openState(path.join(root, 'state.sqlite'));
  const log = event => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
  try {
    if (store.meta('paused')) { log({ event: 'paused', reason: store.meta('paused'), automaticSync: false }); return 2; }
    const api = makeAPI(store, env);
    await api.login();
    if (!store.meta('activatedAt')) {
      // Verify the full read contract before establishing the no-backfill baseline.
      collect(readSnapshot(), { activatedAt: Date.now(), now: Date.now(), excludedPhones: config.excludedPhones });
      await knownContacts(api.request);
      store.put('activatedAt', Date.now());
      log({ event: 'baseline_created', historicalImport: false });
    }
    let stopping = false;
    process.once('SIGTERM', () => { stopping = true; });
    process.once('SIGINT', () => { stopping = true; });
    let count = 0, successfulCycle = false;
    do {
      try {
        const events = collect(readSnapshot(), {
          activatedAt: Number(store.meta('activatedAt')), now: Date.now(), excludedPhones: config.excludedPhones });
        const pending = events.filter(e => !['created', 'existing'].includes(store.get(e.phone)?.status));
        if (pending.length) {
          const known = await knownContacts(api.request);
          for (const event of pending) {
            const status = await synchronizeOne(event, { store, api: api.request, knownPhones: known, ownership: store.ownership });
            if (status === 'review') { if (!store.meta('paused')) store.put('paused', 'ambiguous_write_review_required'); break; }
          }
        }
        count++;
        successfulCycle = true;
        log({ event: 'sync_cycle', automaticSync: !store.meta('paused'), summary: store.summary() });
      } catch { log({ event: 'cycle_deferred', automaticSync: false, reason: store.meta('paused') || 'source_or_read_not_validated' }); }
      if (env.GODOY_CRM_ONCE === 'true' || store.meta('paused') || stopping) break;
      await new Promise(r => setTimeout(r, 60000));
      // Refresh login daily without retaining the JWT on disk.
      if (count >= 1440) { await api.login(); count = 0; }
    } while (!stopping);
    return store.meta('paused') ? 2 : env.GODOY_CRM_ONCE === 'true' && !successfulCycle ? 1 : 0;
  } finally { store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    console.log(JSON.stringify({ event: 'startup_failed', automaticSync: false, reason: 'check_local_configuration_and_private_log' }));
    process.exitCode = 1;
  });
}
