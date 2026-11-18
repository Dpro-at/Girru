import {fileURLToPath as backendFixtureFileURLToPath} from 'node:url';
// CORE-04: DB-canonical memory files; edits come back as reviewed proposals.
// Run: node --import tsx --test test/memory-files.test.mjs
// Throwaway DB + cwd, random test-only secrets, no network (local word-count
// embedding; fetch is refused).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const backendDir = backendFixtureFileURLToPath(new URL('../',import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'ap-memfiles-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };

const quiet = { log: console.log, warn: console.warn };
console.log = () => {};
console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, 'active')`).run(id, `${id}@example.test`, id, role);
addUser('mf-owner', 'owner');
addUser('mf-admin', 'admin');
addUser('mf-user', 'user');
db.prepare('UPDATE agents_config SET is_primary = 0').run();
db.prepare(`INSERT INTO agents_config (id, name, is_primary) VALUES ('mf-agent', 'Mf Agent', 1)`).run();
db.prepare(`INSERT INTO agents_config (id, name) VALUES ('mf-second', 'Mf Second')`).run();

const { registerAuthGate } = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { memoryRoutes } = await import(join(backendDir, 'src/api/routes/memory.ts'));
const { memoryFilesRoutes } = await import(join(backendDir, 'src/api/routes/memory-files.ts'));
const MF = await import(join(backendDir, 'src/memory/memory-files.ts'));
const { getMemoryStorage } = await import(join(backendDir, 'src/memory/storage.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { default: Fastify } = await import('fastify');

const app = Fastify();
registerAuthGate(app);
await app.register(memoryRoutes);
await app.register(memoryFilesRoutes);
await app.ready();
console.log = quiet.log;
console.warn = quiet.warn;

test.after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const auth = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const quietly = async (fn) => { const l = console.log; const w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };
const call = (method, url, who = 'mf-owner', payload) => quietly(() => app.inject({ method, url, headers: auth(who), payload }));

// UI-IP-04: approve/reject send back the reviewHash of the proposal as reviewed.
const reviewHashOf = async (id, who = 'mf-owner') => { const r = await call('GET', `/api/memory/proposals/${id}`, who); return r.statusCode === 200 ? r.json().reviewHash : undefined; };
const decide = async (id, action, who = 'mf-owner', payload = {}) => call('POST', `/api/memory/proposals/${id}/${action}`, who, { expectedReviewHash: await reviewHashOf(id, who), ...payload });
const memRows = (userId = 'mf-owner') => db.prepare(`SELECT id, type, content, importance_score, drawer_kind, drawer_key FROM memories WHERE user_id = ? ORDER BY created_at, id`).all(userId).map((r) => ({ ...r }));
const ownerFile = () => join(dir, '.data', 'agents', 'mf-agent', 'memory', 'mf-owner', 'project--alpha.md');

let ids = {};
test('setup: memories in project alpha, beta and owner drawers', async () => {
  for (const [name, drawer, type, importance] of [
    ['a1', { kind: 'project', key: 'alpha' }, 'fact', 8],
    ['a2', { kind: 'project', key: 'alpha' }, 'preference', 6],
    ['b1', { kind: 'project', key: 'beta' }, 'fact', 7],
    ['o1', undefined, 'fact', 9],
  ]) {
    const res = await call('POST', '/api/memory', 'mf-owner', { type, importance, content: `alpha memory ${name}\n### not a heading`, ...(drawer ? { drawer } : {}) });
    assert.equal(res.statusCode, 200, res.body);
    ids[name] = res.json().memory.id;
  }
  const other = await call('POST', '/api/memory', 'mf-user', { type: 'fact', importance: 5, content: 'user memory', drawer: { kind: 'project', key: 'alpha' } });
  ids.u1 = other.json().memory.id;
});

test('only the owner reaches memory files and proposals (gate + handler)', async () => {
  const routes = [
    ['GET', '/api/memory/files'], ['GET', '/api/memory/files/owner'], ['GET', '/api/memory/files/owner/versions'],
    ['POST', '/api/memory/files/owner/export'], ['POST', '/api/memory/files/owner/proposal'],
    ['GET', '/api/memory/proposals'], ['GET', '/api/memory/proposals/x'],
    ['POST', '/api/memory/proposals/x/approve'], ['POST', '/api/memory/proposals/x/reject'],
  ];
  for (const [method, url] of routes) {
    assert.equal((await quietly(() => app.inject({ method, url, payload: method === 'POST' ? {} : undefined }))).statusCode, 401, `${method} ${url} anon`);
    for (const who of ['mf-admin', 'mf-user']) {
      assert.equal((await call(method, url, who, method === 'POST' ? {} : undefined)).statusCode, 403, `${method} ${url} ${who}`);
    }
  }
});

