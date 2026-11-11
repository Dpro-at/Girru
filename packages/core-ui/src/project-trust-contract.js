// Wire contract for outside projects (REPO-TRUST-01, board R1), shared by the
// browser client (session.ts) and the local bridge (application-server.cjs).
//
//   GET     /api/memory/project-trust                 { projects, owners }
//   PUT     /api/memory/project-trust/projects/:id    { outside: boolean }   the owner's choice (kept)
//   DELETE  /api/memory/project-trust/projects/:id    (no body) the folder decides again (Undo of a choice)
//   POST    /api/memory/project-trust/owners          { name, host? }        count an account as the owner's
//   DELETE  /api/memory/project-trust/owners          { name, host? }
//
// Owner only. Ids, names, verdicts and account names only.

export const PROJECT_TRUST_PATH = '/api/memory/project-trust';
export const TRUST_OWNERS_PATH = '/api/memory/project-trust/owners';
export const trustProjectPath = id => `/api/memory/project-trust/projects/${encodeURIComponent(id)}`;

const record = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const only = (b, keys) => record(b) && Object.keys(b).every(k => keys.includes(k));
const projectId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x);
const account = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,4}$/.test(x) && !x.includes('..');
const host = x => x === undefined || (typeof x === 'string' && /^$|^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(x));
// eslint-disable-next-line no-control-regex
const badChars = /[\u0000-\u001F\u007F‪-‮⁦-⁩]/u;
const str = (x, n) => (typeof x === 'string' && !badChars.test(x) ? x.slice(0, n) : '');
const PROJECT = /^\/api\/memory\/project-trust\/projects\/([^/?#]+)$/;

export function projectTrustRoute(path) {
  return path === PROJECT_TRUST_PATH || path === TRUST_OWNERS_PATH || (PROJECT.test(path) && projectId(decodeURIComponent(PROJECT.exec(path)[1])));
}
export function allowedProjectTrust(method, path, body) {
  if (path === PROJECT_TRUST_PATH) return method === 'GET' && body === undefined;
  if (path === TRUST_OWNERS_PATH) return (method === 'POST' || method === 'DELETE') && only(body, ['name', 'host']) && account(body.name) && host(body.host);
  if (!PROJECT.test(path) || !projectId(decodeURIComponent(PROJECT.exec(path)[1]))) return false;
  if (method === 'PUT') return only(body, ['outside']) && typeof body.outside === 'boolean';
  return method === 'DELETE' && body === undefined;
}

const verdict = v => (record(v) && projectId(v.projectId) ? {
  projectId: v.projectId, outside: v.outside === true, source: ['auto', 'owner', 'none'].includes(v.source) ? v.source : 'none',
  remote: record(v.remote) && typeof v.remote.owner === 'string' ? { host: str(v.remote.host, 253), owner: str(v.remote.owner, 500) } : null,
  ...(typeof v.name === 'string' ? { name: str(v.name, 120) || 'Project' } : {}),
} : null);

export function projectTrustResponse(path, status, body) {
  if (status !== 200) return { code: record(body) && typeof body.code === 'string' && /^[a-z_]{1,40}$/.test(body.code) ? body.code : 'unavailable' };
  const v = record(body) ? body : {};
  if (path === TRUST_OWNERS_PATH) return { ok: v.ok === true };
  if (path !== PROJECT_TRUST_PATH) return { project: verdict(v.project) };
  return {
    projects: Array.isArray(v.projects) ? v.projects.slice(0, 1000).map(verdict).filter(Boolean) : [],
    owners: Array.isArray(v.owners) ? v.owners.slice(0, 100).filter(o => record(o) && account(o.name)).map(o => ({ name: o.name, host: str(o.host, 253), builtIn: o.builtIn === true })) : [],
  };
}
