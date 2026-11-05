// MCP-ONE-01 + SSH-KEYS-01: one MCP list with its sources, and SSH keys in Settings. Temp HOME only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'girru-mcp-one-'));
const home = path.join(root, 'home'), apps = path.join(root, 'apps');
await fs.mkdir(home); await fs.mkdir(apps);
process.env.AGENT_PLAYER_DATA_DIR = root; process.env.DATABASE_PATH = path.join(root, 'db.sqlite');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); process.env.JWT_SECRET = randomBytes(64).toString('hex');
delete process.env.AGENT_EXEC_TOOLS;
const { getDatabase, closeDatabase } = await import('../src/db/database.ts');
const db = getDatabase(); await db.initialize();
for (const [id, role] of [['owner', 'owner'], ['member', 'user']]) db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES(?,?,?,'fixture',?,'active')").run(id, id + '@example.invalid', id, role);
const { parseMcpToml, LocalMcpImport } = await import('../src/mcp-client/local-import.ts');
const { McpFoundList } = await import('../src/mcp-client/found.ts');
const { mcpImportRoutes } = await import('../src/api/routes/mcp-import.ts');
const { mcpServersRoutes } = await import('../src/api/routes/mcp-servers.ts');
const { sshKeysRoutes } = await import('../src/api/routes/ssh-keys.ts');
const { publicKeyInfo } = await import('../src/services/ssh-keys.ts');
const { registerAuthGate } = await import('../src/auth/auth-gate.ts');
const { generateToken } = await import('../src/auth/jwt.ts');
const { default: Fastify } = await import('fastify');

// Fixture configs: the same program in Claude and Codex (Codex writes env as an inline table),
// one address in Gemini and Antigravity, Girru's own memory server, and a Store app.
const fakeKey = 'fixture-not-a-secret-1357';
await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['-y', '@fixture/fs-server'] }, 'dpro-memory': { command: 'node', args: ['/fixture/mcp-stdio.js'] } } }));
await fs.mkdir(path.join(home, '.codex'));
await fs.writeFile(path.join(home, '.codex', 'config.toml'), `[mcp_servers.files]\ncommand = "npx"\nargs = ["-y", "@fixture/fs-server"]\nenv = { FIXTURE_KEY = "${fakeKey}" }\n\n[mcp_servers.dpro-memory]\ncommand = "node"\nargs = ["/fixture/mcp-stdio.js"]\n`);
await fs.mkdir(path.join(home, '.gemini', 'config'), { recursive: true });
await fs.writeFile(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { docs: { httpUrl: 'https://docs.example.invalid/mcp', trust: true, timeout: 5000 } } }));
await fs.writeFile(path.join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { 'docs-again': { serverUrl: 'https://docs.example.invalid/mcp/' }, local: { command: 'uvx', args: ['fixture-local'], disabled: true } } }));
await fs.mkdir(path.join(apps, 'fixture-app'));
await fs.writeFile(path.join(apps, 'fixture-app', 'agentplayer.plugin.json'), JSON.stringify({ id: 'fixture-app', name: 'Fixture App', mcpServers: { weather: { command: 'node', args: ['weather.js'] } } }));
// SSH: two key pairs from ssh-keygen and a private key with no public half (made unreadable: it must never be opened).
await fs.mkdir(path.join(home, '.ssh'), { mode: 0o700 });
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'owner@fixture', '-f', path.join(home, '.ssh', 'id_ed25519')]);
execFileSync('ssh-keygen', ['-q', '-t', 'rsa', '-b', '2048', '-N', '', '-C', 'deploy', '-f', path.join(home, '.ssh', 'deploy_rsa')]);
await fs.writeFile(path.join(home, '.ssh', 'id_ecdsa'), 'not a key', { mode: 0o000 });
await fs.writeFile(path.join(home, '.ssh', 'config'), 'Host prod\n  HostName prod.example.invalid\n  IdentityFile ~/.ssh/deploy_rsa\nHost *\n  IdentityFile ~/.ssh/id_ed25519\n');

const found = new McpFoundList(home, apps);
const app = Fastify(); registerAuthGate(app);
await app.register(mcpImportRoutes, { store: new LocalMcpImport(home), found });
await app.register(mcpServersRoutes);
await app.register(sshKeysRoutes, { home });
await app.ready();
const auth = { authorization: 'Bearer ' + generateToken('owner', 1) }, member = { authorization: 'Bearer ' + generateToken('member', 1) };
test.after(async () => { await app.close(); closeDatabase(); await fs.chmod(path.join(home, '.ssh', 'id_ecdsa'), 0o600).catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });

test('Codex inline tables are read (env = { … })', () => {
  const s = parseMcpToml('[mcp_servers.a]\ncommand = "npx"\nenv = { K = "v", \'Q\' = \'w\' } # note\n');
  assert.deepEqual({ ...s.a.env }, { K: 'v', Q: 'w' });
  assert.throws(() => parseMcpToml('[mcp_servers.a]\nenv = { K = v }\n'));
});