test('export: generated header, path-safe under the agent folder, DB unchanged', async () => {
  const before = memRows();
  const res = await call('POST', '/api/memory/files/project:alpha/export');
  assert.equal(res.statusCode, 200, res.body);
  const view = res.json();
  assert.equal(view.path, '.data/agents/mf-agent/memory/mf-owner/project--alpha.md');
  assert.ok(!view.path.includes('public'));
  const text = readFileSync(ownerFile(), 'utf-8');
  assert.equal(text, view.content);
  assert.match(text, /GENERATED FILE\. The database is the canonical memory/);
  assert.match(text, /Saving this file changes nothing by itself/);
  assert.match(text, /<!-- drawer: project:alpha \| revision: 0 \| base: [0-9a-f]{64} \| exported: /);
  assert.ok(text.includes(`### m:${ids.a1} | fact | importance 8`));
  assert.ok(text.includes(`### m:${ids.a2} | preference | importance 6`));
  assert.ok(text.includes('\\### not a heading'), 'content heading lines are escaped');
  assert.ok(!text.includes(ids.b1) && !text.includes(ids.o1) && !text.includes(ids.u1), 'only this drawer, only this user');
  assert.deepEqual(memRows(), before);

  // Path safety: bad drawer ids / agent ids never become paths.
  for (const bad of ['project:..', 'project:..%2F..%2Fx', 'people:a%2Fb', 'project:UPPER', 'nope', 'owner:key', 'task:.hidden']) {
    assert.equal((await call('POST', `/api/memory/files/${bad}/export`)).statusCode, 400, bad);
  }
  assert.equal((await call('POST', '/api/memory/files/owner/export?agentId=..')).statusCode, 400);
  assert.equal((await call('POST', '/api/memory/files/owner/export?agentId=ghost')).statusCode, 404);
  assert.throws(() => MF.drawerFilePath('mf-agent', '../evil', { kind: 'owner' }), MF.MemoryFileError);
  assert.throws(() => MF.drawerFilePath('../x', 'mf-owner', { kind: 'owner' }), MF.MemoryFileError);
  const p = MF.drawerFilePath('mf-agent', 'mf-owner', { kind: 'people', key: 'p.1@x' });
  assert.ok(p.startsWith(resolve(process.cwd(), '.data', 'agents') + sep));
  // Another agent folder on request.
  const second = (await call('POST', '/api/memory/files/owner/export?agentId=mf-second')).json();
  assert.equal(second.path, '.data/agents/mf-second/memory/mf-owner/owner.md');
  // A symlink at the export path is refused (never written through).
  const linkDir = join(dir, '.data', 'agents', 'mf-agent', 'memory', 'mf-owner');
  writeFileSync(join(dir, 'target.txt'), 'untouched');
  symlinkSync(join(dir, 'target.txt'), join(linkDir, 'experience.md'));
  assert.equal((await call('POST', '/api/memory/files/experience/export')).statusCode, 409);
  assert.equal(readFileSync(join(dir, 'target.txt'), 'utf-8'), 'untouched');
});

test('no automatic file -> DB writes: an edited file changes nothing by itself', async () => {
  const before = memRows();
  // CORE-05: the API adds of the setup are versioned ('create' rows); nothing more may appear.
  const versionsBefore = db.prepare('SELECT COUNT(*) AS n FROM memory_versions').get().n;
  const edited = readFileSync(ownerFile(), 'utf-8').replace('alpha memory a1', 'EDITED ON DISK');
  writeFileSync(ownerFile(), edited);
  await sleep(300);
  // Reading routes and listing do not import the file either.
  await call('GET', '/api/memory/files');
  await call('GET', '/api/memory/files/project:alpha');
  await call('GET', '/api/memory/proposals');
  await call('GET', '/api/memory');
  assert.deepEqual(memRows(), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_file_proposals').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_versions').get().n, versionsBefore);
});

