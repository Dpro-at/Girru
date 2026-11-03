// Wire contract for Settings › Phone and the pairing screens (MOB-PAIR-01),
// shared by the browser client (session.ts) and the local bridge
// (application-server.cjs). Owner only. Exact bodies one way; only the known
// fields and fixed codes the other way, never backend text.

export const PHONE_PATH = '/api/phone';
/** Where the owner gets the phone app (a user-opened link, never a transport target). */
export const PHONE_APP_LINK = 'https://girru.dev/app';
export const PHONE_PATHS = ['anywhere', 'wifi'];
export const PHONE_LIFETIMES = [30, 60, 90, 120, null];
export const PAIRING_ID = /^ps_[A-Za-z0-9_-]{22}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{43}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const CODES = { 400: ['invalid_request'], 404: ['not_found'], 409: ['wifi_off', 'no_request', 'pairing_closed'], 503: ['identity_unavailable'] };
const record = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const exact = (body, required, optional = []) => record(body) && Object.keys(body).every(k => required.includes(k) || optional.includes(k)) && required.every(k => Object.hasOwn(body, k));
const isPath = x => PHONE_PATHS.includes(x);
const isLifetime = x => PHONE_LIFETIMES.includes(x);
const time = x => typeof x === 'string' && ISO.test(x) && Number.isFinite(Date.parse(x));
/** A phone or computer name: 1-64 characters, no control or direction-override characters. */
export const phoneName = x => typeof x === 'string' && x.trim().length > 0 && x.length <= 64 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(x);
/** wss://host/v1, or ws:// only to this computer (a relay run locally); the backend rule. */
export const relayUrl = x => typeof x === 'string' && x.length <= 300 && (/^wss:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?\/v1$/.test(x) || /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?\/v1$/.test(x));
/** The pairing text: girru://pair?… in URL-safe characters only, at most 1024 bytes. */
/** A name to show: unsafe characters dropped (a phone chooses its own name). */
const shown = (x, fallback) => { const s = typeof x === 'string' ? x.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '').trim().slice(0, 64) : ''; return s || fallback; };
const qrText = x => typeof x === 'string' && x.length <= 1024 && /^girru:\/\/pair\?[A-Za-z0-9._~%&=+,:*-]+$/.test(x);

