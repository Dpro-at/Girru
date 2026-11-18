// STORE-MAP-01 P9b screens wire contract (boards P9b-1 to P9b-3): how sure a
// memory is, the memories corrected after use and the open questions. Shared
// by the browser client (session.ts) and the local bridge
// (application-server.cjs). The backend registers these routes only while its
// P9b switch is on; otherwise they answer 404 and the window shows nothing new.
//
//   GET   /api/memory/trust?ids=a,b               { items: TrustView[] }
//   POST  /api/memory/trust/:id/verify|unverify   { item: TrustView }
//   GET   /api/memory/trust-waiting               { corrected, questions }
//   GET   /api/memory/corrected                   { items: CorrectedItem[] }
//   POST  /api/memory/corrected/:id               { checked } -> { memoryId, checked }
//   GET   /api/memory/open-questions              { items: OpenQuestion[] }
//   POST  /api/memory/open-questions/:id/answer   { text, drawer? } -> { question, memoryId }
//   POST  /api/memory/open-questions/:id/forget   -> { id, undo }
//   POST  /api/memory/open-questions/:id/restore  -> { question }

const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
const id = x => typeof x === 'string' && /^[A-Za-z0-9_.@:-]{1,200}$/.test(x) && !x.includes('..');
const drawerId = x => typeof x === 'string' && x.length <= 150 && /^[a-z]+(:[A-Za-z0-9][A-Za-z0-9_.@-]{0,127})?$/.test(x) && !x.includes('..');
// eslint-disable-next-line no-control-regex
const badChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/gu;
const clip = (x, max) => (typeof x === 'string' ? x.replace(badChars, '').slice(0, max) : '');
const when = x => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.test(x) && x.length <= 40 ? x : null);
const count = x => (Number.isSafeInteger(x) && x >= 0 ? x : 0);
const fail = () => { throw Error('Invalid memory trust response'); };

export const TRUST_LEVELS = ['verified', 'heard-once', 'not-checked'];
const KINDS = ['you', 'chat', 'agent', 'tool', 'import', 'channel', 'system'];
export const MAX_TRUST_IDS = 200;

export const trustPath = ids => `/api/memory/trust?ids=${ids.map(encodeURIComponent).join(',')}`;
export const verifyPath = (memoryId, undo = false) => `/api/memory/trust/${encodeURIComponent(memoryId)}/${undo ? 'unverify' : 'verify'}`;
export const TRUST_WAITING_PATH = '/api/memory/trust-waiting';
export const CORRECTED_PATH = '/api/memory/corrected';
export const correctedPath = memoryId => `${CORRECTED_PATH}/${encodeURIComponent(memoryId)}`;
export const QUESTIONS_PATH = '/api/memory/open-questions';
export const questionPath = (qid, action) => `${QUESTIONS_PATH}/${encodeURIComponent(qid)}/${action}`;

const segment = s => { try { const v = decodeURIComponent(s); return id(v) && encodeURIComponent(v) === s ? v : null; } catch { return null; } };

/** Which P9b screen route a path is, or null. */
export function trustPathOf(path) {
  if (typeof path !== 'string' || path.length > 12000 || path.includes('#')) return null;
  if (path === TRUST_WAITING_PATH) return { route: 'waiting' };
  if (path === CORRECTED_PATH) return { route: 'corrected' };
  if (path === QUESTIONS_PATH) return { route: 'questions' };
  let m = /^\/api\/memory\/trust\?ids=([^&]*)$/.exec(path);
  if (m) { const ids = m[1] ? m[1].split(',').map(segment) : []; return ids.length && ids.length <= MAX_TRUST_IDS && ids.every(Boolean) ? { route: 'trust', ids } : null; }
  if (path.includes('?')) return null;
  m = /^\/api\/memory\/trust\/([^/]+)\/(verify|unverify)$/.exec(path);
  if (m) { const v = segment(m[1]); return v ? { route: m[2], id: v } : null; }
  m = /^\/api\/memory\/corrected\/([^/]+)$/.exec(path);
  if (m) { const v = segment(m[1]); return v ? { route: 'check', id: v } : null; }
  m = /^\/api\/memory\/open-questions\/([^/]+)\/(answer|forget|restore)$/.exec(path);
  if (m) { const v = segment(m[1]); return v ? { route: m[2], id: v } : null; }
  return null;
}
export function trustRoute(path) { return trustPathOf(path) !== null; }
export function allowedTrust(method, path, body) {
  const p = trustPathOf(path);
  if (!p) return false;
  if (['trust', 'waiting', 'corrected', 'questions'].includes(p.route)) return method === 'GET' && body === undefined;
  if (method !== 'POST') return false;
  if (p.route === 'check') return record(body) && Object.keys(body).join() === 'checked' && typeof body.checked === 'boolean';
  if (p.route === 'answer') {
    if (!record(body) || Object.keys(body).some(k => k !== 'text' && k !== 'drawer')) return false;
    return typeof body.text === 'string' && body.text.trim().length > 0 && body.text.length <= 2000 && (body.drawer === undefined || drawerId(body.drawer));
  }
  return body === undefined || (record(body) && Object.keys(body).length === 0);
}