let proposalId;
test('edit file -> proposal (diff against the DB) -> approve -> new version', async () => {
  // The owner submits the file as saved on disk, plus one more edit via upload.
  let text = readFileSync(ownerFile(), 'utf-8');
  // update a1 (content, from the disk edit), change a2 importance, add a new entry
  text = text.replace(`### m:${ids.a2} | preference | importance 6`, `### m:${ids.a2} | preference | importance 9`);
  text += '\n### new | fact | importance 7\nالسيرفر الجديد في المشروع\n';
  writeFileSync(ownerFile(), text);

  const before = memRows();
  const res = await call('POST', '/api/memory/files/project:alpha/proposal', 'mf-owner', { note: 'my edits' });
  assert.equal(res.statusCode, 201, res.body);
  const proposal = res.json();
  proposalId = proposal.id;
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.source, 'file');
  assert.equal(proposal.drawerId, 'project:alpha');
  const ops = proposal.changes.map((c) => c.op).sort();
  assert.deepEqual(ops, ['add', 'update', 'update']);
  const upd = proposal.changes.find((c) => c.op === 'update' && c.id === ids.a1);
  assert.equal(upd.before.content, 'alpha memory a1\n### not a heading');
  assert.equal(upd.after.content, 'EDITED ON DISK\n### not a heading');
  assert.deepEqual(memRows(), before, 'a proposal writes nothing into the memory');

  const list = (await call('GET', '/api/memory/proposals?status=pending')).json().proposals;
  assert.deepEqual(list.map((p) => [p.id, p.counts]), [[proposalId, { add: 1, update: 2, delete: 0 }]]);
  assert.equal((await call('GET', `/api/memory/proposals/${proposalId}`)).json().changes.length, 3);

  const ok = await decide(proposalId, 'approve');
  assert.equal(ok.statusCode, 200, ok.body);
  const result = ok.json();
  assert.equal(result.revision, 1);
  assert.equal(result.proposal.status, 'approved');
  assert.equal(result.proposal.appliedRevision, 1);
  assert.equal(result.applied.added.length, 1);

  const after = Object.fromEntries(memRows().map((r) => [r.id, r]));
  assert.equal(after[ids.a1].content, 'EDITED ON DISK\n### not a heading');
  assert.equal(after[ids.a2].importance_score, 0.9);
  const added = after[result.applied.added[0]];
  assert.deepEqual([added.content, added.type, added.drawer_kind, added.drawer_key], ['السيرفر الجديد في المشروع', 'fact', 'project', 'alpha']);
  assert.equal(after[ids.b1].content, before.find((r) => r.id === ids.b1).content, 'other drawer untouched');

  // History: the API add (CORE-05: 'create') + new version for each updated memory, create for the new one.
  const versions = (await call('GET', '/api/memory/files/project:alpha/versions')).json();
  assert.equal(versions.revision, 1);
  const a1v = versions.versions.filter((v) => v.memoryId === ids.a1).sort((x, y) => x.version - y.version);
  assert.deepEqual(a1v.map((v) => [v.version, v.change, v.drawerRevision]), [[1, 'create', 0], [2, 'update', 1]]);
  assert.equal(a1v[0].content, 'alpha memory a1\n### not a heading');
  assert.ok(versions.versions.some((v) => v.change === 'create' && v.memoryId === result.applied.added[0]));

  // The file was re-exported at revision 1.
  assert.match(readFileSync(ownerFile(), 'utf-8'), /revision: 1 \| base: /);
  // Audit trail.
  const auditRow = db.prepare(`SELECT user_id, action, success, resource_id FROM audit_logs WHERE action = 'memory_proposal.approve'`).get();
  assert.deepEqual({ ...auditRow }, { user_id: 'mf-owner', action: 'memory_proposal.approve', success: 1, resource_id: proposalId });
  // Decided once only.
  assert.equal((await decide(proposalId, 'approve')).statusCode, 409);
  assert.equal((await decide(proposalId, 'reject')).statusCode, 409);
});

