import { pathToFileURL } from 'node:url';

// Manual build-time discovery only; disabled by default and never run at startup.
// Response values and credential-bearing errors must never reach logs.
const containers = ['data', 'result', 'response', 'account', 'auth', 'session'];
function scan(value, keys, path = '', depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return [];
  const found = keys.filter(key => Object.hasOwn(value, key))
    .map(key => ({ pointer: `${path}/${key}`, value: value[key] }));
  for (const key of containers) {
    if (Object.hasOwn(value, key)) found.push(...scan(value[key], keys, `${path}/${key}`, depth + 1));
  }
  return found;
}

async function boundedJson(response) {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    await response.body?.cancel();
    throw new Error('not_json');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.length;
    if (size > 1048576) { await reader.cancel(); throw new Error('too_large'); }
    chunks.push(item.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function runProbe(env, fetcher = fetch, sleep = ms => new Promise(r => setTimeout(r, ms))) {
  if (env.IMOBIBRASIL_BUILD_PROBE !== 'true') return { event: 'api_probe', skipped: true };
  if (!env.IMOBIBRASIL_USERNAME || !env.IMOBIBRASIL_PASSWORD ||
      env.IMOBIBRASIL_USER_FIELD !== 'login' || env.IMOBIBRASIL_PASSWORD_FIELD !== 'password' ||
      env.IMOBIBRASIL_LOGIN_ENCODING !== 'json') return { event: 'api_probe', error: 'probe_configuration_incomplete' };
  const result = { event: 'api_probe' };
  try {
    const login = await fetcher('https://api1.imobibrasil.app/v1/app/account/login', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ login: env.IMOBIBRASIL_USERNAME, password: env.IMOBIBRASIL_PASSWORD, manterLogin: true, origin: 'API' }),
    });
    result.loginHttpStatus = login.status;
    if (!login.ok) { await login.body?.cancel(); return result; }
    const body = await boundedJson(login);
    const tokens = scan(body, ['token', 'access_token', 'accessToken'])
      .filter(item => typeof item.value === 'string' && item.value.length > 0 && item.value.length <= 16384 && !/[\r\n]/.test(item.value));
    result.tokenCandidateCount = tokens.length;
    if (tokens.length !== 1) return result;
    result.tokenPointer = tokens[0].pointer;
    // Do not reuse or persist this token beyond this single status request.
    await sleep(6100);
    const response = await fetcher('https://api2.imobibrasil.app/v1/app/account/status', {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/json', 'X-Authorization': `Bearer ${tokens[0].value}` },
    });
    result.accountStatusHttpStatus = response.status;
    if (!response.ok) { await response.body?.cancel(); return result; }
    const status = await boundedJson(response);
    result.statusIndicators = scan(status, ['status', 'statusConta', 'success', 'ativo', 'active'])
      .filter(item => typeof item.value === 'boolean' ||
        (typeof item.value === 'number' && [0, 1].includes(item.value)) ||
        (typeof item.value === 'string' && /^(ativo|ativa|active|inactive|inativo|inativa|ok|true|false)$/i.test(item.value)));
    const domains = scan(status, ['website', 'site', 'dominio', 'domain']);
    result.accountDomainMatch = domains.some(item => typeof item.value === 'string' &&
      /^(?:https?:\/\/)?(?:www\.)?godoyimoveispiracaia\.com\.br\/?$/i.test(item.value));
    return result;
  } catch {
    // Never log exception text: network libraries may include request details.
    return { ...result, error: 'probe_failed' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.IMOBIBRASIL_BUILD_PROBE === 'true') {
    console.log(JSON.stringify({ event: 'api_probe_started' }));
    console.log(JSON.stringify(await runProbe(process.env)));
  }
}
