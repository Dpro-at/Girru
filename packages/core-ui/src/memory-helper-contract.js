// Wire contract for the memory helper (MODELS-01-INSTALL, boards M1–M6),
// shared by the browser client (session.ts) and the local bridge
// (application-server.cjs). The helper installs itself in the background;
// the page only reads its state and may ask for a try now.
//
//   GET   /api/memory/helper         { status, row }   (404 while GIRRU_MEMORY_HELPER is off)
//   POST  /api/memory/helper/retry   { started: true }
//
// Only codes, counts, model names and times pass back: no paths, no text from elsewhere.

export const MEMORY_HELPER_PATH = '/api/memory/helper';
export const MEMORY_HELPER_RETRY_PATH = '/api/memory/helper/retry';
export const HELPER_PHASES = ['waiting', 'checking', 'starting_runtime', 'downloading', 'verifying', 'reembedding', 'ready', 'fallback'];
const REASONS = ['hash_chosen', 'not_loopback', 'runtime_missing', 'runtime_not_running', 'download_failed', 'model_not_answering'];
const record = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const count = x => (Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
const when = x => (typeof x === 'string' && x.length <= 40 && Number.isFinite(Date.parse(x)) ? x : null);
const name = x => (typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(x) ? x : null);

export function memoryHelperRoute(path) { return path === MEMORY_HELPER_PATH || path === MEMORY_HELPER_RETRY_PATH; }
export function allowedMemoryHelper(method, path, body) {
  if (path === MEMORY_HELPER_PATH) return method === 'GET' && body === undefined;
  if (path === MEMORY_HELPER_RETRY_PATH) return method === 'POST' && body === undefined;
  return false;
}

/** The helper's state made safe for the page (unknown fields dropped). */
export function helperStatus(x) {
  const v = record(x) ? x : {};
  const phase = HELPER_PHASES.includes(v.phase) ? v.phase : 'waiting';
  const error = typeof v.error === 'string' && /^(network|stalled|disk_full|bad_response|not_found|http_\d{3})$/.test(v.error) ? v.error : null;
  const runtime = record(v.runtime) ? v.runtime : {};
  const worker = record(v.worker) && name(v.worker.model) ? { model: name(v.worker.model), phase: ['later', 'downloading', 'ready', 'fallback'].includes(v.worker.phase) ? v.worker.phase : 'later' } : null;
  return {
    enabled: v.enabled !== false, phase, reason: REASONS.includes(v.reason) ? v.reason : null, error,
    model: name(v.model) ?? '', completedBytes: count(v.completedBytes), sizeBytes: count(v.sizeBytes),
    percent: Number.isFinite(v.percent) ? Math.max(0, Math.min(100, Math.floor(v.percent))) : null,
    attempts: count(v.attempts), nextTryAt: when(v.nextTryAt), readyAt: when(v.readyAt), remaining: count(v.remaining),
    runtime: { installed: runtime.installed === true, running: runtime.running === true }, worker,
  };
}

export function memoryHelperResponse(path, status, body) {
  if (status !== 200) return { code: record(body) && typeof body.code === 'string' && /^[a-z_]{1,40}$/.test(body.code) ? body.code : 'unavailable' };
  const v = record(body) ? body : {};
  if (path === MEMORY_HELPER_RETRY_PATH) return { started: v.started === true };
  const row = record(v.row) ? v.row : {};
  return { status: helperStatus(v.status), row: { state: row.state === 'needs_you' ? 'needs_you' : 'ok' } };
}