test('reject -> memory unchanged; delete via file; stale proposals refused', async () => {
  const fresh = (await call('GET', '/api/memory/files/project:alpha')).json().content;
  const lines = fresh.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`### m:${ids.a2} `));
  let end = lines.findIndex((l, i) => i > start && l.startsWith('### '));
  if (end < 0) end = lines.length;
  assert.ok(start > 0);
  const removedA2 = [...lines.slice(0, start), ...lines.slice(end)].join('\n');
  const p1 = await call('POST', '/api/memory/files/project:alpha/proposal', 'mf-owner', { content: removedA2 });
  assert.equal(p1.statusCode, 201, p1.body);
  assert.deepEqual(p1.json().changes.map((c) => [c.op, c.id]), [['delete', ids.a2]]);
  assert.equal(p1.json().source, 'upload');

  const before = memRows();
  const rej = await decide(p1.json().id, 'reject', 'mf-owner', { note: 'keep it' });
  assert.equal(rej.statusCode, 200, rej.body);
  assert.equal(rej.json().status, 'rejected');
  assert.deepEqual(memRows(), before, 'reject changes nothing');
  assert.ok(db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'memory_proposal.reject' AND resource_id = ?`).get(p1.json().id));

  // Two proposals from the same base: approving one makes the other stale.
  const p2 = (await call('POST', '/api/memory/files/project:alpha/proposal', 'mf-owner', { content: removedA2 })).json();
  const p3 = (await call('POST', '/api/memory/files/project:alpha/proposal', 'mf-owner', { content: fresh.replace('EDITED ON DISK', 'third edit') })).json();
  assert.equal((await decide(p2.id, 'approve')).statusCode, 200);
  assert.ok(!memRows().some((r) => r.id === ids.a2), 'deleted');
  const del = (await call('GET', '/api/memory/files/project:alpha/versions')).json().versions.find((v) => v.memoryId === ids.a2 && v.change === 'delete');
  assert.ok(del, 'deletion recorded; the baseline keeps the old text');
  const staleRes = await decide(p3.id, 'approve');
  assert.equal(staleRes.statusCode, 409);
  assert.equal((await call('GET', `/api/memory/proposals/${p3.id}`)).json().status, 'stale');
  assert.ok(!memRows().some((r) => r.content.startsWith('third edit')));

  // An old export (before revision 2) cannot become a proposal at all.
  const oldRes = await call('POST', '/api/memory/files/project:alpha/proposal', 'mf-owner', { content: fresh.replace('EDITED ON DISK', 'from old copy') });
  assert.equal(oldRes.statusCode, 409);
});

test('invalid edits are refused and store nothing', async () => {
  const fresh = (await call('GET', '/api/memory/files/project:alpha')).json().content;
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM memory_file_proposals').get().n;
  const n = count();
  const cases = [
    fresh,                                                                    // no changes
    'just some text',                                                         // not an export
    fresh.replace('drawer: project:alpha', 'drawer: project:beta'),           // another drawer's file
    fresh + `\n### m:${ids.b1} | fact | importance 7\nsteal from beta\n`,     // memory of another drawer
    fresh + `\n### m:${ids.u1} | fact | importance 5\nother user\n`,          // memory of another user
    fresh + '\n### new | secret | importance 5\nx\n',                         // unknown type
    fresh + '\n### new | fact | importance 11\nx\n',                          // importance out of range
    fresh + '\n### new | fact\n\n',                                           // empty entry
    fresh + '\n### whatever\nx\n',                                            // heading not understood
  ];
  for (const content of cases) {
    const res = await call('POST', '/api/memory/files/project:alpha/proposal', 'mf-owner', { content });
    assert.equal(res.statusCode, 400, `${res.body} :: ${content.slice(-60)}`);
  }
  assert.equal((await call('POST', '/api/memory/files/project:alpha/proposal', 'mf-owner', { content: 42 })).statusCode, 400);
  assert.equal((await call('POST', '/api/memory/files/task:never/proposal', 'mf-owner', {})).statusCode, 404, 'no exported file yet');
  assert.equal(count(), n);
});

test('proposals are per user: another account never sees or decides them', async () => {
  // Even a second owner-role account would only see its own proposals; here the
  // non-owner roles are already refused by the gate (403). Unknown ids -> 404.
  assert.equal((await call('GET', '/api/memory/proposals/00000000-0000-0000-0000-000000000000')).statusCode, 404);
  addUser('mf-owner2', 'owner');
  const res = await call('GET', `/api/memory/proposals/${proposalId}`, 'mf-owner2');
  assert.equal(res.statusCode, 404);
  assert.equal((await decide(proposalId, 'reject', 'mf-owner2')).statusCode, 404);
  assert.deepEqual((await call('GET', '/api/memory/proposals', 'mf-owner2')).json().proposals, []);
});

