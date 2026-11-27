// Wire contract for Settings › Backups (BACKUP-01), shared by the browser client
// (session.ts) and the local bridge (application-server.cjs). Owner only on the server.
// Restore and delete are owner actions in the app; the MCP tool only reads and backs up.

const ID = /^\d{8}-\d{6}-(daily|manual|before-update|before-restore)$/;
const KINDS = ['daily', 'manual', 'before-update', 'before-restore'];
const record = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x, max) => typeof x === 'string' ? x.slice(0, max) : '';
const iso = x => typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? x : null;
const num = x => Number.isFinite(x) && x >= 0 ? x : 0;

const DEST_ID = /^[0-9a-f-]{36}$/i;
function parse(path) {
  if (path === '/api/backups') return { kind: 'list' };
  if (path === '/api/backups/folder') return { kind: 'folder' };
  if (path === '/api/backups/retention') return { kind: 'retention' };
  if (path === '/api/backups/destinations') return { kind: 'destinations' };
  const dm = /^\/api\/backups\/destinations\/([^/?#]+)(?:\/(push|test))?$/.exec(path);
  if (dm) return DEST_ID.test(dm[1]) ? { kind: 'dest-' + (dm[2] || 'one'), destId: dm[1] } : null;
  const m = /^\/api\/backups\/([^/?#]+)(?:\/(restore|show))?$/.exec(path);
  if (!m || !ID.test(m[1])) return null;
  return { kind: m[2] || 'one', id: m[1] };
}
export function backupsRoute(path) { return typeof path === 'string' && (path === '/api/backups' || path.startsWith('/api/backups/')); }
export function allowedBackups(method, path, body) {
  const r = parse(path);
  if (!r) return false;
  if (r.kind === 'list') {
    if (method === 'GET') return body === undefined;
    return method === 'POST' && record(body) && Object.keys(body).every(k => k === 'kind') && (body.kind === undefined || body.kind === 'manual' || body.kind === 'before-update');
  }
  if (r.kind === 'folder') return method === 'PUT' && record(body) && Object.keys(body).length === 1 && typeof body.folder === 'string' && body.folder.length > 0 && body.folder.length <= 1024;
  if (r.kind === 'retention') return method === 'PUT' && record(body) && Object.keys(body).length === 1 && Number.isInteger(body.keepDays) && body.keepDays >= 3 && body.keepDays <= 3650;
  if (r.kind === 'destinations') {
    if (method === 'GET') return body === undefined;
    return method === 'POST' && record(body) && Object.keys(body).every(k => k === 'type' || k === 'label' || k === 'folder')
      && typeof body.type === 'string' && body.type.length > 0 && body.type.length <= 16
      && (body.folder === undefined || (typeof body.folder === 'string' && body.folder.length > 0 && body.folder.length <= 1024))
      && (body.label === undefined || (typeof body.label === 'string' && body.label.length <= 120))
      // A folder place must carry its folder (the only kind the page can add today).
      && (body.type !== 'folder' || (typeof body.folder === 'string' && body.folder.length > 0));
  }
  if (r.kind === 'dest-test') return method === 'POST' && body === undefined;
  if (r.kind === 'dest-push') return method === 'POST' && (body === undefined || (record(body) && Object.keys(body).every(k => k === 'backupId') && (body.backupId === undefined || (typeof body.backupId === 'string' && ID.test(body.backupId)))));
  if (r.kind === 'dest-one') return method === 'DELETE' && body === undefined;
  if (r.kind === 'restore' || r.kind === 'show') return method === 'POST' && body === undefined;
  return method === 'DELETE' && body === undefined;
}

function backup(b) {
  const v = record(b) ? b : {};
  const p = record(v.parts) ? v.parts : {};
  return { id: ID.test(v.id) ? v.id : '', kind: KINDS.includes(v.kind) ? v.kind : 'manual', at: iso(v.at) ?? new Date(0).toISOString(), checked: v.checked === true, size: num(v.size),
    parts: { data: p.data === true, audit: p.audit === true, keys: p.keys === true }, keepUntil: iso(v.keepUntil) };
}
function status(s) {
  if (!record(s) || s.available !== true) return { available: false, reason: str(record(s) ? s.reason : '', 200) || 'Backups are not available' };
  const k = record(s.keeps) ? s.keeps : {};
  const e = record(s.lastError) ? s.lastError : null;
  const r = record(s.lastRestore) ? s.lastRestore : null;
  return {
    available: true, folder: str(s.folder, 1024), cloud: s.cloud === true, defaultFolder: str(s.defaultFolder, 1024), runsAt: /^\d\d:\d\d$/.test(s.runsAt) ? s.runsAt : '03:00',
    keeps: { days: num(k.days), sundays: num(k.sundays), beforeUpdateDays: num(k.beforeUpdateDays), min: num(k.min) || 3, max: num(k.max) || 3650, presets: Array.isArray(k.presets) ? k.presets.filter(Number.isInteger).slice(0, 8) : [] }, running: s.running === true,
    last: record(s.last) ? backup(s.last) : null, next: iso(s.next) ?? new Date(0).toISOString(),
    lastError: e ? { message: str(e.message, 300), at: iso(e.at) ?? new Date(0).toISOString() } : null,
    lastRestore: r ? { id: str(r.id, 64), at: iso(r.at) ?? new Date(0).toISOString(), ok: r.ok === true, ...(typeof r.error === 'string' ? { error: str(r.error, 300) } : {}) } : null,
    backups: Array.isArray(s.backups) ? s.backups.slice(0, 500).map(backup).filter(b => b.id) : [],
  };
}
const DEST_TYPES = ['folder', 'sftp', 'webdav', 's3'];
/** A backup place: its label and non-secret settings plus status — never any secret. */
function destination(d) {
  const v = record(d) ? d : {};
  const cfg = record(v.config) ? v.config : {};
  const s = record(v.status) ? v.status : {};
  return {
    id: str(v.id, 64), type: DEST_TYPES.includes(v.type) ? v.type : 'folder', label: str(v.label, 120),
    folder: str(cfg.folder, 1024), enabled: v.enabled === true, createdAt: iso(v.createdAt) ?? new Date(0).toISOString(),
    status: { lastPushAt: iso(s.lastPushAt), lastOkAt: iso(s.lastOkAt), lastError: typeof s.lastError === 'string' ? s.lastError.slice(0, 300) : null, lastErrorAt: iso(s.lastErrorAt), lastVerifiedAt: iso(s.lastVerifiedAt), backups: num(s.backups) },
  };
}

/** Only what the page shows passes back. */
export function backupsResponse(path, status_, body) {
  const v = record(body) ? body : {};
  if (status_ !== 200) return { code: typeof v.code === 'string' ? v.code.slice(0, 64) : 'unavailable', ...(typeof v.error === 'string' ? { error: v.error.slice(0, 300) } : {}) };
  const r = parse(path);
  if (!r) return { code: 'unavailable' };
  if (r.kind === 'list') return record(v.backup) ? { backup: backup(v.backup) } : status(v);
  if (r.kind === 'folder') return { folder: str(v.folder, 1024), cloud: v.cloud === true };
  if (r.kind === 'retention') return { keepDays: Number.isInteger(v.keepDays) ? v.keepDays : 0 };
  if (r.kind === 'destinations') return record(v.destination) ? { destination: destination(v.destination) } : { destinations: Array.isArray(v.destinations) ? v.destinations.slice(0, 50).map(destination) : [] };
  if (r.kind === 'dest-push') return { destination: destination(v.destination) };
  if (r.kind === 'dest-test') return { ok: v.ok === true };
  if (r.kind === 'dest-one') return { deleted: v.deleted === true };
  if (r.kind === 'restore') return { restarting: v.restarting === true, undoId: ID.test(v.undoId) ? v.undoId : '' };
  if (r.kind === 'show') return { shown: v.shown === true };
  return { deleted: v.deleted === true };
}
