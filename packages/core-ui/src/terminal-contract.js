// Wire contract for the built-in terminal (CHAT-PANES-01), shared by the
// browser client (session.ts) and the local bridge (application-server.cjs).
// Owner only, loopback only; the backend keeps it off unless the operator
// turns it on.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const record = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const onlyKeys = (x, keys) => Object.keys(x).every(k => keys.includes(k));
const size = (x, min, max) => Number.isInteger(x) && x >= min && x <= max;

export const TERMINAL_INPUT_CHARS = 32_768;
/** A stream reader ends after this long; the page re-attaches with ?after=<seq>. */
export const TERMINAL_STREAM_MS = 10 * 60_000;
const FRAME_CHARS = 512 * 1024;

/** Which terminal route a path is, or null. */
export const TERMINAL_THEMES = ['dpro-night', 'dpro-day', 'graphite', 'midnight', 'ocean', 'forest', 'paper', 'contrast'];
export const TERMINAL_FONTS = ['system', 'sf-mono', 'menlo', 'monaco', 'jetbrains', 'fira', 'cascadia', 'courier'];
export const TERMINAL_CURSORS = ['block', 'bar', 'underline'];
export const DEFAULT_TERMINAL_PREFS = Object.freeze({ theme: 'dpro-night', fontFamily: 'system', fontSize: 12, lineHeight: 1.2, letterSpacing: 0, cursorStyle: 'block', cursorBlink: true, scrollback: 5000, copyOnSelect: false });
const inRange = (x, min, max) => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
/** One terminal setting: true when the key is known and the value allowed. */
export function terminalPrefOk(k, v) {
  switch (k) {
    case 'theme': return TERMINAL_THEMES.includes(v);
    case 'fontFamily': return TERMINAL_FONTS.includes(v);
    case 'cursorStyle': return TERMINAL_CURSORS.includes(v);
    case 'fontSize': return Number.isInteger(v) && inRange(v, 9, 24);
    case 'lineHeight': return inRange(v, 1, 1.8);
    case 'letterSpacing': return inRange(v, 0, 3);
    case 'scrollback': return Number.isInteger(v) && inRange(v, 1000, 50000);
    case 'cursorBlink': case 'copyOnSelect': return typeof v === 'boolean';
  }
  return false;
}
/** Known settings only; anything else falls back to the default. */
export function terminalPrefs(x) {
  const out = { ...DEFAULT_TERMINAL_PREFS };
  if (record(x)) for (const k of Object.keys(out)) if (terminalPrefOk(k, x[k])) out[k] = x[k];
  return out;
}

