// STORE-MAP-01 P9 wire contract (boards P9c, P9d): one person's export and
// forget-in-one-action, and the privacy flags a waiting memory carries. Shared by
// the browser client (session.ts) and the local bridge (application-server.cjs,
// memory-response.cjs). The backend registers the person routes only while its P9
// switch is on; otherwise they answer 404 and the window shows nothing new.
//
//   GET   /api/memory/people/:key/export   { person, exportedAt, names, drawer, mentions, agentNotes, graph, handoffs }
//   POST  /api/memory/people/:key/forget   { confirm: <key>, mentionIds? } → { drawer, mentions, graph }
//
// A waiting memory (GET /api/memory/proposals[/:id]) carries, while P9 is on and only
// when its reasons flag it, privacy: { personalData: kinds[], sensitive: topics[] }.

const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
// Same rule as a people drawer key (memory-pages-contract.js validDrawerId).
const personKey = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(x) && !x.includes('..');
const memoryId = x => typeof x === 'string' && /^[A-Za-z0-9_.@:-]{1,200}$/.test(x) && !x.includes('..');
const drawerId = x => typeof x === 'string' && x.length <= 150 && /^[a-z]+(:[A-Za-z0-9][A-Za-z0-9_.@-]{0,127})?$/.test(x) && !x.includes('..');
// eslint-disable-next-line no-control-regex
const badChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/gu;
const clip = (x, max) => (typeof x === 'string' ? x.replace(badChars, '').slice(0, max) : '');
const when = x => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.test(x) && x.length <= 40 ? x : '');
const fail = () => { throw Error('Invalid person response'); };

/** The kinds of personal data and the sensitive topics the review names (never the values). */
export const PERSONAL_DATA_KINDS = ['email', 'phone', 'bank-account', 'card', 'address', 'id-number'];
export const SENSITIVE_TOPICS = ['health', 'religion', 'politics', 'sexuality', 'origin', 'union', 'genetic'];
/** At most this many mentions can be forgotten with a person (the backend's limit). */
export const MAX_MENTIONS = 5000;

export const personExportPath = key => `/api/memory/people/${encodeURIComponent(key)}/export`;
export const personForgetPath = key => `/api/memory/people/${encodeURIComponent(key)}/forget`;

/** Which P9 person route a path is, or null. */
export function personPathOf(path) {
  if (typeof path !== 'string' || path.length > 512 || path.includes('#') || path.includes('?')) return null;
  const m = /^\/api\/memory\/people\/([^/]+)\/(export|forget)$/.exec(path);
  if (!m) return null;
  let key; try { key = decodeURIComponent(m[1]); } catch { return null; }
  return personKey(key) && encodeURIComponent(key) === m[1] ? { route: m[2], key } : null;
}
export function personRoute(path) { return personPathOf(path) !== null; }
export function allowedPerson(method, path, body) {
  const p = personPathOf(path);
  if (!p) return false;
  if (p.route === 'export') return method === 'GET' && body === undefined;
  if (method !== 'POST' || !record(body) || body.confirm !== p.key) return false;
  const keys = Object.keys(body);
  if (keys.some(k => k !== 'confirm' && k !== 'mentionIds')) return false;
  return body.mentionIds === undefined || (Array.isArray(body.mentionIds) && body.mentionIds.length <= MAX_MENTIONS && body.mentionIds.every(memoryId));
}

/** A waiting memory's privacy flags, or undefined (dropped when odd). */
export function privacyOf(x) {
  if (!record(x)) return undefined;
  const pick = (list, known) => (Array.isArray(list) ? [...new Set(list.filter(v => known.includes(v)))] : []);
  const personalData = pick(x.personalData, PERSONAL_DATA_KINDS), sensitive = pick(x.sensitive, SENSITIVE_TOPICS);
  return { personalData, sensitive };
}

const memory = m => (record(m) && memoryId(m.id) && drawerId(m.drawer) ? {
  id: m.id, drawer: m.drawer, type: clip(m.type, 40), status: clip(m.status, 20) || 'active', content: clip(m.content, 50000), createdAt: when(m.createdAt), validTo: when(m.validTo) || null,
} : null);

/** GET …/export: everything about one person. */
export function personExportResponse(key, body) {
  if (!record(body) || body.person !== key || !Array.isArray(body.drawer) || !Array.isArray(body.mentions)) fail();
  return {
    person: key, exportedAt: when(body.exportedAt),
    names: Array.isArray(body.names) ? body.names.slice(0, 50).map(n => clip(n, 120)).filter(Boolean) : [],
    drawer: body.drawer.slice(0, 20000).map(memory).filter(Boolean),
    mentions: body.mentions.slice(0, MAX_MENTIONS).map(m => { const x = memory(m); return x && (m.why === 'graph' || m.why === 'name') ? { ...x, why: m.why } : null; }).filter(Boolean),
    agentNotes: { count: record(body.agentNotes) && Number.isSafeInteger(body.agentNotes.count) && body.agentNotes.count >= 0 ? body.agentNotes.count : 0, ids: record(body.agentNotes) && Array.isArray(body.agentNotes.ids) ? body.agentNotes.ids.slice(0, 20000).filter(memoryId) : [] },
    graph: Array.isArray(body.graph) ? body.graph.slice(0, 500).filter(g => record(g) && memoryId(g.id)).map(g => ({ id: g.id, name: clip(g.name, 200), aliases: Array.isArray(g.aliases) ? g.aliases.slice(0, 50).map(a => clip(a, 200)) : [], links: Number.isSafeInteger(g.links) && g.links >= 0 ? g.links : 0 })) : [],
    handoffs: Array.isArray(body.handoffs) ? body.handoffs.slice(0, 2000).filter(h => record(h) && memoryId(h.id)).map(h => ({ id: h.id, agentId: clip(h.agentId, 128), scope: clip(h.scope, 200), createdAt: when(h.createdAt), lines: Array.isArray(h.lines) ? h.lines.slice(0, 50).map(l => clip(l, 2000)) : [] })) : [],
  };
}

const count = x => (Number.isSafeInteger(x) && x >= 0 ? x : 0);

export function personPathResponse(path, status, body) {
  const p = personPathOf(path);
  if (!p) fail();
  if (status !== 200) return { code: status === 404 ? 'not_found' : status === 400 ? 'invalid_request' : status === 403 ? 'forbidden' : 'unavailable', ...(status === 400 && record(body) && typeof body.error === 'string' ? { error: clip(body.error, 200) } : {}) };
  if (p.route === 'export') return personExportResponse(p.key, body);
  if (!record(body)) fail();
  return { drawer: count(body.drawer), mentions: count(body.mentions), graph: count(body.graph) };
}
