// Wire contract for Agent page › Files (AGENT-FILES-01), shared by the browser
// client (session.ts) and the local bridge (application-server.cjs).
//   GET  /api/agents/:id/library
//   GET  /api/agents/:id/library/file?name=        PUT/POST …/library/file
//   POST /api/agents/:id/library/remove | /restore | /read
//   GET  /api/agents/:id/library/versions?name=    GET …/library/version?name=&id=
import { validAgentId } from './agent-id.js';

const record = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const only = (b, keys) => record(b) && Object.keys(b).every(k => keys.includes(k));
export const LIBRARY_BYTES = 1024 * 1024;
/** KNOW-INDEX-01: a Knowledge PDF is sent as base64 (10 MB of PDF at most). */
export const LIBRARY_PDF_BASE64 = Math.ceil((10 * 1024 * 1024) / 3) * 4 + 4096;
const isPdf = x => typeof x === 'string' && /\.pdf$/i.test(x);
const base64 = (x, n) => typeof x === 'string' && x.length > 0 && x.length <= n && /^[A-Za-z0-9+/=\s]+$/.test(x);
/** Who it is, What it keeps in mind, or a Knowledge text file (.md .txt .csv .json). */
export const fileName = x => typeof x === 'string' && (x === 'PERSONALITY.md' || x === 'MEMORY.md' || (/^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,78}\.(md|txt|csv|json|pdf)$/i.test(x) && !x.includes('..') && !/^(personality|memory)\.md$/i.test(x)));
const versionId = x => typeof x === 'string' && /^\d{1,16}-[a-f0-9]{8}$/.test(x);
const hash = x => x === null || (typeof x === 'string' && /^[a-f0-9]{64}$/.test(x));
const text = (x, n) => typeof x === 'string' && x.length <= n;
export const libraryPath = (id, part = '', query) => `/api/agents/${encodeURIComponent(id)}/library${part}${query ? '?' + new URLSearchParams(query).toString() : ''}`;

export function libraryRoute(path) { return parse(path) !== null; }
function parse(path) {
  const [base, search = ''] = String(path).split('?');
  const m = /^\/api\/agents\/([^/?#]+)\/library(?:\/(file|remove|restore|read|versions|version))?$/.exec(base);
  if (!m || !validAgentId(decodeURIComponent(m[1]))) return null;
  const q = new URLSearchParams(search), keys = [...q.keys()];
  const part = m[2] ?? 'list';
  return { id: decodeURIComponent(m[1]), part, q, keys };
}
export function allowedLibrary(method, path, body) {
  const p = parse(path);
  if (!p) return false;
  const { part, q, keys } = p;
  const noQuery = keys.length === 0;
  if (part === 'list') return method === 'GET' && body === undefined && noQuery;
  if (part === 'file' && method === 'GET') return body === undefined && keys.length === 1 && fileName(q.get('name'));
  if (part === 'file' && method === 'PUT') return noQuery && only(body, ['name', 'content', 'expectedHash']) && fileName(body.name) && !isPdf(body.name) && text(body.content, LIBRARY_BYTES) && 'expectedHash' in body && hash(body.expectedHash);
  if (part === 'file' && method === 'POST') return noQuery && only(body, ['name', 'content', 'read']) && fileName(body.name) && !['PERSONALITY.md', 'MEMORY.md'].includes(body.name) && (isPdf(body.name) ? base64(body.content, LIBRARY_PDF_BASE64) : text(body.content, LIBRARY_BYTES)) && (body.read === undefined || typeof body.read === 'boolean');
  if (part === 'remove') return method === 'POST' && noQuery && only(body, ['name']) && fileName(body.name);
  if (part === 'restore') return method === 'POST' && noQuery && only(body, ['id']) && versionId(body.id);
  if (part === 'read') return method === 'POST' && noQuery && only(body, ['name', 'read']) && fileName(body.name) && typeof body.read === 'boolean';
  if (part === 'versions') return method === 'GET' && body === undefined && keys.length === 1 && fileName(q.get('name'));
  if (part === 'version') return method === 'GET' && body === undefined && keys.length === 2 && fileName(q.get('name')) && versionId(q.get('id'));
  return false;
}
const KINDS = ['who', 'mind', 'knowledge'];
const CODES = ['read_only', 'not_pdf', 'invalid_name', 'invalid_content', 'invalid_version', 'invalid_input', 'invalid_id', 'not_found', 'changed', 'too_large', 'too_many', 'name_taken', 'not_removable', 'files_unavailable'];
/** Only what the Files part shows passes back to the page. */
export function libraryResponse(path, status, body) {
  const p = parse(path);
  if (!p) throw Error('protocol');
  if (status !== 200 && status !== 201) return { code: record(body) && CODES.includes(body.code) ? body.code : status === 403 ? 'forbidden' : 'unavailable' };
  if (!record(body)) throw Error('protocol');
  switch (p.part) {
    case 'list':
      if (!Array.isArray(body.files) || body.files.length > 210 || !Array.isArray(body.removed) || body.removed.length > 500) throw Error('protocol');
      return { files: body.files.filter(f => record(f) && fileName(f.name) && KINDS.includes(f.kind)).map(f => ({ name: f.name, kind: f.kind, size: Number.isSafeInteger(f.size) ? f.size : 0, read: f.read === true })),
        removed: body.removed.filter(r => record(r) && versionId(r.id) && fileName(r.name)).map(r => ({ id: r.id, name: r.name, removedAt: text(r.removedAt, 40) ? r.removedAt : null })) };
    case 'file':
      if (status === 201 || 'content' in body === false) { if (!hash(body.hash ?? null)) throw Error('protocol'); return { hash: body.hash ?? null, redacted: body.redacted === true, ...(Number.isSafeInteger(body.version) ? { version: body.version } : {}) }; }
      if (!fileName(body.name) || !KINDS.includes(body.kind) || !text(body.content, LIBRARY_BYTES + 1024) || !hash(body.hash)) throw Error('protocol');
      // STORE-MAP-01 P4: Who it is names the personality version it shows.
      return { name: body.name, kind: body.kind, content: body.content, hash: body.hash, managed: text(body.managed, 20000) ? body.managed : null, redacted: body.redacted === true, read: body.read !== false, ...(Number.isSafeInteger(body.version) ? { version: body.version } : {}),
        // KNOW-INDEX-01: a PDF shows its text read only; `unreadable` says why there is none.
        ...(body.readOnly === true ? { readOnly: true } : {}), ...(typeof body.unreadable === 'string' && /^[a-z_]{1,20}$/.test(body.unreadable) ? { unreadable: body.unreadable } : {}) };
    case 'remove': if (!versionId(body.id)) throw Error('protocol'); return { id: body.id };
    case 'restore': if (!fileName(body.name)) throw Error('protocol'); return { name: body.name };
    case 'read': return { name: fileName(body.name) ? body.name : null, read: body.read === true };
    case 'versions': if (!Array.isArray(body.versions) || body.versions.length > 40) throw Error('protocol'); return { versions: body.versions.filter(v => record(v) && versionId(v.id)).map(v => ({ id: v.id, savedAt: text(v.savedAt, 40) ? v.savedAt : null, size: Number.isSafeInteger(v.size) ? v.size : 0 })) };
    case 'version': if (!text(body.content, LIBRARY_BYTES + 1024)) throw Error('protocol'); return { content: body.content };
  }
  throw Error('protocol');
}
