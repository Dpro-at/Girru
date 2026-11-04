// Wire contract for document memory (KNOW-INDEX-01, board K1), shared by the
// browser client (session.ts) and the local bridge (application-server.cjs).
//
//   GET   /api/memory/documents                       projects (switch, my project, folders, status, files that can't be read) + agents
//   PUT   /api/memory/documents/sources               { kind: 'project', refId, enabled }
//   POST  /api/memory/documents/sources/:id/reindex   (no body) look again now
//   POST  /api/memory/documents/read-pdf              { data: base64 } → { text } | { reason }   (a PDF a chat attaches)
//
// Owner only. Paths shown are the owner's own folders; no file text passes except a PDF's text the owner sent.

export const DOCUMENTS_PATH = '/api/memory/documents';
export const DOCUMENT_SOURCES_PATH = '/api/memory/documents/sources';
export const READ_PDF_PATH = '/api/memory/documents/read-pdf';
export const reindexPath = id => `/api/memory/documents/sources/${id}/reindex`;
/** 10 MB of PDF as base64. */
export const READ_PDF_BASE64 = Math.ceil((10 * 1024 * 1024) / 3) * 4 + 4096;
export const DOC_STATES = ['pending', 'running', 'ready', 'error'];
export const PDF_REASONS = ['not_pdf', 'encrypted', 'no_text', 'fonts', 'damaged', 'too_large', 'encoding', 'binary', 'unreadable'];

const record = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const only = (b, keys) => record(b) && Object.keys(b).every(k => keys.includes(k));
const sourceId = x => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x);
const projectId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x);
// eslint-disable-next-line no-control-regex
const badChars = /[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/u;
const str = (x, n) => (typeof x === 'string' && !badChars.test(x) ? x.slice(0, n) : '');
const count = x => (Number.isSafeInteger(Number(x)) && Number(x) >= 0 ? Number(x) : 0);
const when = x => (typeof x === 'string' && x.length <= 40 && Number.isFinite(Date.parse(x)) ? x : null);

export function docIndexRoute(path) {
  return path === DOCUMENTS_PATH || path === DOCUMENT_SOURCES_PATH || path === READ_PDF_PATH || /^\/api\/memory\/documents\/sources\/[0-9a-f]{32}\/reindex$/.test(path);
}
export function allowedDocIndex(method, path, body) {
  if (path === DOCUMENTS_PATH) return method === 'GET' && body === undefined;
  if (path === DOCUMENT_SOURCES_PATH) return method === 'PUT' && only(body, ['kind', 'refId', 'enabled']) && body.kind === 'project' && projectId(body.refId) && typeof body.enabled === 'boolean';
  if (path === READ_PDF_PATH) return method === 'POST' && only(body, ['data']) && typeof body.data === 'string' && body.data.length > 0 && body.data.length <= READ_PDF_BASE64 && /^[A-Za-z0-9+/=\s]+$/.test(body.data);
  return /^\/api\/memory\/documents\/sources\/[0-9a-f]{32}\/reindex$/.test(path) && method === 'POST' && body === undefined;
}

const unreadable = list => (Array.isArray(list) ? list.slice(0, 50).filter(u => record(u) && typeof u.file === 'string').map(u => ({ file: str(u.file, 300), reason: PDF_REASONS.includes(u.reason) ? u.reason : 'unreadable' })) : []);
function source(s) {
  if (!record(s) || !sourceId(s.id)) return null;
  return {
    id: s.id, enabled: s.enabled === true, state: DOC_STATES.includes(s.state) ? s.state : 'pending', files: count(s.files), chunks: count(s.chunks),
    unreadable: unreadable(s.unreadable), limited: s.limited === true, note: typeof s.note === 'string' && /^[a-z_]{1,30}$/.test(s.note) ? s.note : null, scannedAt: when(s.scannedAt),
  };
}

export function docIndexResponse(path, status, body) {
  if (status !== 200 && status !== 202) return { code: record(body) && typeof body.code === 'string' && /^[a-z_]{1,40}$/.test(body.code) ? body.code : 'unavailable' };
  const v = record(body) ? body : {};
  if (path === READ_PDF_PATH) return typeof v.text === 'string' ? { text: v.text.slice(0, 200000) } : { reason: PDF_REASONS.includes(v.reason) ? v.reason : 'unreadable' };
  if (path === DOCUMENT_SOURCES_PATH) return { source: record(v.source) && sourceId(v.source.id) ? { id: v.source.id, enabled: v.source.enabled === true, state: DOC_STATES.includes(v.source.state) ? v.source.state : 'pending' } : null };
  if (path !== DOCUMENTS_PATH) return { queued: v.queued === true };
  const projects = Array.isArray(v.projects) ? v.projects.slice(0, 500).filter(p => record(p) && projectId(p.id)).map(p => ({
    id: p.id, name: str(p.name, 120) || 'Project', mine: p.mine === true, hasFolder: p.hasFolder === true, source: source(p.source),
    folders: Array.isArray(p.folders) ? p.folders.slice(0, 9).filter(f => record(f) && typeof f.path === 'string').map(f => ({ path: str(f.path, 2048), name: str(f.name, 200), main: f.main === true, files: count(f.files) })) : [],
  })) : [];
  const a = record(v.agents) ? v.agents : {};
  return { projects, agents: { sources: count(a.sources), files: count(a.files), unreadable: unreadable(a.unreadable), state: ['running', 'ready'].includes(a.state) ? a.state : null } };
}