// UI-IP-04 review (CORE-04b): decisions are atomic and bound to the reviewed content.
const raw = (method, url, payload, who = 'mf-owner') => quietly(() => app.inject({ method, url, headers: auth(who), payload }));
const proposalRow = (id) => ({ ...db.prepare('SELECT status, decided_by, applied_revision FROM memory_file_proposals WHERE id = ?').get(id) });
/** A file proposal on the owner drawer that edits o1 (an update: approve awaits an embedding). */
const ownerEdit = async (text) => {
  const fresh = (await call('GET', '/api/memory/files/owner')).json().content;
  const lines = fresh.split('\n');
  const at = lines.findIndex((l) => l.startsWith(`### m:${ids.o1} `));
  lines[at + 1] = text;
  const res = await call('POST', '/api/memory/files/owner/proposal', 'mf-owner', { content: lines.join('\n') });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
};
/** Hold storage.embed until release(); resolves `entered` when the first call starts. */
const gateEmbed = () => {
  const storage = getMemoryStorage();
  const orig = storage.embed;
  let release; let entered;
  const gate = new Promise((r) => { release = r; });
  const started = new Promise((r) => { entered = r; });
  storage.embed = async (text) => { entered(); await gate; return orig.call(storage, text); };
  return { started, release: () => release(), restore: () => { storage.embed = orig; } };
};

test('reviewHash: on list and detail, stable, and required to decide; status filter', async () => {
  const p = await ownerEdit('owner edit for hash check');
  const detail = (await call('GET', `/api/memory/proposals/${p.id}`)).json();
  assert.match(detail.reviewHash, /^[0-9a-f]{64}$/);
  assert.equal(detail.reviewHash, p.reviewHash, 'create and detail agree');
  assert.equal(detail.reviewHash, MF.proposalReviewHash(detail), 'canonical: id, drawer, revision, base, source, changes');
  const listed = (await call('GET', '/api/memory/proposals?status=pending')).json().proposals;
  assert.ok(listed.every((x) => x.status === 'pending'));
  assert.equal(listed.find((x) => x.id === p.id).reviewHash, detail.reviewHash);
  assert.ok((await call('GET', '/api/memory/proposals?status=approved')).json().proposals.every((x) => x.status === 'approved'));
  assert.equal((await call('GET', '/api/memory/proposals?status=bogus')).statusCode, 400);

  const before = memRows();
  for (const [action, payload] of [['approve', {}], ['reject', { note: 'x' }], ['approve', { expectedReviewHash: 'nope' }]]) {
    const res = await raw('POST', `/api/memory/proposals/${p.id}/${action}`, payload);
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().code, 'review_hash_required');
  }
  const wrong = 'f'.repeat(64);
  for (const action of ['approve', 'reject']) {
    const res = await raw('POST', `/api/memory/proposals/${p.id}/${action}`, { expectedReviewHash: wrong });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().code, 'review_changed');
  }
  assert.deepEqual(memRows(), before, 'nothing written');
  assert.equal(proposalRow(p.id).status, 'pending', 'still pending');
  // The reviewed content changed under the reviewer (stored diff rewritten) -> refused.
  db.prepare('UPDATE memory_file_proposals SET changes = ? WHERE id = ?').run(JSON.stringify(detail.changes.map((c) => ({ ...c, after: { ...c.after, content: 'swapped' } }))), p.id);
  const swapped = await raw('POST', `/api/memory/proposals/${p.id}/approve`, { expectedReviewHash: detail.reviewHash });
  assert.equal(swapped.statusCode, 409);
  assert.equal(swapped.json().code, 'review_changed');
  assert.deepEqual(memRows(), before);
  const rej = await raw('POST', `/api/memory/proposals/${p.id}/reject`, { expectedReviewHash: (await call('GET', `/api/memory/proposals/${p.id}`)).json().reviewHash });
  assert.equal(rej.statusCode, 200, rej.body);
  // Decided proposals answer with a machine code.
  const again = await raw('POST', `/api/memory/proposals/${p.id}/approve`, { expectedReviewHash: rej.json().reviewHash });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().code, 'already_decided');
});

