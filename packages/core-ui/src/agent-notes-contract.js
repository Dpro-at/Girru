// Wire contract for STORE-MAP-01 P5 (boards P5a–P5c, approved 2026-11-03),
// shared by the browser client (session.ts) and the local bridge
// (application-server.cjs). Owner only; the server answers 404 while
// GIRRU_STORE_P5 is off, and the pages then show nothing new.
//   GET  /api/agents/:id/memory/status       { imported, versions, outsideChange }
//   GET  /api/agents/:id/memory              { content, hash }  (the agent's own notes)
//   PUT  /api/agents/:id/memory              { content, expectedHash } → { content, hash, redacted }
//   GET  /api/agents/:id/memory/history      { versions: [{ version, change, createdAt, by, reason, content }] }
//   GET  /api/agents/:id/memory/outside      { outside: { file, fileHash, notes, notesHash } | null }
//   POST /api/agents/:id/memory/outside      { pick: 'use' | 'keep', fileHash } → { hash, previousHash }
//   GET  /api/agent-packages/status          { on: true }
//   GET  /api/agents/:id/package             the package (JSON)
//   POST /api/agent-packages/preview         { package } → the plan
//   POST /api/agent-packages/import          { package, expectedPackageHash, again? } → { agentId, refused, missing }
import { validAgentId } from './agent-id.js';

const record = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const only = (b, keys) => record(b) && Object.keys(b).every(k => keys.includes(k));
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const text = (x, n) => typeof x === 'string' && x.length <= n;
const str = (x, n) => (typeof x === 'string' ? x.slice(0, n) : '');
export const NOTES_BYTES = 32768;
export const PACKAGE_BYTES = 4 * 1024 * 1024;
export const PACKAGES_STATUS_PATH = '/api/agent-packages/status';
export const notesPath = (id, part = '') => `/api/agents/${encodeURIComponent(id)}/memory${part}`;
export const packagePath = id => `/api/agents/${encodeURIComponent(id)}/package`;

function parse(path) {
  if (path === PACKAGES_STATUS_PATH) return { part: 'packages-status' };
  if (path === '/api/agent-packages/preview') return { part: 'preview' };
  if (path === '/api/agent-packages/import') return { part: 'import' };
  const m = /^\/api\/agents\/([^/?#]+)\/(memory(?:\/(status|history|outside))?|package)$/.exec(String(path));
  if (!m || !validAgentId(decodeURIComponent(m[1]))) return null;
  return { id: decodeURIComponent(m[1]), part: m[2] === 'package' ? 'package' : m[3] ?? 'notes' };
}
export function notesRoute(path) { return parse(path) !== null; }
const packageBody = x => record(x) && JSON.stringify(x).length <= PACKAGE_BYTES;
export function allowedNotes(method, path, body) {
  const p = parse(path);
  if (!p) return false;
  const get = method === 'GET' && body === undefined;
  switch (p.part) {
    case 'packages-status': case 'status': case 'history': case 'package': return get;
    case 'notes': return get || (method === 'PUT' && only(body, ['content', 'expectedHash']) && text(body.content, NOTES_BYTES) && hash(body.expectedHash));
    case 'outside': return get || (method === 'POST' && only(body, ['pick', 'fileHash']) && ['use', 'keep'].includes(body.pick) && hash(body.fileHash));
    case 'preview': return method === 'POST' && only(body, ['package']) && packageBody(body.package);
    case 'import': return method === 'POST' && only(body, ['package', 'expectedPackageHash', 'again']) && packageBody(body.package) && hash(body.expectedPackageHash) && (body.again === undefined || typeof body.again === 'boolean');
  }
  return false;
}
const CODES = ['not_found', 'changed', 'no_outside_change', 'memory_not_written', 'memory_unavailable', 'memory_review_required', 'invalid_memory_request', 'invalid_agent',
  'invalid_package', 'not_an_agent_package', 'schema_version', 'newer_package', 'hash_mismatch', 'secret_found', 'preview_changed', 'already_imported', 'too_large', 'too_many_files'];
const names = (xs, keys) => (Array.isArray(xs) ? xs.slice(0, 200).filter(record).map(x => Object.fromEntries(keys.map(k => [k, str(x[k], 300)]))) : []);
/** Only what the P5 pages show passes back. */
export function notesResponse(path, status, body) {
  const p = parse(path);
  if (!p) throw Error('protocol');
  if (status !== 200) return { code: record(body) && CODES.includes(body.code) ? body.code : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : 'unavailable' };
  if (!record(body)) throw Error('protocol');
  switch (p.part) {
    case 'packages-status': return { on: body.on === true };
    case 'status': return { imported: body.imported === true, versions: Number.isSafeInteger(body.versions) ? body.versions : 0, outsideChange: body.outsideChange === true };
    case 'notes':
      if (!text(body.content, NOTES_BYTES + 1024) || !(body.hash === null || hash(body.hash))) throw Error('protocol');
      return { content: body.content, hash: body.hash, redacted: body.redacted === true };
    case 'history':
      if (!Array.isArray(body.versions)) throw Error('protocol');
      return { versions: body.versions.slice(0, 40).filter(v => record(v) && Number.isSafeInteger(v.version)).map(v => ({ version: v.version, change: str(v.change, 20), createdAt: str(v.createdAt, 40), by: str(v.by, 80), reason: text(v.reason, 200) ? v.reason : null, content: text(v.content, NOTES_BYTES + 1024) ? v.content : null })) };
    case 'outside':
      if ('outside' in body) {
        const o = body.outside;
        if (o === null) return { outside: null };
        if (!record(o) || !text(o.file, NOTES_BYTES * 4) || !text(o.notes, NOTES_BYTES + 1024) || !hash(o.fileHash) || !hash(o.notesHash)) throw Error('protocol');
        return { outside: { file: o.file, fileHash: o.fileHash, notes: o.notes, notesHash: o.notesHash } };
      }
      if (!hash(body.hash) || !hash(body.previousHash)) throw Error('protocol');
      return { hash: body.hash, previousHash: body.previousHash };
    case 'package': if (!packageBody(body)) throw Error('protocol'); return body;
    case 'preview':
      if (!hash(body.packageHash) || !record(body.agent)) throw Error('protocol');
      return { packageHash: body.packageHash, schemaVersion: Number.isSafeInteger(body.schemaVersion) ? body.schemaVersion : 1, alreadyImported: text(body.alreadyImported, 128) ? body.alreadyImported : null,
        agent: { name: str(body.agent.name, 120), description: str(body.agent.description, 1000), emoji: str(body.agent.emoji, 16) },
        instructions: str(body.instructions, 4000), personality: { text: str(record(body.personality) ? body.personality.text : '', 2000) },
        specialties: names(body.specialties, ['name']), skills: names(body.skills, ['name']),
        knowledge: Array.isArray(body.knowledge) ? body.knowledge.slice(0, 200).filter(record).map(k => ({ name: str(k.name, 120), bytes: Number.isSafeInteger(k.bytes) ? k.bytes : 0, read: k.read !== false })) : [],
        refused: names(body.refused, ['field', 'why']), missing: names(body.missing, ['kind', 'name']) };
    case 'import':
      if (!validAgentId(body.agentId)) throw Error('protocol');
      return { agentId: body.agentId, refused: names(body.refused, ['field', 'why']), missing: names(body.missing, ['kind', 'name']) };
  }
  throw Error('protocol');
}
