// Wire contract for Settings › Security › SSH keys (SSH-KEYS-01), shared by the browser client
// (session.ts) and the local bridge (application-server.cjs). Owner only. Public facts only:
// a private key is never read, so no response can carry one.
const root = '/api/security/ssh-keys';
const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x, n) => (typeof x === 'string' ? x.slice(0, n) : '');
const ID = /^[a-f0-9]{64}$/;
const PUBLIC = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,2}(?: [^\r\n]{0,200})?$/;
export function sshKeysPath(path) {
  if (path === root) return { kind: 'list' };
  const m = /^\/api\/security\/ssh-keys\/([^/?#]+)\/public$/.exec(path);
  return m && ID.test(m[1]) ? { kind: 'public', id: m[1] } : null;
}
export function sshKeysRoute(path) { return path === root || path.startsWith(root + '/'); }
export function allowedSshKeys(method, path, body) { return method === 'GET' && body === undefined && !!sshKeysPath(path); }
function key(x) {
  if (!record(x) || typeof x.id !== 'string' || !ID.test(x.id)) return null;
  return { id: x.id, name: str(x.name, 200), type: typeof x.type === 'string' ? x.type.slice(0, 60) : null, bits: Number.isSafeInteger(x.bits) ? x.bits : null,
    fingerprint: typeof x.fingerprint === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/.test(x.fingerprint) ? x.fingerprint : null, comment: str(x.comment, 200), where: str(x.where, 2048), folder: str(x.folder, 2048),
    hasPublic: x.hasPublic === true, hasPrivate: x.hasPrivate === true, updatedAt: str(x.updatedAt, 40),
    hosts: Array.isArray(x.hosts) ? x.hosts.filter(record).slice(0, 50).map(h => ({ alias: str(h.alias, 200), host: typeof h.host === 'string' ? h.host.slice(0, 200) : null })) : [] };
}
export function sshKeysResponse(path, status, body) {
  const p = sshKeysPath(path);
  if (!p) throw Error('protocol');
  if (status !== 200) return record(body) && ['forbidden', 'not_loopback', 'invalid_input', 'not_found'].includes(body.code) ? { code: body.code } : null;
  if (!record(body)) throw Error('protocol');
  if (p.kind === 'list') { if (!Array.isArray(body.keys)) throw Error('protocol'); return { keys: body.keys.slice(0, 400).map(key).filter(Boolean) }; }
  if (typeof body.publicKey !== 'string' || !PUBLIC.test(body.publicKey)) throw Error('protocol');
  return { publicKey: body.publicKey };
}
