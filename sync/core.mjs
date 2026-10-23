import { createHash } from 'node:crypto';

export const BASE = 'https://api1.imobibrasil.app/v1/app/';
export const ACCOUNT_SITE = 'godoyimoveispiracaia.com.br';
export function phone(value) {
  let n = String(value ?? '').replace(/\D/g, '');
  if (n.length === 10 || n.length === 11) n = '55' + n;
  return /^55[1-9]\d[2-9]\d{7,8}$/.test(n) ? n : null;
}
export function aliases(value) {
  const n = phone(value);
  if (!n) return [];
  const all = [n];
  // Treat old/new mobile notation as a possible collision; never merge records.
  if (n.length === 13 && n[4] === '9') all.push(n.slice(0, 4) + n.slice(5));
  if (n.length === 12 && Number(n[4]) >= 6) all.push(n.slice(0, 4) + '9' + n.slice(4));
  return all;
}
export function siteMatches(value) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password &&
      u.hostname.toLowerCase().replace(/^www\./, '') === ACCOUNT_SITE;
  } catch { return false; }
}
export function collect(snapshot, { activatedAt, now, excludedPhones = [], accounts = ['PRINCIPAL', 'SECUNDÁRIO'] }) {
  if (!Array.isArray(snapshot?.conversas) || !Number.isFinite(Date.parse(snapshot.geradoEm)) ||
      Math.abs(now - Date.parse(snapshot.geradoEm)) > 15 * 60000) throw new Error('source_stale_or_invalid');
  const excluded = new Set(excludedPhones.flatMap(aliases)), out = new Map();
  for (const c of snapshot.conversas) {
    const p = phone(c.telefone);
    if (!p || !accounts.includes(c.conta) || !/@s\.whatsapp\.net$/.test(c.jid || '') ||
        !aliases(String(c.jid).split('@')[0]).includes(p) ||
        aliases(p).some(x => excluded.has(x))) continue;
    for (const m of Array.isArray(c.mensagens) ? c.mensagens : []) {
      const at = Date.parse(m.quando);
      if (m.sentido !== 'entrada' || m.conta !== c.conta || !Number.isFinite(at) ||
          at <= activatedAt || at > now + 60000 || typeof m.texto !== 'string' || !m.texto.trim()) continue;
      // No outbound messages, media, commands or decisions inferred from silence.
      if (/^(?:sair|stop|pare|parar|descadastrar|remover meu contato)\s*[.!]?$/i.test(m.texto.trim())) continue;
      const id = createHash('sha256').update(`${c.conta}\0${p}\0${at}\0${m.texto}`).digest('hex');
      const event = { id, phone: p, account: c.conta, at, text: m.texto.trim().slice(0, 2200),
        // The export proves WhatsApp as the channel; a shared social link does not prove an ad source.
        origin: 3, originLabel: 'WhatsApp Lead', viaPersonal: m.via === 'numero-pessoal' };
      if (!out.has(p) || at < out.get(p).at) out.set(p, event);
    }
  }
  return [...out.values()].sort((a, b) => a.at - b.at);
}
export function payload(event) {
  return { status: 1, nome: 'Contato WhatsApp', telefone: event.phone, origem: 3, temperatura: 0,
    mensagem: `Robô Godoy | WhatsApp | Conta: ${event.account}${event.viaPersonal ? ' | Atendimento pelo número pessoal' : ''}\n` +
      `Entrada: ${new Date(event.at).toISOString()}\n${event.text}\n[GodoySync:${event.id}]` };
}
export function page(body) {
  const x = body?.resultSet;
  if (body?.status !== true || !x || !Array.isArray(x.data) ||
      !Number.isInteger(x.page) || x.page < 1 || !Number.isInteger(x.total_pages) || x.total_pages < 0 ||
      !Number.isInteger(x.total_items) || x.total_items < 0) throw new Error('unrecognized_pagination');
  return x;
}
export function recordPhones(row) {
  return ['telefone', 'telefone1', 'telefone2', 'telefone3'].flatMap(k => aliases(row[k]));
}
export function id(value) { return /^[1-9]\d{0,14}$/.test(String(value)) ? String(value) : null; }

export async function synchronizeOne(event, { store, api, knownPhones, ownership }) {
  let row = store.get(event.phone);
  if (row && ['created', 'existing'].includes(row.status)) return row.status;
  const existing = aliases(event.phone).some(p => knownPhones.has(p));
  if (existing) { store.set(event.phone, 'existing', event.id); return 'existing'; }
  // A request may have reached the CRM even when its response was lost.
  // An unknown outcome is never retried as another POST, including after a restart.
  if (row && ['sending', 'uncertain', 'review'].includes(row.status)) return 'review';
  ownership();
  store.set(event.phone, 'sending', event.id); // Durable commit MUST precede the network write.
  try {
    const result = await api('lead/inserir', { method: 'POST', body: payload(event) });
    const externalId = result?.status === true && id(result.resultSet);
    if (!externalId) { store.set(event.phone, 'review', event.id); return 'review'; }
    store.set(event.phone, 'created', event.id, externalId);
    for (const p of aliases(event.phone)) knownPhones.add(p);
    return 'created';
  } catch {
    store.set(event.phone, 'uncertain', event.id);
    return 'review';
  }
}
