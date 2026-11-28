// BACKUP-02 slices 3–4: the self-hosted off-site destinations — SFTP, WebDAV and
// S3-compatible storage. For each: the owner configures it, pushes a backup, the
// place holds ONLY ciphertext, remote-verify passes, a restore rebuilds the backup,
// and the sign-in is kept in the vault — never in the destinations list or the
// response. The network transports are replaced with in-memory fakes, so no socket
// is ever opened. Owner only; throwaway data dir + keys.
// Run: node --import tsx --test test/backup-destinations-remote.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-rdest-'));
const data = join(dir, '.data');
const outside = join(dir, 'Girru Backups');
const sftpRoot = join(dir, 'sftp-server'); // the fake SFTP server's disk
mkdirSync(join(data, 'encryption'), { recursive: true });
mkdirSync(join(data, 'agents', 'g-lead'), { recursive: true });
mkdirSync(sftpRoot, { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.AGENT_PLAYER_DATA_DIR = data;
process.env.DATABASE_PATH = join(data, 'agent-player.db');
process.env.GIRRU_BACKUPS_DIR = outside;
process.env.JWT_SECRET = randomBytes(64).toString('hex');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.NODE_ENV = 'test';
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {}; console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
for (const [id, role] of [['d-owner', 'owner'], ['d-user', 'user']]) {
  db.prepare(`INSERT INTO users (id, email, username, full_name, password_hash, role, status, email_verified) VALUES (?, ?, ?, ?, 'x', ?, 'active', 1)`).run(id, `${id}@example.test`, id, id, role);
}
const marker = 'OFFSITE-SECRET-remote-42';
writeFileSync(join(data, 'agents', 'g-lead', 'rules.md'), `be kind\n${marker}\n`);

const { getKeyManager } = await import(join(backendDir, 'src/encryption/key-manager.ts'));
await getKeyManager().initialize(join(data, 'encryption', 'keys.db'));
const Arch = await import(join(backendDir, 'src/services/backup-archive.ts'));
const Dest = await import(join(backendDir, 'src/services/backup-destinations.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const app = await buildServer({ logger: false });
await app.ready();
const call = (user, method, url, payload) => app.inject({ method, url, headers: { authorization: `Bearer ${generateToken(user, 1)}` }, ...(payload ? { payload } : {}) });
const ok = async (r, code = 200) => { const x = await r; assert.equal(x.statusCode, code, x.body); return x.json(); };
after(async () => { rmSync(dir, { recursive: true, force: true }); });

// --- a fake HTTP store that serves both WebDAV and S3 (no network) -----------
const httpStore = new Map(); // decoded pathname -> Buffer
const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
async function collect(body) { if (!body) return Buffer.alloc(0); const c = []; for await (const ch of body) c.push(ch); return Buffer.concat(c); }
const reply = (status, text = '') => ({ status, headers: {}, body: Readable.from(text ? Buffer.from(text) : Buffer.alloc(0)) });
const fakeHttp = {
  async send(req) {
    const u = new URL(req.url);
    const key = dec(u.pathname);
    const buf = await collect(req.body);
    if (req.method === 'MKCOL') return reply(201);
    if (req.method === 'PUT') { httpStore.set(key, buf); return reply(201); }
    if (req.method === 'DELETE') { httpStore.delete(key); return reply(204); }
    if (req.method === 'PROPFIND') {
      const base = key.replace(/\/+$/, '') + '/';
      const hrefs = [...httpStore.keys()].filter((k) => k.startsWith(base)).map((k) => `<d:response><d:href>${k}</d:href></d:response>`).join('');
      return reply(207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${base}</d:href></d:response>${hrefs}</d:multistatus>`);
    }
    if (req.method === 'GET') {
      if (u.searchParams.get('list-type') === '2') { // S3 list
        const bucketPrefix = key.replace(/\/+$/, '') + '/'; // "/b/"
        const want = u.searchParams.get('prefix') || '';
        const items = [...httpStore.keys()].filter((k) => k.startsWith(bucketPrefix)).map((k) => k.slice(bucketPrefix.length))
          .filter((rel) => rel.startsWith(want)).map((rel) => `<Contents><Key>${rel}</Key></Contents>`).join('');
        return reply(200, `<?xml version="1.0"?><ListBucketResult>${items}</ListBucketResult>`);
      }
      const b = httpStore.get(key);
      if (!b) return reply(404, 'not found');
      return { status: 200, headers: {}, body: Readable.from(b) };
    }
    return reply(405);
  },
};

// --- a fake SFTP server backed by a temp dir (no socket) ---------------------
const FAKE_HOSTKEY = randomBytes(32).toString('base64');
const fakeSftp = {
  async connect(opts) {
    if (opts.pinnedHostKey && opts.pinnedHostKey !== FAKE_HOSTKEY) throw new Error('host key changed');
    const real = (p) => join(sftpRoot, p.replace(/^\/+/, ''));
    const session = {
      async mkdirp(d) { mkdirSync(real(d), { recursive: true }); },
      async put(remote, local) { mkdirSync(dirname(real(remote)), { recursive: true }); copyFileSync(local, real(remote)); },
      async get(remote, local) { if (!existsSync(real(remote))) throw new Error('no such file'); copyFileSync(real(remote), local); },
      async list(d) { try { return readdirSync(real(d)); } catch { return []; } },
      async remove(remote) { rmSync(real(remote), { force: true }); },
      async close() {},
    };
    return { session, hostKey: FAKE_HOSTKEY };
  },
};

Dest.__setRemoteTransports({ http: fakeHttp, sftp: fakeSftp });

/** Walk a dir tree, return every file path. */
function filesUnder(root) { const out = []; const visit = (d) => { for (const n of readdirSync(d)) { const f = join(d, n); statSync(f).isDirectory() ? visit(f) : out.push(f); } }; if (existsSync(root)) visit(root); return out; }
const noPlaintext = (bytes, where) => {
  assert.ok(!bytes.includes(Buffer.from(marker)), `no plaintext memory ${where}`);
  assert.ok(!bytes.includes(Buffer.from('SQLite format 3')), `no readable database header ${where}`);
};

// One real backup to send to every place.
const backup = (await ok(call('d-owner', 'POST', '/api/backups', {}))).backup;
assert.equal(backup.checked, true);

async function restoresFrom(getBlobBytes, getSidecar, where) {
  const blobFile = join(dir, `blob-${randomBytes(4).toString('hex')}.gbk`);
  const metaFile = `${blobFile}.meta.json`;
  writeFileSync(blobFile, getBlobBytes());
  writeFileSync(metaFile, getSidecar());
  const meta = Arch.readArchiveMeta(metaFile);
  const restored = join(dir, `from-${where}-${randomBytes(4).toString('hex')}`);
  await Arch.decryptBackupArchive(blobFile, meta, restored, getKeyManager(), meta.id);
  assert.equal(readFileSync(join(restored, 'data', 'agents', 'g-lead', 'rules.md'), 'utf8'), `be kind\n${marker}\n`, `restore rebuilds ${where}`);
  assert.ok(existsSync(join(restored, 'manifest.json')));
}

test('SFTP: configure, push, ciphertext-only on the server, restore, sign-in in the vault', async () => {
  const added = (await ok(call('d-owner', 'POST', '/api/backups/destinations', { type: 'sftp', label: 'My NAS', host: 'nas.example.test', username: 'girru', password: 'hunter2-sftp', path: 'backups' }))).destination;
  assert.equal(added.type, 'sftp');
  assert.equal(added.config.host, 'nas.example.test');
  assert.equal(added.config.username, 'girru');
  // No secret is ever returned.
  assert.ok(!JSON.stringify(added).includes('hunter2-sftp'), 'no password in the response');
  assert.ok(!('password' in added.config) && !('privateKey' in added.config), 'no secret field in config');

  const pushed = (await ok(call('d-owner', 'POST', `/api/backups/destinations/${added.id}/push`))).destination;
  assert.ok(pushed.status.lastOkAt && pushed.status.lastVerifiedAt, 'push + remote verify ran');
  assert.equal(pushed.status.lastError, null);
  assert.equal(pushed.status.backups, 1);

  const files = filesUnder(sftpRoot);
  const blob = files.find((f) => f.endsWith('.gbk'));
  const sidecar = files.find((f) => f.endsWith('.gbk.meta.json'));
  assert.ok(blob && sidecar, 'blob + sidecar landed on the server');
  noPlaintext(readFileSync(blob), 'on the SFTP server');
  await restoresFrom(() => readFileSync(blob), () => readFileSync(sidecar), 'sftp');

  // The sign-in lives in the vault (its own encrypted store), keyed by a credentialId.
  const { getCredentialVault } = await import(join(backendDir, 'src/encryption/credential-vault.ts'));
  const creds = await getCredentialVault().query({ service: 'backup-destination' });
  assert.ok(creds.length >= 1, 'a credential is stored in the vault');
});

test('WebDAV: configure, push, ciphertext-only at the place, restore', async () => {
  const added = (await ok(call('d-owner', 'POST', '/api/backups/destinations', { type: 'webdav', label: 'My WebDAV', url: 'http://127.0.0.1/dav', username: 'me', password: 'hunter2-dav' }))).destination;
  assert.equal(added.type, 'webdav');
  assert.equal(added.config.url, 'http://127.0.0.1/dav');
  assert.equal(added.config.username, 'me');
  assert.ok(!JSON.stringify(added).includes('hunter2-dav'), 'no password in the response');

  const pushed = (await ok(call('d-owner', 'POST', `/api/backups/destinations/${added.id}/push`))).destination;
  assert.ok(pushed.status.lastVerifiedAt && pushed.status.lastError === null, 'push + verify ok');
  assert.equal(pushed.status.backups, 1);

  const entries = [...httpStore.entries()].filter(([k]) => k.includes('/dav/girru-offsite/'));
  const blob = entries.find(([k]) => k.endsWith('.gbk'));
  const sidecar = entries.find(([k]) => k.endsWith('.gbk.meta.json'));
  assert.ok(blob && sidecar, 'blob + sidecar stored at the place');
  noPlaintext(blob[1], 'at the WebDAV place');
  await restoresFrom(() => blob[1], () => sidecar[1], 'webdav');
});

test('S3: configure (https enforced off loopback), push, ciphertext-only, restore', async () => {
  // A non-loopback S3 endpoint without https is refused — the sign-in must not travel in the clear.
  assert.equal((await call('d-owner', 'POST', '/api/backups/destinations', { type: 's3', endpoint: 'http://s3.example.test', bucket: 'b', accessKeyId: 'AK', secretAccessKey: 'SK' })).statusCode, 400);

  const added = (await ok(call('d-owner', 'POST', '/api/backups/destinations', { type: 's3', label: 'My S3', endpoint: 'http://127.0.0.1', region: 'eu-central-1', bucket: 'my-backups', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-sauce-s3' }))).destination;
  assert.equal(added.type, 's3');
  assert.equal(added.config.bucket, 'my-backups');
  assert.equal(added.config.accessKeyId, 'AKIAEXAMPLE');
  assert.ok(!JSON.stringify(added).includes('secret-sauce-s3'), 'no secret key in the response');
  assert.ok(!('secretAccessKey' in added.config), 'no secret field in config');

  const pushed = (await ok(call('d-owner', 'POST', `/api/backups/destinations/${added.id}/push`))).destination;
  assert.ok(pushed.status.lastVerifiedAt && pushed.status.lastError === null, 'push + verify ok');
  assert.equal(pushed.status.backups, 1);

  const entries = [...httpStore.entries()].filter(([k]) => k.includes('/my-backups/girru-offsite/'));
  const blob = entries.find(([k]) => k.endsWith('.gbk'));
  const sidecar = entries.find(([k]) => k.endsWith('.gbk.meta.json'));
  assert.ok(blob && sidecar, 'object + sidecar stored in the bucket');
  noPlaintext(blob[1], 'in the S3 bucket');
  await restoresFrom(() => blob[1], () => sidecar[1], 's3');
});

test('GET /destinations never leaks a secret, and shows non-secret settings per type', async () => {
  const list = (await ok(call('d-owner', 'GET', '/api/backups/destinations'))).destinations;
  assert.ok(list.length >= 3);
  const whole = JSON.stringify(list);
  for (const secret of ['hunter2-sftp', 'hunter2-dav', 'secret-sauce-s3']) assert.ok(!whole.includes(secret), `${secret} never comes back`);
  // No secret field ever sits in a place's non-secret settings.
  for (const d of list) for (const bad of ['password', 'privateKey', 'passphrase', 'secretAccessKey']) assert.ok(!(bad in (d.config || {})), `${bad} not in ${d.type} config`);
  const s3 = list.find((d) => d.type === 's3');
  assert.equal(s3.config.bucket, 'my-backups');
  assert.equal(s3.config.region, 'eu-central-1');
});

test('a swapped SFTP host key is refused on a later connect', async () => {
  const added = (await ok(call('d-owner', 'POST', '/api/backups/destinations', { type: 'sftp', label: 'pin', host: 'pin.example.test', username: 'u', password: 'pw' }))).destination;
  // The server now presents a different host key: the pinned one no longer matches.
  const prev = FAKE_HOSTKEY;
  const swapped = { async connect(opts) { if (opts.pinnedHostKey) throw new Error('host key changed'); return { session: { async mkdirp() {}, async put() {}, async get() {}, async list() { return []; }, async remove() {}, async close() {} }, hostKey: randomBytes(32).toString('base64') }; } };
  Dest.__setRemoteTransports({ sftp: swapped });
  const r = await call('d-owner', 'POST', `/api/backups/destinations/${added.id}/test`);
  assert.equal(r.statusCode, 502, r.body);
  Dest.__setRemoteTransports({ sftp: fakeSftp }); // restore for any later work
  assert.equal(prev, FAKE_HOSTKEY);
});