export function terminalPath(path) {
  if (path === '/api/terminal') return { kind: 'info' };
  if (path === '/api/terminal/prefs') return { kind: 'prefs' };
  if (path === '/api/terminal/sessions') return { kind: 'create' };
  let m = /^\/api\/terminal\/sessions\/([^/?#]+)$/.exec(path);
  if (m) return ID.test(m[1]) ? { kind: 'close', id: m[1] } : null;
  m = /^\/api\/terminal\/sessions\/([^/?#]+)\/(input|resize|stop)$/.exec(path);
  if (m) return ID.test(m[1]) ? { kind: m[2], id: m[1] } : null;
  m = /^\/api\/terminal\/sessions\/([^/?#]+)\/stream(?:\?after=(0|[1-9]\d{0,12}))?$/.exec(path);
  if (m) return ID.test(m[1]) ? { kind: 'stream', id: m[1], after: Number(m[2] ?? 0) } : null;
  return null;
}
export function terminalRoute(path) { return terminalPath(path) !== null; }

export function allowedTerminal(method, path, body) {
  const p = terminalPath(path);
  if (!p) return false;
  switch (p.kind) {
    case 'info': case 'stream': return method === 'GET' && body === undefined;
    case 'prefs': return (method === 'GET' && body === undefined) || (method === 'PUT' && record(body) && Object.keys(body).length > 0 && Object.entries(body).every(([k, v]) => terminalPrefOk(k, v)));
    case 'create': return method === 'POST' && record(body) && onlyKeys(body, ['cols', 'rows', 'projectId', 'command'])
      && (body.command === undefined || (typeof body.command === 'string' && !!body.command.trim() && body.command.length <= 16000 && !body.command.includes('\0')))
      && (body.cols === undefined || size(body.cols, 10, 500)) && (body.rows === undefined || size(body.rows, 2, 200)) && (body.projectId === undefined || (typeof body.projectId === 'string' && ID.test(body.projectId)));
    case 'stop': return method === 'POST' && body === undefined;
    case 'input': return method === 'POST' && record(body) && onlyKeys(body, ['data']) && typeof body.data === 'string' && body.data.length > 0 && body.data.length <= TERMINAL_INPUT_CHARS;
    case 'resize': return method === 'POST' && record(body) && onlyKeys(body, ['cols', 'rows']) && size(body.cols, 10, 500) && size(body.rows, 2, 200);
    case 'close': return method === 'DELETE' && body === undefined;
  }
  return false;
}

const ERRORS = { 400: ['invalid'], 403: ['disabled', 'not_loopback', 'forbidden'], 404: ['not_found'], 409: ['closed'], 429: ['limit'] };

/** Reviewed fields only (stable when applied twice). 204 answers become { ok: true }. */
export function terminalResponse(path, status, body) {
  const p = terminalPath(path);
  if (!p) throw Error('protocol');
  if (status === 204) return { ok: true };
  if (status !== 200 && status !== 201) { const code = record(body) ? body.code : undefined; return (ERRORS[status] ?? []).includes(code) ? { code } : null; }
  if (!record(body)) throw Error('protocol');
  if (p.kind === 'prefs') return { prefs: terminalPrefs(body.prefs) };
  if (p.kind === 'info') return { enabled: body.enabled === true, sessions: Array.isArray(body.sessions) ? body.sessions.filter(s => record(s) && typeof s.id === 'string' && ID.test(s.id)).slice(0, 20).map(s => ({ id: s.id, exited: s.exited === true })) : [] };
  if (p.kind === 'create') {
    if (typeof body.id !== 'string' || !ID.test(body.id)) throw Error('protocol');
    return { id: body.id, cols: size(body.cols, 10, 500) ? body.cols : 80, rows: size(body.rows, 2, 200) ? body.rows : 24,
      shell: typeof body.shell === 'string' ? body.shell.split(/[\\/]/).pop().slice(0, 40) : '', cwd: typeof body.cwd === 'string' ? body.cwd.slice(0, 1024) : '' };
  }
  if (p.kind === 'resize') return { cols: size(body.cols, 10, 500) ? body.cols : 80, rows: size(body.rows, 2, 200) ? body.rows : 24 };
  if (body.ok === true) return { ok: true };
  throw Error('protocol');
}

/**
 * Terminal stream frames: the backend's `event: output|exit` blocks become
 * `{ type: 'output', seq, data }` / `{ type: 'exit', exitCode }`; the bridge's
 * own `data: <frame>` blocks parse the same way. Duplicates (seq ≤ last) drop.
 */
export class TerminalEventParser {
  constructor(after = 0) { this.last = after; this.decoder = new TextDecoder('utf-8', { fatal: true }); this.line = ''; this.event = ''; this.data = []; this.size = 0; this.cr = false; this.ended = false; }
  push(bytes) { return this.consume(this.decoder.decode(bytes, { stream: true })); }
  consume(chunk) {
    const out = [];
    for (const ch of chunk) {
      if (this.cr) { this.cr = false; if (ch === '\n') continue; }
      if (ch === '\r' || ch === '\n') {
        if (this.line === '') {
          if (this.data.length) {
            const frame = projectTerminalFrame(this.event, JSON.parse(this.data.join('\n')));
            this.data = []; this.size = 0; this.event = '';
            if (frame && (frame.type === 'exit' || frame.seq > this.last)) {
              if (this.ended) throw Error('protocol');
              if (frame.type === 'output') this.last = frame.seq; else this.ended = true;
              out.push(frame);
            }
          }
          this.event = '';
        } else if (this.line.startsWith('data:')) this.data.push(this.line.slice(5).replace(/^ /, ''));
        else if (this.line.startsWith('event:')) this.event = this.line.slice(6).trim();
        this.line = ''; this.cr = ch === '\r';
      } else {
        this.line += ch;
        if (++this.size > FRAME_CHARS) throw Error('limit');
      }
    }
    return out;
  }
  finish() { this.consume(this.decoder.decode()); }
}

function projectTerminalFrame(event, x) {
  if (!record(x)) return null;
  const type = event || x.type;
  if (type === 'output' && Number.isSafeInteger(x.seq) && x.seq > 0 && typeof x.data === 'string') return { type: 'output', seq: x.seq, data: x.data };
  if (type === 'exit') return { type: 'exit', exitCode: Number.isInteger(x.exitCode) ? x.exitCode : -1, ...(Number.isInteger(x.signal) && x.signal > 0 && x.signal <= 255 ? { signal: x.signal } : {}) };
  return null;
}