/** Which route this is, or null. */
function route(path) {
  if (typeof path !== 'string') return null;
  if (path === PHONE_PATH) return { kind: 'overview' };
  if (path === `${PHONE_PATH}/pairing`) return { kind: 'pairing' };
  if (path === `${PHONE_PATH}/settings`) return { kind: 'settings' };
  if (path === `${PHONE_PATH}/devices/forget-all`) return { kind: 'forget-all' };
  let m = /^\/api\/phone\/pairing\/([^/?#]+)(?:\/(allow|deny))?$/.exec(path);
  if (m && PAIRING_ID.test(m[1])) return { kind: m[2] ?? 'session' };
  m = /^\/api\/phone\/devices\/([^/?#]+)$/.exec(path);
  if (m && DEVICE_ID.test(m[1])) return { kind: 'device' };
  return null;
}
export const phoneRoute = path => route(path) !== null;

export function allowedPhone(method, path, body) {
  const r = route(path);
  if (!r) return false;
  switch (r.kind) {
    case 'overview': return method === 'GET' && body === undefined;
    case 'pairing': return method === 'POST' && exact(body, ['path']) && isPath(body.path);
    case 'session': return ['GET', 'DELETE'].includes(method) && body === undefined;
    case 'allow': return method === 'POST' && exact(body, ['lifetimeDays', 'path']) && isLifetime(body.lifetimeDays) && isPath(body.path);
    case 'deny': case 'forget-all': return method === 'POST' && body === undefined;
    case 'settings': return method === 'PUT' && exact(body, ['relayUrl']) && relayUrl(body.relayUrl);
    case 'device':
      if (method === 'DELETE') return body === undefined;
      return method === 'PATCH' && exact(body, [], ['name', 'path', 'lifetimeDays']) && Object.keys(body).length > 0
        && (!Object.hasOwn(body, 'name') || phoneName(body.name)) && (!Object.hasOwn(body, 'path') || isPath(body.path)) && (!Object.hasOwn(body, 'lifetimeDays') || isLifetime(body.lifetimeDays));
  }
  return false;
}

function device(d) {
  if (!record(d) || !DEVICE_ID.test(d.id) || typeof d.name !== 'string' || !isPath(d.path) || !isLifetime(d.lifetimeDays) || !['active', 'expired'].includes(d.status)
    || !time(d.pairedAt) || !time(d.lastUsedAt) || !(d.expiresAt === null || time(d.expiresAt))) throw Error('protocol');
  const model = typeof d.model === 'string' && /^[a-z0-9_-]{1,32}$/.test(d.model) ? d.model : null;
  return { id: d.id, name: shown(d.name, 'Phone'), model, path: d.path, lifetimeDays: d.lifetimeDays, status: d.status, pairedAt: d.pairedAt, lastUsedAt: d.lastUsedAt, expiresAt: d.expiresAt };
}

/** Only the known fields of each answer pass back to the page. */
export function phoneResponse(path, status, body) {
  const r = route(path);
  if (status !== 200 && status !== 201) {
    const known = record(body) && (CODES[status] ?? []).includes(body.code) ? body.code : null;
    return { code: known ?? (status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 400 ? 'invalid_request' : status === 409 ? 'conflict' : 'unavailable') };
  }
  if (!r || !record(body)) throw Error('protocol');
  switch (r.kind) {
    case 'overview': {
      if (!Array.isArray(body.devices) || body.devices.length > 100 || !relayUrl(body.relayUrl) || !['off', 'connecting', 'connected', 'waiting'].includes(body.connection) || !['on', 'off', 'failed'].includes(body.wifi)) throw Error('protocol');
      const computer = record(body.computer) && DEVICE_ID.test(body.computer.id) && typeof body.computer.name === 'string' ? { id: body.computer.id, name: shown(body.computer.name, 'This computer') } : null;
      return { computer, devices: body.devices.map(device), relayUrl: body.relayUrl, connection: body.connection, wifi: body.wifi };
    }
    case 'pairing':
      if (status !== 201 || !PAIRING_ID.test(body.id) || !qrText(body.qr) || !time(body.expiresAt)) throw Error('protocol');
      return { id: body.id, qr: body.qr, expiresAt: body.expiresAt };
    case 'session': {
      if (status !== 200) throw Error('protocol');
      if (record(body) && body.ok === true && Object.keys(body).length === 1) return { ok: true };
      if (!['waiting', 'request', 'paired', 'cancelled', 'expired'].includes(body.state)) throw Error('protocol');
      const waiting = body.state === 'waiting';
      if (waiting ? !qrText(body.qr) || !time(body.expiresAt) : body.qr !== null || body.expiresAt !== null) throw Error('protocol');
      const q = body.request;
      if (body.state === 'request' && !(record(q) && typeof q.name === 'string' && typeof q.model === 'string' && /^[a-z0-9_-]{1,32}$/.test(q.model) && typeof q.checkCode === 'string' && /^\d{6}$/.test(q.checkCode)
        && (q.lifetimeDays === undefined || [30, 60, 90, 120].includes(q.lifetimeDays)))) throw Error('protocol');
      return { state: body.state, qr: waiting ? body.qr : null, expiresAt: waiting ? body.expiresAt : null,
        ...(body.state === 'request' ? { request: { name: shown(q.name, 'A phone'), model: q.model, checkCode: q.checkCode, ...(q.lifetimeDays ? { lifetimeDays: q.lifetimeDays } : {}) } } : {}),
        ...(body.warning === 'second_request' ? { warning: 'second_request' } : {}),
        ...(body.state === 'paired' && DEVICE_ID.test(body.deviceId) ? { deviceId: body.deviceId } : {}) };
    }
    case 'allow':
      if (!DEVICE_ID.test(body.deviceId)) throw Error('protocol');
      return { deviceId: body.deviceId };
    case 'forget-all':
      if (!Number.isSafeInteger(body.forgotten) || body.forgotten < 0) throw Error('protocol');
      return { forgotten: body.forgotten };
    case 'settings':
      if (!relayUrl(body.relayUrl)) throw Error('protocol');
      return { relayUrl: body.relayUrl };
    default:
      if (body.ok !== true) throw Error('protocol');
      return { ok: true };
  }
}
