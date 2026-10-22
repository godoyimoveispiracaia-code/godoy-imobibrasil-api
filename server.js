import http from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const LOGIN = 'https://api1.imobibrasil.app/v1/app/account/login';
const STATUS = 'https://api2.imobibrasil.app/v1/app/account/status';

// JSON Pointer: explicit response paths supplied only after support confirmation.
export function pointer(object, path) {
  if (!path?.startsWith('/')) return undefined;
  return path.slice(1).split('/').reduce((v, key) => {
    key = key.replace(/~1/g, '/').replace(/~0/g, '~');
    return v !== null && typeof v === 'object' && Object.hasOwn(v, key) ? v[key] : undefined;
  }, object);
}

export function configuration(env) {
  const required = ['ADMIN_API_KEY', 'IMOBIBRASIL_USERNAME', 'IMOBIBRASIL_PASSWORD',
    'IMOBIBRASIL_USER_FIELD', 'IMOBIBRASIL_PASSWORD_FIELD', 'IMOBIBRASIL_LOGIN_ENCODING',
    'IMOBIBRASIL_TOKEN_POINTER', 'IMOBIBRASIL_STATUS_POINTER', 'IMOBIBRASIL_STATUS_EXPECTED_JSON'];
  const missing = required.filter(k => !env[k]);
  const invalid = [];
  if (env.ADMIN_API_KEY && env.ADMIN_API_KEY.length < 32) invalid.push('ADMIN_API_KEY');
  if (env.IMOBIBRASIL_LOGIN_ENCODING && !['json', 'form'].includes(env.IMOBIBRASIL_LOGIN_ENCODING)) invalid.push('IMOBIBRASIL_LOGIN_ENCODING');
  const userField = env.IMOBIBRASIL_USER_FIELD;
  const passwordField = env.IMOBIBRASIL_PASSWORD_FIELD;
  for (const [name, field] of [['IMOBIBRASIL_USER_FIELD', userField], ['IMOBIBRASIL_PASSWORD_FIELD', passwordField]]) {
    if (field && (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field) || ['manterLogin', 'origin', '__proto__', 'constructor', 'prototype'].includes(field))) invalid.push(name);
  }
  if (userField && userField === passwordField) invalid.push('IMOBIBRASIL_PASSWORD_FIELD');
  for (const key of ['IMOBIBRASIL_TOKEN_POINTER', 'IMOBIBRASIL_STATUS_POINTER']) {
    if (env[key] && !env[key].startsWith('/')) invalid.push(key);
  }
  let expected;
  if (env.IMOBIBRASIL_STATUS_EXPECTED_JSON) {
    try {
      expected = JSON.parse(env.IMOBIBRASIL_STATUS_EXPECTED_JSON);
      if (expected === null || !['boolean', 'string', 'number'].includes(typeof expected)) invalid.push('IMOBIBRASIL_STATUS_EXPECTED_JSON');
    } catch { invalid.push('IMOBIBRASIL_STATUS_EXPECTED_JSON'); }
  }
  return { missing, invalid, expected, ready: missing.length === 0 && invalid.length === 0,
    enabled: env.IMOBIBRASIL_ENABLED === 'true',
    confirmed: env.IMOBIBRASIL_CONTRACT_CONFIRMED === 'true' };
}

