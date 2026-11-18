// MEM-READ-01 MR2: keys and logins in memory are hidden.
//  - the one-time run over saved memories moves each key into the key store and leaves a reference (lock chip);
//  - a new proposal (import) hides keys before anyone sees it; a re-import keeps the same reference;
//  - agents cannot resolve a hidden key; "Move to Connections" makes it a Saved key (resolvable with approval);
//  - the Needs you report counts what was hidden per drawer and clears when the owner answers;
//  - the owner's Show returns the value; nobody else's key is shown.
// Run: node --import tsx --test test/memory-hidden-keys.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const backendDir = process.cwd();
const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-hidden-keys-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await load('src/db/database.ts');
const db = getDatabase();
await db.initialize();
const OWNER = 'hk-owner', OTHER = 'hk-other';
for (const u of [OWNER, OTHER]) db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(u, `${u}@example.test`, u);
const H = await load('src/memory/hidden-keys.ts');
const CS = await load('src/services/chat-secrets.ts');
const MF = await load('src/memory/memory-files.ts');

// Synthetic test values only.
const STRIPE = 'sk_test_' + 'A1b2C3d4E5f6G7h8I9j0K1l2';
const PASS = 'Fake-Test-Pass-123';
const add = (id, content, key = 'grenzer') => db.prepare("INSERT INTO memories (id, user_id, type, content, drawer_kind, drawer_key, created_at) VALUES (?, ?, 'fact', ?, 'project', ?, ?)").run(id, OWNER, content, key, new Date().toISOString());

test('saved memories: keys move to the key store, the text keeps a lock reference', async () => {
  add('m-vps', `**SSH login:** ssh root@203.0.113.7 password: ${PASS}\n## Deploy`);
  add('m-stripe', `STRIPE_SECRET_KEY=${STRIPE}`);
  add('m-plain', 'Hostinger KVM 2 in Frankfurt.');
  await H.hideKeysOnce(OWNER);
  const rows = Object.fromEntries(db.prepare('SELECT id, content FROM memories WHERE user_id = ?').all(OWNER).map(r => [r.id, r.content]));
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(`${PASS}|${STRIPE}`));
  assert.match(rows['m-vps'], /\[SECRET:password:[a-z0-9]+\]/);
  assert.match(rows['m-stripe'], /\[SECRET:stripe_key:[a-z0-9]+\]/);
  assert.equal(rows['m-plain'], 'Hostinger KVM 2 in Frankfurt.');
  assert.equal(await H.hiddenKeyCount(OWNER), 2);
  // Once: a second run changes nothing.
  await H.hideKeysOnce(OWNER);
  assert.equal(await H.hiddenKeyCount(OWNER), 2);
  const report = await H.hiddenKeysReport(OWNER);
  assert.equal(report.total, 2);
  assert.deepEqual(report.drawers.map(d => [d.drawer, d.count, d.memories]), [['project:grenzer', 2, 2]]);
  assert.deepEqual(report.drawers[0].kinds, { password: 1, key: 1 });
  // The owner's Show; another user cannot read it.
  const ref = H.keyRefs(rows['m-stripe'])[0];
  assert.equal(await H.revealKey(OWNER, ref.id), STRIPE);
  assert.equal(await H.revealKey(OTHER, ref.id), null);
  // An agent's tool call cannot resolve a hidden key.
  const resolved = await CS.resolveSecretRefs(OWNER, { cmd: `curl -u ${ref.ref}` });
  assert.equal(resolved.used.length, 0);
});

test('Move to Connections: a Saved key an agent may use (with approval); the report clears', async () => {
  const out = await H.answerHiddenKeys(OWNER, 'move', 'project:grenzer');
  assert.deepEqual(out, { answered: 2, moved: 2 });
  assert.equal((await H.hiddenKeysReport(OWNER)).total, 0);
  const saved = await CS.listChatSecrets(OWNER);
  assert.equal(saved.length, 2);
  assert.ok(saved.every(s => s.conversationId === null), 'a key from memory links to no chat');
  const ref = saved.find(s => s.type === 'stripe_key').ref;
  const resolved = await CS.resolveSecretRefs(OWNER, { cmd: `use ${ref}` });
  assert.equal(resolved.used.length, 1);
  // The memory text still reads the same reference.
  assert.ok(db.prepare("SELECT content FROM memories WHERE id = 'm-stripe'").get().content.includes(ref));
});

test('import proposals hide keys before review; a re-import reuses the reference', async () => {
  const proposal = await MF.createChangeProposal({ userId: OWNER, agentId: 'main-agent', drawer: { kind: 'project', key: 'grenzer' },
    changes: [{ op: 'add', after: { type: 'fact', importance: 6, content: `Admin key: api_key=${'adm_' + 'Zz9Yy8Xx7Ww6Vv5Uu4'}` } }], source: 'import', reasons: ['test'], createdBy: OWNER, skipPendingLimit: true });
  const text = proposal.changes[0].after.content;
  assert.match(text, /\[SECRET:secret_assignment:[a-z0-9]+\]/);
  assert.doesNotMatch(JSON.stringify(proposal), /adm_Zz9/);
  assert.equal((await H.hiddenKeysReport(OWNER)).total, 1);
  // The same value in an update keeps the before's reference.
  const ref = H.keyRefs(text)[0].ref;
  const again = await H.hideKeysInChanges(OWNER, [{ op: 'update', id: 'x', before: { type: 'fact', importance: 6, content: text }, after: { type: 'fact', importance: 6, content: `Admin key: api_key=${'adm_' + 'Zz9Yy8Xx7Ww6Vv5Uu4'} (rotated never)` } }], 'project:grenzer');
  assert.ok(again.changes[0].after.content.includes(ref));
  assert.equal(again.hidden.length, 0);
  // Keep hidden here: answered, still not usable by agents.
  assert.deepEqual(await H.answerHiddenKeys(OWNER, 'keep'), { answered: 1, moved: 0 });
  assert.equal((await CS.resolveSecretRefs(OWNER, { x: ref })).used.length, 0);
});