test('concurrent approve + reject: the reject wins during the embedding, approve writes nothing', async () => {
  const p = await ownerEdit('owner edit raced by a reject');
  const before = memRows();
  const g = gateEmbed();
  try {
    const approving = raw('POST', `/api/memory/proposals/${p.id}/approve`, { expectedReviewHash: p.reviewHash });
    await g.started; // approve passed its first checks and is awaiting the embedding
    const rej = await raw('POST', `/api/memory/proposals/${p.id}/reject`, { expectedReviewHash: p.reviewHash });
    assert.equal(rej.statusCode, 200, rej.body);
    g.release();
    const ap = await approving;
    assert.equal(ap.statusCode, 409, ap.body);
    assert.equal(ap.json().code, 'already_decided');
  } finally { g.restore(); }
  assert.deepEqual(memRows(), before, 'no memory written for a rejected proposal');
  assert.equal(proposalRow(p.id).status, 'rejected');
  assert.equal(proposalRow(p.id).applied_revision, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_versions WHERE proposal_id = ?').get(p.id).n, 0, 'no history rows');
});

test('concurrent double approve of a file proposal: exactly one applies', async () => {
  const p = await ownerEdit('owner edit approved twice');
  const g = gateEmbed();
  let results;
  try {
    const a = raw('POST', `/api/memory/proposals/${p.id}/approve`, { expectedReviewHash: p.reviewHash });
    const b = raw('POST', `/api/memory/proposals/${p.id}/approve`, { expectedReviewHash: p.reviewHash });
    await g.started;
    await sleep(20);
    g.release();
    results = await Promise.all([a, b]);
  } finally { g.restore(); }
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(results.find((r) => r.statusCode === 409).json().code, 'already_decided');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_versions WHERE proposal_id = ? AND change = ?').get(p.id, 'update').n, 1, 'one new version only');
  assert.ok(memRows().find((r) => r.id === ids.o1).content.startsWith('owner edit approved twice\n'));
});

test('stale approve answers code "stale" and marks the proposal stale', async () => {
  const p1 = await ownerEdit('first of two from one base');
  const p2 = await ownerEdit('second of two from one base');
  assert.equal((await decide(p1.id, 'approve')).statusCode, 200);
  const res = await raw('POST', `/api/memory/proposals/${p2.id}/approve`, { expectedReviewHash: p2.reviewHash });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'stale');
  assert.equal(proposalRow(p2.id).status, 'stale');
  assert.ok(memRows().find((r) => r.id === ids.o1).content.startsWith('first of two from one base\n'));
});

test('post-commit file cleanup failure never fails a committed approve', async () => {
  // Delete o1 via the owner file: approve removes its readable copy after commit.
  const fresh = (await call('GET', '/api/memory/files/owner')).json().content;
  const lines = fresh.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`### m:${ids.o1} `));
  let end = lines.findIndex((l, i) => i > start && l.startsWith('### '));
  if (end < 0) end = lines.length;
  const p = (await call('POST', '/api/memory/files/owner/proposal', 'mf-owner', { content: [...lines.slice(0, start), ...lines.slice(end)].join('\n') })).json();
  assert.deepEqual(p.changes.map((c) => c.op), ['delete']);
  const storage = getMemoryStorage();
  const orig = { remove: storage.removeMarkdownCopy, write: storage.writeMarkdownCopy };
  let calls = 0;
  storage.removeMarkdownCopy = async () => { calls++; throw Object.assign(new Error('disk says no'), { code: 'EACCES' }); };
  storage.writeMarkdownCopy = async () => { throw new Error('disk says no'); };
  let res;
  try { res = await raw('POST', `/api/memory/proposals/${p.id}/approve`, { expectedReviewHash: p.reviewHash }); }
  finally { storage.removeMarkdownCopy = orig.remove; storage.writeMarkdownCopy = orig.write; }
  assert.equal(calls, 1, 'cleanup was attempted');
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().proposal.status, 'approved');
  assert.deepEqual(res.json().applied.deleted, [ids.o1]);
  assert.ok(!memRows().some((r) => r.id === ids.o1), 'the committed change stays');
});