export function createApp({ env = process.env, fetcher = fetch, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let busy = false;
  let blocked = false;
  let nextRequestAt = 0;
  let lastValidation = null;
  const config = configuration(env);
  const hash = value => createHash('sha256').update(value).digest();
  const authorized = req => env.ADMIN_API_KEY?.length >= 32 &&
    timingSafeEqual(hash(req.headers.authorization ?? ''), hash(`Bearer ${env.ADMIN_API_KEY}`));

  async function upstream(url, options) {
    await sleep(Math.max(0, nextRequestAt - now()));
    nextRequestAt = now() + 6100;
    const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if ([401, 403].includes(response.status)) blocked = true;
    if (response.status === 429) {
      const header = response.headers.get('retry-after');
      const seconds = header && /^\d+$/.test(header) ? Number(header) : NaN;
      const date = header ? Date.parse(header) : NaN;
      nextRequestAt = Math.max(nextRequestAt, now() + (Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? Math.max(0, date - now()) : 60000));
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, httpStatus: response.status };
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      await response.body?.cancel();
      throw new Error('invalid_response');
    }
    // Bound response size; never return bodies or tokens to callers or logs.
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 1048576) { await reader.cancel(); throw new Error('response_too_large'); }
      chunks.push(value);
    }
    return { ok: true, httpStatus: response.status, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  }

  return http.createServer(async (req, res) => {
    req.resume();
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer' });
      res.end(JSON.stringify(body));
    };
    // Liveness is deliberately separate from the unvalidated ImobiBrasil connection.
    if (req.url === '/healthz' && req.method === 'GET') return send(200, { status: 'ok' });
    if (!['/v1/status', '/v1/validate'].includes(req.url)) return send(404, { error: 'not_found' });
    if (!env.ADMIN_API_KEY || env.ADMIN_API_KEY.length < 32) return send(503, { error: 'admin_not_configured' });
    if (!authorized(req)) return send(401, { error: 'unauthorized' });
    if (req.url === '/v1/status' && req.method === 'GET') return send(200, {
      enabled: config.enabled, contractConfirmed: config.confirmed, configured: config.ready,
      missing: config.missing, invalid: config.invalid, mode: 'read_only_validation',
      automaticSync: false, upstreamBlocked: blocked, lastValidation,
    });
    if (req.url !== '/v1/validate' || req.method !== 'POST') return send(405, { error: 'method_not_allowed' });
    if (!config.enabled || !config.confirmed || !config.ready) return send(503, { error: 'integration_not_ready' });
    if (blocked) return send(503, { error: 'upstream_rejected_credentials_review_required' });
    if (busy || now() < nextRequestAt) return send(429, { error: 'validation_busy_or_cooldown' });
    busy = true;
    try {
      const fields = { [env.IMOBIBRASIL_USER_FIELD]: env.IMOBIBRASIL_USERNAME,
        [env.IMOBIBRASIL_PASSWORD_FIELD]: env.IMOBIBRASIL_PASSWORD, manterLogin: true, origin: 'API' };
      const isJson = env.IMOBIBRASIL_LOGIN_ENCODING === 'json';
      const login = await upstream(LOGIN, { method: 'POST', headers: {
        'Content-Type': isJson ? 'application/json' : 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: isJson ? JSON.stringify(fields) : new URLSearchParams(fields).toString() });
      if (!login.ok) {
        lastValidation = { at: new Date(now()).toISOString(), ok: false, stage: 'login', httpStatus: login.httpStatus };
        return send(502, lastValidation);
      }
      const token = pointer(login.data, env.IMOBIBRASIL_TOKEN_POINTER);
      if (typeof token !== 'string' || !token.length || token.length > 16384 || /[\r\n]/.test(token)) throw new Error('token_missing');
      const result = await upstream(STATUS, { method: 'GET', headers: { Accept: 'application/json', 'X-Authorization': `Bearer ${token}` } });
      const ok = result.ok && pointer(result.data, env.IMOBIBRASIL_STATUS_POINTER) === config.expected;
      lastValidation = { at: new Date(now()).toISOString(), ok, stage: 'account_status', httpStatus: result.httpStatus };
      return send(ok ? 200 : 502, lastValidation);
    } catch {
      lastValidation = { at: new Date(now()).toISOString(), ok: false, error: 'validation_failed' };
      return send(502, lastValidation);
    } finally { busy = false; }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp();
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.listen(Number(process.env.PORT || 10000), '0.0.0.0', () => console.log('service_started'));
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 25000).unref();
  });
}