const trustView = x => (record(x) && id(x.id) && TRUST_LEVELS.includes(x.level) ? {
  id: x.id, level: x.level, byOwner: x.byOwner === true,
  heardFrom: Array.isArray(x.heardFrom) ? x.heardFrom.slice(0, 8).filter(h => record(h) && KINDS.includes(h.kind)).map(h => (h.agentId && id(h.agentId) ? { kind: h.kind, agentId: h.agentId } : { kind: h.kind })) : [],
  uses: count(x.uses), lastUsedAt: when(x.lastUsedAt),
} : null);
const reply = x => (record(x) && id(x.runId) ? { runId: x.runId, sessionId: id(x.sessionId) ? x.sessionId : null, title: typeof x.title === 'string' ? clip(x.title, 200) : null, agentId: id(x.agentId) ? x.agentId : null, at: when(x.at) ?? '' } : null);
const corrected = x => (record(x) && id(x.memoryId) && id(x.nowId) && drawerId(x.drawer) ? {
  memoryId: x.memoryId, nowId: x.nowId, drawer: x.drawer, was: clip(x.was, 2000), now: clip(x.now, 2000), changedAt: when(x.changedAt),
  how: x.how === 'replaced' ? 'replaced' : 'edited', checked: x.checked === true, replyCount: count(x.replyCount),
  replies: Array.isArray(x.replies) ? x.replies.slice(0, 20).map(reply).filter(Boolean) : [],
} : null);
const question = x => (record(x) && id(x.id) && ['open', 'resolved', 'expired'].includes(x.status) ? {
  id: x.id, question: clip(x.question, 300), agentId: id(x.agentId) ? x.agentId : null, status: x.status, askedAt: when(x.askedAt) ?? '', resolvedAt: when(x.resolvedAt),
  resolvedMemoryId: id(x.resolvedMemoryId) ? x.resolvedMemoryId : null, endsAt: when(x.endsAt) ?? '',
} : null);

export function trustPathResponse(path, status, body) {
  const p = trustPathOf(path);
  if (!p) fail();
  if (status !== 200) return { code: status === 404 ? 'not_found' : status === 400 ? 'invalid_request' : status === 409 ? 'not_open' : status === 410 ? 'gone' : status === 403 ? 'forbidden' : 'unavailable' };
  if (!record(body)) fail();
  switch (p.route) {
    case 'trust': return { items: Array.isArray(body.items) ? body.items.slice(0, MAX_TRUST_IDS).map(trustView).filter(Boolean) : fail() };
    case 'verify': case 'unverify': return { item: trustView(body.item) ?? fail() };
    case 'waiting': return { corrected: count(body.corrected), questions: count(body.questions) };
    case 'corrected': return { items: Array.isArray(body.items) ? body.items.slice(0, 200).map(corrected).filter(Boolean) : fail() };
    case 'check': return { memoryId: id(body.memoryId) ? body.memoryId : fail(), checked: body.checked === true };
    case 'questions': return { items: Array.isArray(body.items) ? body.items.slice(0, 200).map(question).filter(Boolean) : fail() };
    case 'answer': return { question: question(body.question) ?? fail(), memoryId: id(body.memoryId) ? body.memoryId : fail() };
    case 'forget': return { id: id(body.id) ? body.id : fail(), undo: body.undo === true };
    case 'restore': return { question: question(body.question) ?? fail() };
    default: return fail();
  }
}