test('found list: one row per program or address, every source kept, Girru memory apart', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/mcp-import/found', headers: member })).statusCode, 403);
  const r = await app.inject({ method: 'GET', url: '/api/mcp-import/found', headers: auth });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.ok(!r.body.includes(fakeKey), 'secret values never leave');
  const fsRow = body.rows.find((x) => x.target === 'npx -y @fixture/fs-server');
  assert.deepEqual(fsRow.sources.map((s) => s.origin).sort(), ['Claude', 'Codex']);
  assert.deepEqual(fsRow.secretNames, ['FIXTURE_KEY']);
  assert.equal(fsRow.state, 'new');
  const docs = body.rows.filter((x) => URL.canParse(x.target) && new URL(x.target).origin === 'https://docs.example.invalid');
  assert.equal(docs.length, 1, 'Gemini and Antigravity entries for one address are one row');
  assert.deepEqual(docs[0].sources.map((s) => s.origin).sort(), ['Antigravity', 'Gemini']);
  assert.ok(body.rows.some((x) => x.name === 'local' && x.sources[0].origin === 'Antigravity'));
  const weather = body.rows.find((x) => x.name === 'weather');
  assert.equal(weather.sources[0].origin, 'Store app'); assert.equal(weather.sources[0].appName, 'Fixture App');
  assert.ok(!body.rows.some((x) => x.name === 'dpro-memory'));
  assert.deepEqual(body.girru, [{ name: 'dpro-memory', title: 'Girru memory', apps: ['Claude', 'Codex'] }]);
});

test('add keeps it off, links every source, and the row then says added', async () => {
  const before = (await app.inject({ method: 'GET', url: '/api/mcp-import/found', headers: auth })).json();
  const fsRow = before.rows.find((x) => x.target === 'npx -y @fixture/fs-server');
  assert.equal((await app.inject({ method: 'POST', url: '/api/mcp-import/found/add', headers: auth, payload: { key: fsRow.key } })).statusCode, 400);
  const add = await app.inject({ method: 'POST', url: '/api/mcp-import/found/add', headers: auth, payload: { key: fsRow.key, keepSecrets: false } });
  assert.equal(add.statusCode, 200, add.body);
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(add.json().id);
  assert.equal(row.enabled, 0); assert.equal(row.approved_launch_hash, null); assert.equal(row.secret_credential_id, null);
  const again = (await app.inject({ method: 'POST', url: '/api/mcp-import/found/add', headers: auth, payload: { key: fsRow.key, keepSecrets: true } })).json();
  assert.deepEqual(again, { id: row.id, duplicate: true });
  const list = (await app.inject({ method: 'GET', url: '/api/mcp/servers', headers: auth })).json();
  const server = list.servers.find((s) => s.id === row.id);
  assert.deepEqual(server.sources.map((s) => s.origin).sort(), ['Claude', 'Codex']);
  const after = (await app.inject({ method: 'GET', url: '/api/mcp-import/found', headers: auth })).json().rows.find((x) => x.key === fsRow.key);
  assert.equal(after.state, 'added'); assert.equal(after.serverId, row.id);
  // A Store app's server is added from its manifest, off, with the app as its source.
  const weather = (await app.inject({ method: 'GET', url: '/api/mcp-import/found', headers: auth })).json().rows.find((x) => x.name === 'weather');
  const w = await app.inject({ method: 'POST', url: '/api/mcp-import/found/add', headers: auth, payload: { key: weather.key, keepSecrets: true } });
  assert.equal(w.statusCode, 200, w.body);
  const src = db.prepare('SELECT * FROM mcp_server_sources WHERE server_id = ?').all(w.json().id);
  assert.equal(src[0].origin, 'Store app'); assert.equal(src[0].app_id, 'fixture-app');
});

test("don't show again is remembered by launch key", async () => {
  const local = (await app.inject({ method: 'GET', url: '/api/mcp-import/found', headers: auth })).json().rows.find((x) => x.name === 'local');
  assert.equal((await app.inject({ method: 'POST', url: '/api/mcp-import/found/hide', headers: auth, payload: { key: local.key, hidden: true } })).statusCode, 200);
  assert.equal((await new McpFoundList(home, apps).list('owner')).rows.find((x) => x.key === local.key).state, 'hidden');
  await app.inject({ method: 'POST', url: '/api/mcp-import/found/hide', headers: auth, payload: { key: local.key, hidden: false } });
  assert.equal((await found.list('owner')).rows.find((x) => x.key === local.key).state, 'new');
});

test('SSH keys: public facts match ssh-keygen, the private key is never opened, copy gives the public line only', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/security/ssh-keys', headers: member })).statusCode, 403);
  const r = await app.inject({ method: 'GET', url: '/api/security/ssh-keys', headers: auth });
  assert.equal(r.statusCode, 200, r.body);
  const keys = r.json().keys;
  const ed = keys.find((k) => k.name === 'id_ed25519'), rsa = keys.find((k) => k.name === 'deploy_rsa'), lone = keys.find((k) => k.name === 'id_ecdsa');
  const keygen = (f) => execFileSync('ssh-keygen', ['-lf', f]).toString().split(' ')[1];
  assert.equal(ed.fingerprint, keygen(path.join(home, '.ssh', 'id_ed25519.pub')));
  assert.equal(rsa.fingerprint, keygen(path.join(home, '.ssh', 'deploy_rsa.pub')));
  assert.equal(ed.type, 'ssh-ed25519'); assert.equal(ed.comment, 'owner@fixture'); assert.equal(ed.bits, 256); assert.equal(rsa.bits, 2048);
  assert.deepEqual(rsa.hosts, [{ alias: 'prod', host: 'prod.example.invalid' }]);
  assert.equal(lone.hasPublic, false); assert.equal(lone.fingerprint, null);
  assert.ok(!r.body.includes('PRIVATE KEY'));
  const pub = (await app.inject({ method: 'GET', url: `/api/security/ssh-keys/${ed.id}/public`, headers: auth })).json().publicKey;
  assert.equal(pub, (await fs.readFile(path.join(home, '.ssh', 'id_ed25519.pub'), 'utf8')).trim());
  assert.equal((await app.inject({ method: 'GET', url: `/api/security/ssh-keys/${lone.id}/public`, headers: auth })).statusCode, 404);
  assert.equal(publicKeyInfo('-----BEGIN OPENSSH PRIVATE KEY-----'), null);
});
