import { pathToFileURL } from 'node:url';
import { extractToken } from './probe.js';

// Supervised read diagnostic. Never called by the running service.
// No response values, record IDs, dynamic field names or errors are logged.
const base = 'https://api1.imobibrasil.app/v1/app/';
const wrappers = ['resultSet', 'data', 'result', 'response', 'retorno', 'dados', 'payload', 'body'];
const knownFields = ['status', 'success', 'statusConta', 'resultSet', 'data', 'page', 'per_page',
  'total_pages', 'total_items', 'codigoPessoa', 'codigoCliente', 'codigoCorretor',
  'codigoMensagem', 'codigoLead', 'codigoNegocio', 'codigoImovel', 'referenciaImovel', 'permissoes'];

function objects(value, depth = 0, budget = { left: 300 }) {
  if (!value || typeof value !== 'object' || depth > 8 || --budget.left < 0) return [];
  const out = [value];
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') out.push(...objects(child, depth + 1, budget));
  }
  return out;
}
function envelope(body) {
  let current = body;
  for (let i = 0; i < 8 && current && typeof current === 'object' && !Array.isArray(current); i++) {
    const key = wrappers.find(k => current[k] && typeof current[k] === 'object');
    if (!key) break;
    // Stop at the pagination envelope, before its record array.
    if (Array.isArray(current.data) || Object.hasOwn(current, 'total_items')) break;
    current = current[key];
  }
  return current;
}
function rows(body, idKey) {
  const value = envelope(body);
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (value && Object.hasOwn(value, idKey)) return [value];
  return undefined;
}
function positiveId(value) {
  return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
    (typeof value === 'string' && /^[1-9]\d{0,14}$/.test(value));
}
function failure(body) {
  if (body?.status === false || body?.success === false) return true;
  return false;
}
async function json(response) {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    await response.body?.cancel(); throw new Error('not_json');
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > 1048576) { await reader.cancel(); throw new Error('too_large'); }
    chunks.push(part.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function runReadProbe(env, fetcher = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), emit = () => {}) {
  const result = { event: 'read_probe', checks: [], identityVerified: false, writes: 0, automaticSync: false };
  if (env.IMOBIBRASIL_READ_PROBE !== 'true') return { ...result, skipped: true };
  if (!env.IMOBIBRASIL_USERNAME || !env.IMOBIBRASIL_PASSWORD ||
      env.IMOBIBRASIL_USER_FIELD !== 'login' || env.IMOBIBRASIL_PASSWORD_FIELD !== 'password' ||
      env.IMOBIBRASIL_LOGIN_ENCODING !== 'json' || env.IMOBIBRASIL_ENABLED !== 'false' ||
      env.IMOBIBRASIL_CONTRACT_CONFIRMED !== 'false' || env.IMOBIBRASIL_BUILD_PROBE !== 'false') {
    return { ...result, error: 'unsafe_or_incomplete_configuration' };
  }
  let token, stopped = false, calls = 0;
  async function request(name, path, idKey, extraHeaders = {}) {
    if (stopped || calls >= 10) return undefined;
    if (calls) await sleep(6100);
    calls++;
    const login = name === 'login';
    const response = await fetcher(base + path, {
      method: login ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: login ? { Accept: 'application/json', 'Content-Type': 'application/json' } :
        { Accept: 'application/json', 'X-Authorization': `Bearer ${token}`, ...extraHeaders },
      ...(login ? { body: JSON.stringify({ login: env.IMOBIBRASIL_USERNAME, password: env.IMOBIBRASIL_PASSWORD, manterLogin: true, origin: 'API' }) } : {}),
    });
    const check = { name, httpStatus: response.status, method: login ? 'POST' : 'GET', path };
    for (const [header, key] of [['X-RateLimit-Limit', 'rateLimit'], ['X-RateLimit-Remaining', 'rateRemaining'], ['Retry-After', 'retryAfterSeconds']]) {
      const value = response.headers.get(header);
      if (value && /^\d{1,8}$/.test(value)) check[key] = Number(value);
    }
    if (!response.ok) {
      await response.body?.cancel();
      check.readAccepted = false;
      if ([401, 403, 429].includes(response.status)) stopped = true;
      result.checks.push(check); emit({ event: 'read_probe_step', ...check });
      return undefined;
    }
    const body = await json(response);
    check.providerStatus = typeof body?.status === 'boolean' ? body.status : null;
    check.readAccepted = !failure(body) && (body?.status === true || body?.success === true);
    if (idKey) {
      const records = rows(body, idKey);
      check.listShapeRecognized = Array.isArray(records);
      if (records) {
        check.sampleCount = records.length;
        check.sampleHasIdentifier = records.length > 0 && records.every(row => positiveId(row?.[idKey]));
      }
      const root = envelope(body);
      check.paginationFields = ['page', 'per_page', 'total_pages', 'total_items'].filter(key =>
        root && Object.hasOwn(root, key) && Number.isSafeInteger(Number(root[key])) && Number(root[key]) >= 0);
    }
    check.recognizedFields = [...new Set(objects(body).flatMap(obj => knownFields.filter(key => Object.hasOwn(obj, key))))];
    if (failure(body)) stopped = true;
    if (check.rateRemaining === 0) stopped = true;
    result.checks.push(check); emit({ event: 'read_probe_step', ...check });
    return check.readAccepted ? body : undefined;
  }
  try {
    const login = await request('login', 'account/login');
    token = login && extractToken(login);
    if (!token) return { ...result, stoppedReason: 'login_not_validated', requestCount: calls };
    // CRM contract confirmed by support Hugo on 2026-10-23. The old
    // account/status statusConta flag is not an account-activation gate.
    // The documented JWT login identifies its tenant via resultSet.user.site.
    let siteMatches = false;
    try {
      const site = new URL(login.resultSet?.user?.site);
      siteMatches = site.protocol === 'https:' &&
        site.hostname.toLowerCase().replace(/^www\./, '') === 'godoyimoveispiracaia.com.br';
    } catch { /* Missing/invalid tenant identity fails closed. */ }
    result.loginSiteMatches = siteMatches;
    if (!siteMatches) return { ...result, stoppedReason: 'login_tenant_not_matched', requestCount: calls };
    const lifetime = Number(login.resultSet?.expires_in) - Number(login.resultSet?.created_in);
    if (Number.isSafeInteger(lifetime) && lifetime > 0) result.tokenLifetimeSeconds = lifetime;
    const profile = await request('account_profile', 'account/perfil');
    if (!profile) return { ...result, stoppedReason: 'profile_not_validated', requestCount: calls };
    // Match a real public Godoy listing by BOTH immutable ID and public reference.
    // This also tests the documented property list route before private CRM data.
    const anchor = await request('property_identity', 'imovel/lista?page=1&per_page=1&referenciaImovel=369041', 'codigoImovel');
    const matches = rows(anchor, 'codigoImovel')?.filter(row => String(row.codigoImovel) === '4306887' && String(row.referenciaImovel) === '369041');
    result.identityVerified = matches?.length === 1;
    if (!result.identityVerified) return { ...result, stoppedReason: 'godoy_property_not_matched', requestCount: calls };
    await request('permissions', 'account/permissao');
    await request('clients', 'pessoa/lista?page=1&per_page=1&tipoCadastro=cliente', 'codigoPessoa');
    await request('leads', 'lead/lista?page=1&per_page=1', 'codigoLead');
    // The CRM documentation makes codigoCliente/codigoCorretor optional filters.
    // No legacy ID conversion or fabricated IDs are needed for a minimal read.
    await request('deals', 'negocio/lista?page=1&per_page=1', 'codigoNegocio');
    await request('messages', 'mensagem/lista?page=1&per_page=1', 'codigoMensagem');
    return { ...result, requestCount: calls, stoppedOnProviderFailure: stopped };
  } catch {
    return { ...result, requestCount: calls, error: 'read_probe_failed' };
  } finally {
    token = undefined;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.env.IMOBIBRASIL_READ_PROBE === 'true') {
  console.log(JSON.stringify({ event: 'read_probe_started' }));
  console.log(JSON.stringify(await runReadProbe(process.env, fetch, undefined, value => console.log(JSON.stringify(value)))));
}
