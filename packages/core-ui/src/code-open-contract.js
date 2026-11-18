// CODE-OPEN-01 wire contract: "Open in Code" asks the backend whether a file may
// open (inside one of the owner's projects or Girru's data folder, real path,
// no links). Shared by the browser client (session.ts) and the local bridge
// (application-server.cjs).
//
//   POST  /api/code-open   { path, line? } -> { folder, file, path, line, generated, where, project }

const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
// eslint-disable-next-line no-control-regex
const control = /[\u0000-\u001F\u007F]/;
const absolute = x => typeof x === 'string' && x.length > 0 && x.length <= 4096 && !control.test(x) && (x.startsWith('/') || /^[A-Za-z]:[\\/]/.test(x));
const relative = x => typeof x === 'string' && x.length > 0 && x.length <= 4096 && !control.test(x) && !x.startsWith('/') && !/^[A-Za-z]:/.test(x) && !x.split(/[\\/]/).includes('..');
const fail = () => { throw Error('Invalid code open response'); };

export const CODE_OPEN_PATH = '/api/code-open';
export const MAX_LINE = 10000000;
const line = x => (Number.isSafeInteger(x) && x >= 1 && x <= MAX_LINE ? x : null);

export function codeOpenRoute(path) { return path === CODE_OPEN_PATH; }
export function allowedCodeOpen(method, path, body) {
  if (!codeOpenRoute(path) || method !== 'POST' || !record(body) || !absolute(body.path)) return false;
  if (Object.keys(body).some(k => k !== 'path' && k !== 'line')) return false;
  return body.line === undefined || line(body.line) !== null;
}
export function codeOpenResponse(status, body) {
  if (status !== 200) {
    const code = record(body) && ['invalid', 'outside', 'not_found', 'not_allowed'].includes(body.code) ? body.code : status === 403 ? 'outside' : 'unavailable';
    return { code };
  }
  if (!record(body) || !absolute(body.folder) || !relative(body.file) || !absolute(body.path)) fail();
  return {
    folder: body.folder, file: body.file, path: body.path, line: line(body.line), generated: body.generated === true,
    where: body.where === 'data' ? 'data' : 'project', project: typeof body.project === 'string' ? body.project.slice(0, 200) : null,
  };
}
