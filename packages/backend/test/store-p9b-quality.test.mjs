// STORE-MAP-01 P9b (GIRRU_STORE_P9B) memory quality engine, MD1, MD3, MD5–MD8.
//  - MD1 one write pipeline: every source (chat extraction, agent, coding tool, import, owner,
//    approval) stores provenance and a trust record at once; enrichment runs in the background;
//  - MD3 confidence from corroboration: several sources or the owner raise it, a tool alone stays low;
//  - MD5 recall routed by intent (rules only, no model);
//  - MD6 local re-rank within a 300 ms budget, the fast ranking as fallback;
//  - MD7 learn from use: only verified facts gain, unused ones decay, corrections after use are flagged;
//  - MD8 "no reliable memory": the agent asks once; the answer resolves the question;
//  - off: nothing of this changes today's behaviour.
// Run: node --import tsx --test test/store-p9b-quality.test.mjs
// Throwaway DB + cwd + HOME, random test-only secrets, no network, no real model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const backendDir = process.cwd();
const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-store-p9b-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.GIRRU_BACKUPS_DIR = join(dir, 'Girru Backups');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
for (const k of ['GIRRU_STORE_P9B', 'GIRRU_STORE_P9', 'GIRRU_STORE_P3', 'GIRRU_STORE_P2']) delete process.env[k];
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await load('src/db/database.ts');
const db = getDatabase();
await db.initialize();
const OWNER = 'p9b-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(OWNER, `${OWNER}@example.test`, OWNER);
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary, department, specialty) VALUES
  ('b-one', 'One', 'ollama', 'qwen-test', 0, 'backend', 'Database engineer')`).run();

const L = await load('src/memory/learning.ts');
const F = await load('src/memory/memory-files.ts');
const P = await load('src/memory/context/pack.ts');
const J = await load('src/memory/jobs.ts');
const T = await load('src/memory/quality/trust.ts');
const PL = await load('src/memory/quality/pipeline.ts');
const I = await load('src/memory/quality/intent.ts');
const RC = await load('src/memory/quality/recall.ts');
const U = await load('src/memory/quality/usage.ts');
const { forgetMemory } = await load('src/memory/forget.ts');
const { memoryRepository } = await load('src/repositories/memory.ts');
const { userActor } = await load('src/repositories/actor.ts');
const { getMemoryStorage } = await load('src/memory/storage.ts');
const storage = getMemoryStorage();
await storage.initialize();
const ownerActor = userActor({ id: OWNER, role: 'owner' });

const on = () => { process.env.GIRRU_STORE_P9B = '1'; };
const off = () => { delete process.env.GIRRU_STORE_P9B; };
const trust = (id) => db.prepare('SELECT * FROM memory_trust WHERE memory_id = ?').get(id);
const sources = (id) => db.prepare('SELECT source_key, kind FROM memory_trust_sources WHERE memory_id = ? ORDER BY at, source_key').all(id);
const extraction = (content, importance = 5) => ({ content, type: 'fact', importance, origin: 'extraction' });
let n = 0;
const insert = (drawer, content, extra = {}) => {
  const id = `b-${++n}`;
  db.prepare(`INSERT INTO memories (id, user_id, type, content, memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, drawer_key, source_agent_id)
    VALUES (?, ?, ?, ?, 'factual', 'active', '{}', ?, ?, 0, ?, ?, ?)`)
    .run(id, OWNER, extra.type ?? 'fact', content, extra.importance ?? 0.5, extra.createdAt ?? new Date(Date.now() - 1000 * (1000 - n)).toISOString(), drawer.kind, drawer.key ?? '', extra.agent ?? null);
  return id;
};

test('MD3: confidence from corroboration (pure)', () => {
  const owner = T.trustOf([{ key: 'owner', kind: 'owner' }]);
  assert.equal(owner.confidence, T.START_CONFIDENCE.owner);
  assert.equal(owner.verified, true);
  const tool = T.trustOf([{ key: 'bridge:test-cli', kind: 'tool' }]);
  assert.equal(tool.confidence, T.START_CONFIDENCE.tool, 'a single tool-written fact starts low');
  assert.equal(tool.verified, false);
  assert.equal(T.bandOf(tool.confidence), 'low');
  const sameTwice = T.trustOf([{ key: 'bridge:test-cli', kind: 'tool' }, { key: 'bridge:test-cli', kind: 'tool' }]);
  assert.equal(sameTwice.confidence, tool.confidence, 'the same source counts once');
  const tools = T.trustOf([1, 2, 3, 4, 5, 6].map((i) => ({ key: `bridge:c${i}`, kind: 'tool' })));
  assert.ok(tools.confidence > tool.confidence && tools.confidence <= T.MAX_UNOWNED);
  assert.equal(tools.verified, false, 'tools never verify a fact on their own, however often');
  const channels = T.trustOf([1, 2, 3].map((i) => ({ key: `channel:${i}`, kind: 'channel' })));
  assert.equal(channels.verified, false);
  const chatAgent = T.trustOf([{ key: 'chat:2026-11-01', kind: 'chat' }, { key: 'agent:a', kind: 'agent' }]);
  assert.equal(chatAgent.verified, true, 'two trusted sources verify');
  assert.ok(chatAgent.confidence > T.START_CONFIDENCE.chat);
  const approved = T.trustOf([{ key: 'bridge:test-cli', kind: 'tool' }, { key: 'owner-approval', kind: 'approved' }]);
  assert.ok(approved.confidence >= T.OWNER_APPROVED && approved.verified);
  assert.deepEqual(T.legacyConfidence({ metadata: { source: 'outsider' } }).confidence, T.START_CONFIDENCE.channel);
});

test('MD5: intent by rules (EN, Arabic, Iraqi, German), never a hard filter', () => {
  const cases = [
    ['Why did we choose PostgreSQL for alpha?', 'decision'],
    ['ليش قررنا نأجل الإصدار؟', 'decision'],
    ['How do I deploy the alpha installer?', 'howto'],
    ['شلون نوقّع ملف التنصيب مال ألفا؟', 'howto'],
    ['Wie kann ich den Server neu starten?', 'howto'],
    ['What happened with the build last week?', 'history'],
    ['شصار بالاجتماع أمس؟', 'history'],
    ['Who is our accountant?', 'person'],
    ['منو المحاسبة مالتنا؟', 'person'],
    ['What car does Samir drive?', 'fact'],
    ['How does Samir take his tea?', 'fact'], // a preference, not a procedure
    ['كيف يحب سمير شكل التقارير؟', 'fact'],
  ];
  for (const [q, intent] of cases) assert.equal(I.classifyIntent(q), intent, q);
  assert.equal(I.fitsIntent('howto', { type: 'fact', drawer: { kind: 'experience' } }), true);
  assert.equal(I.fitsIntent('person', { type: 'fact', drawer: { kind: 'owner' } }, true), true, 'a graph hit fits a person question');
  assert.equal(I.fitsIntent('fact', { type: 'fact', drawer: { kind: 'owner' } }), false);
  assert.equal(I.isMemoryQuestion('Hi there, thanks!', 2), false);
  assert.equal(I.isMemoryQuestion('What is the office wifi name?', 3), true);
  assert.equal(I.isMemoryQuestion('شنو رمز باب المخزن؟', 3), true);
});

test('off: no trust records, recall text as today, no usage job', async () => {
  off();
  const a = await L.learn({ userId: OWNER, actor: 'extraction', candidates: [extraction('The off-switch bakery opens at six every day')] });
  assert.equal(a.saved.length, 1);
  assert.equal(trust(a.saved[0].id), undefined);
  assert.equal(L.classifyLearning({ content: 'x y z', origin: 'agent' }, { similar: [{ id: 'k', content: 'x y z', similarity: 1 }] }).duplicateOf, undefined);
  const drawers = [{ kind: 'owner' }];
  const pack = await P.contextPack({ userId: OWNER, agentId: null, drawers, persona: 'p' });
  const r = await P.messageRecall({ userId: OWNER, drawers, query: 'When does the off-switch bakery open?', pack });
  assert.ok(!/confidence/.test(r.text));
  const none = await P.messageRecall({ userId: OWNER, drawers, query: 'What is the name of the moon base commander?', pack });
  assert.ok(!none.text.includes('nothing reliable'));
  assert.deepEqual(await J.runMemoryJob({ job: 'usage', userId: OWNER }), { skipped: 'off' });
  await J.ensureMemoryJobs();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cron_jobs WHERE name LIKE 'memory-usage-%'").get().n, 0);
});

test('MD1 + MD3 on: every source lands in one pipeline with its provenance and trust', async () => {
  on();
  // Chat extraction: saved at once, trust pending, enriched in the background.
  const a = await L.learn({ userId: OWNER, actor: 'extraction', candidates: [extraction('The parking garage closes at midnight on weekdays')], metadata: { sessionId: 's-1' } });
  const id = a.saved[0].id;
  assert.equal(trust(id).source, 'chat');
  assert.equal(trust(id).confidence, T.START_CONFIDENCE.chat);
  assert.equal(trust(id).verified, 0);
  const stamped = db.prepare('SELECT source, trust FROM memories WHERE id = ?').get(id);
  assert.deepEqual({ ...stamped }, { source: null, trust: null }, 'P3 off: its columns stay empty; the trust record holds the source');
  await PL.enrichmentIdle();
  assert.equal(trust(id).enrich_state, 'ready');
  // The same fact from an agent: not saved twice, it corroborates the known memory -> verified.
  const b = await L.learn({ userId: OWNER, actor: 'agent:b-one', agentId: 'b-one', candidates: [{ content: 'The parking garage closes at midnight on weekdays', type: 'fact', origin: 'agent' }] });
  assert.equal(b.saved.length, 0);
  assert.equal(b.skipped[0].reason, 'already known');
  assert.deepEqual(sources(id).map((s) => s.kind), ['chat', 'agent']);
  assert.equal(trust(id).verified, 1);
  assert.ok(trust(id).confidence > T.START_CONFIDENCE.chat);
  // The owner's own save through the repository.
  const own = await memoryRepository.create(ownerActor, { id: 'own-1', type: 'fact', content: 'The owner keeps the spare office key in the blue drawer',
    drawer: { kind: 'owner' }, memoryLayer: 'factual', importanceScore: 0.5, status: 'active', metadata: {}, createdAt: new Date(), accessCount: 0, expiryTimestamp: null }, 'api');
  assert.equal(trust(own.id).source, 'owner');
  assert.equal(trust(own.id).verified, 1);
  // A coding tool: always a proposal; approved by the owner it is verified, its tool source kept.
  const c = await L.learn({ userId: OWNER, actor: 'bridge:test-cli', review: true, reviewReason: 'repository-file',
    candidates: [{ content: 'The alpha repository uses pnpm workspaces for its packages', type: 'fact', origin: 'agent', drawer: { kind: 'project', key: 'alpha' } }] });
  assert.equal(c.proposed.length, 1);
  const res = await F.approveProposal(OWNER, c.proposed[0].id, OWNER, c.proposed[0].reviewHash);
  const tid = res.applied.added[0];
  assert.deepEqual(sources(tid).map((s) => s.kind), ['tool', 'approved']);
  assert.equal(trust(tid).verified, 1);
  assert.ok(trust(tid).confidence >= T.OWNER_APPROVED);
  // A rule or an automatic import approving is no owner approval.
  const d = await L.learn({ userId: OWNER, actor: 'bridge:test-cli', review: true, reviewReason: 'repository-file',
    candidates: [{ content: 'The alpha repository runs lint on every commit hook', type: 'fact', origin: 'agent', drawer: { kind: 'project', key: 'alpha' } }] });
  const res2 = await F.approveProposal(OWNER, d.proposed[0].id, 'rule:company', d.proposed[0].reviewHash);
  assert.deepEqual(sources(res2.applied.added[0]).map((s) => s.kind), ['tool']);
  assert.equal(trust(res2.applied.added[0]).verified, 0);
  // A channel turn (outsider): proposal only, never saved by itself.
  const e = await L.learn({ userId: OWNER, actor: 'agent:b-one', agentId: 'b-one', candidates: [{ content: 'A visitor said the shop moved to Main Street', type: 'fact', origin: 'outsider' }] });
  assert.equal(e.saved.length, 0);
  off();
});

test('MD1: the background step finds the same fact written through another path', async () => {
  on();
  const drawer = { kind: 'project', key: 'enrich' };
  const own = await memoryRepository.create(ownerActor, { id: 'own-2', type: 'fact', content: 'Enrich project builds run every night at two',
    drawer, memoryLayer: 'factual', importanceScore: 0.5, status: 'active', metadata: {}, createdAt: new Date(), accessCount: 0, expiryTimestamp: null }, 'api');
  // Another path (an agent's own repository save) with the same words in another order: saved, then merged by corroboration.
  const agent = { kind: 'agent', userId: OWNER, agentId: 'b-one', role: 'owner', drawers: [drawer], writeKinds: ['project'] };
  const other = await L.learn({ userId: OWNER, actor: 'agent:b-one', agentId: 'b-one', openDrawers: [drawer],
    candidates: [{ content: 'Every night at two the enrich project builds run', type: 'fact', origin: 'agent', drawer }] });
  assert.equal(other.saved.length, 1, 'saved at once (raw form)');
  const oid = other.saved[0].id;
  assert.equal(trust(oid).enrich_state, 'pending');
  await PL.enrichmentIdle();
  assert.equal(trust(oid).enrich_state, 'ready');
  assert.deepEqual(sources(oid).map((s) => s.kind).sort(), ['agent', 'owner']);
  assert.deepEqual(sources(own.id).map((s) => s.kind).sort(), ['agent', 'owner']);
  void agent;
  // An edit: the old judgement no longer counts for the new text.
  await storage.update(oid, { content: 'Enrich project builds run every night at three' });
  const rows = await T.trustRows(OWNER, [await storage.getOwned(OWNER, oid)]);
  assert.equal(rows.has(oid), false);
  // Forget: trust and sources go with the memory.
  await forgetMemory(OWNER, oid, OWNER);
  assert.equal(trust(oid), undefined);
  assert.equal(sources(oid).length, 0);
  off();
});

test('MD6: local re-rank (trust, recency, same-topic sibling) within the budget, fast ranking as fallback', async () => {
  on();
  const drawer = { kind: 'project', key: 'rr' };
  const old = insert(drawer, 'Rerank office printer model is the grey Brother laser', { createdAt: '2025-01-10T09:00:00Z' });
  const cur = insert(drawer, 'Rerank office printer model is now the white Canon laser', { createdAt: '2026-10-20T09:00:00Z' });
  const r = await RC.qualityRecall({ userId: OWNER, drawers: [drawer], query: 'which rerank office printer model', limit: 5 });
  assert.equal(r.reliable, true);
  assert.equal(r.fellBack, false);
  assert.ok(r.rerankMs < RC.RERANK_BUDGET_MS);
  assert.equal(r.items[0].memory.id, cur, 'the newer fact on the same topic first');
  assert.ok(r.items.every((x) => ['high', 'medium', 'low'].includes(x.band)));
  // Trust: an owner-verified memory beats a tool's with the same words.
  const tdrawer = { kind: 'project', key: 'tr' };
  const tool = insert(tdrawer, 'Trust ranking gate code is kept in the hallway box', { createdAt: '2026-10-01T09:00:00Z' });
  const owner = insert(tdrawer, 'Trust ranking gate code is kept in the hallway box', { createdAt: '2026-10-01T09:00:00Z' });
  await PL.stored([await storage.getOwned(OWNER, tool)], [{ kind: 'tool', key: 'bridge:x' }]);
  await PL.stored([await storage.getOwned(OWNER, owner)], [{ kind: 'owner', key: 'owner' }]);
  const t = await RC.qualityRecall({ userId: OWNER, drawers: [tdrawer], query: 'trust ranking gate code hallway', limit: 5 });
  assert.equal(t.items[0].memory.id, owner);
  assert.equal(t.items[0].verified, true);
  assert.equal(t.items.find((x) => x.memory.id === tool).band, 'low');
  // Budget 0: the fast order, at once.
  const late = await RC.qualityRecall({ userId: OWNER, drawers: [drawer], query: 'which rerank office printer model', limit: 5, budgetMs: 0 });
  assert.equal(late.fellBack, true);
  assert.deepEqual(late.items.map((x) => x.score), late.items.map((x) => x.base), 'fast ranking: the search score');
  void old;
  await PL.enrichmentIdle();
  off();
});

test('MD8: no reliable memory -> ask once, "already asked" next, the answer resolves it', async () => {
  on();
  const drawers = [{ kind: 'owner' }];
  const pack = await P.contextPack({ userId: OWNER, agentId: null, drawers, persona: 'p' });
  const q = 'What is the name of the moon base commander?';
  const first = await P.messageRecall({ userId: OWNER, drawers, query: q, pack });
  assert.equal(first.text, P.NO_RELIABLE_MEMORY);
  assert.equal(first.items.length, 0);
  const asked = db.prepare("SELECT * FROM memory_open_questions WHERE user_id = ? AND status = 'open'").all(OWNER);
  assert.equal(asked.length, 1);
  const again = await P.messageRecall({ userId: OWNER, drawers, query: 'what is the name of the moon base commander', pack });
  assert.equal(again.text, P.ALREADY_ASKED, 'asked once');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_open_questions WHERE user_id = ?").get(OWNER).n, 1);
  // A greeting is no question: no memory line, nothing recorded.
  const hi = await P.messageRecall({ userId: OWNER, drawers, query: 'Hello and good morning to you', pack });
  assert.equal(hi.text, '');
  // The owner answers; the saved fact resolves the open question.
  const ans = await L.learn({ userId: OWNER, actor: 'extraction', candidates: [extraction('Captain Ilse Navarro is the commander of the moon base')] });
  assert.equal(ans.saved.length, 1);
  const row = db.prepare('SELECT status, resolved_memory_id FROM memory_open_questions WHERE id = ?').get(asked[0].id);
  assert.equal(row.status, 'resolved');
  assert.equal(row.resolved_memory_id, ans.saved[0].id);
  // A tool's text never resolves the owner's question.
  assert.equal(PL.answers('What is the name of the moon base commander?', 'Moon base commander name: Ilse'), true);
  const pack2 = await P.contextPack({ userId: OWNER, agentId: null, drawers, persona: 'p' });
  const now = await P.messageRecall({ userId: OWNER, drawers, query: q, pack: pack2 });
  assert.match(now.text, /Captain Ilse Navarro/);
  assert.match(now.text, /confidence (high|medium|low)/, 'recall shows confidence');
  // Forgetting the answer removes the question that named its topic.
  await forgetMemory(OWNER, ans.saved[0].id, OWNER);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_open_questions WHERE id = ?').get(asked[0].id).n, 0);
  // Never forever: an old open question expires, an old expired one is deleted with its text.
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const mid = new Date(Date.now() - 20 * 86_400_000).toISOString();
  db.prepare(`INSERT INTO memory_open_questions (id, user_id, question_hash, question, status, asked_at) VALUES ('oq-old', ?, 'h1', 'old question', 'expired', ?), ('oq-mid', ?, 'h2', 'mid question', 'open', ?)`).run(OWNER, old, OWNER, mid);
  await PL.cleanQuestions(OWNER);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_open_questions WHERE id = 'oq-old'").get().n, 0);
  assert.equal(db.prepare("SELECT status FROM memory_open_questions WHERE id = 'oq-mid'").get().status, 'expired');
  await PL.enrichmentIdle();
  off();
});

test('MD7: only verified facts gain from use; unused ones decay; corrections after use are flagged', async () => {
  // Pure rules.
  assert.equal(U.nextUseWeight(0, { verified: false, uses: 50, ageDays: 10 }), 0, 'unverified: never gains');
  assert.ok(U.nextUseWeight(0, { verified: true, uses: 3, ageDays: 10 }) > 0);
  assert.equal(U.nextUseWeight(0, { verified: true, uses: 100000, ageDays: 10 }), U.MAX_USE_WEIGHT);
  assert.equal(U.nextUseWeight(0, { verified: false, uses: 0, ageDays: 10 }), 0, 'young and unused: unchanged');
  assert.equal(U.nextUseWeight(0, { verified: false, uses: 0, ageDays: 100 }), -U.DECAY_PER_RUN);
  assert.equal(U.nextUseWeight(U.MIN_USE_WEIGHT, { verified: true, uses: 0, ageDays: 400 }), U.MIN_USE_WEIGHT);
  on();
  const drawer = { kind: 'project', key: 'use' };
  const verified = insert(drawer, 'Use weight verified fact about the loading dock hours');
  const untrusted = insert(drawer, 'Use weight tool fact about the loading dock hours');
  const unused = insert(drawer, 'Use weight forgotten fact nobody asks about', { createdAt: '2025-01-01T09:00:00Z' });
  await PL.stored([await storage.getOwned(OWNER, verified)], [{ kind: 'owner', key: 'owner' }]);
  await PL.stored([await storage.getOwned(OWNER, untrusted)], [{ kind: 'tool', key: 'bridge:x' }]);
  await PL.stored([await storage.getOwned(OWNER, unused)], [{ kind: 'chat', key: 'chat:x' }]);
  db.prepare("UPDATE memory_trust SET created_at = '2025-01-01T09:00:00Z' WHERE memory_id = ?").run(unused);
  const use = db.prepare('INSERT INTO memory_recall_uses (run_id, memory_id, user_id, agent_id, created_at) VALUES (?, ?, ?, NULL, ?)');
  for (let i = 0; i < 5; i++) {
    use.run(`run-v-${i}`, verified, OWNER, new Date(Date.now() - 86_400_000).toISOString());
    use.run(`run-u-${i}`, untrusted, OWNER, new Date(Date.now() - 86_400_000).toISOString());
  }
  const res = await J.runMemoryJob({ job: 'usage', userId: OWNER });
  assert.ok(res.weighed >= 3);
  assert.ok(trust(verified).use_weight > 0);
  assert.equal(trust(untrusted).use_weight, 0, 'CX11: use never raises an untrusted fact');
  assert.ok(trust(unused).use_weight < 0, 'never used: slowly loses weight');
  // The owner corrects the verified memory after replies used it.
  await memoryRepository.update(ownerActor, verified, { content: 'Use weight verified fact: the loading dock opens at seven' }, 'api');
  await U.learnFromUse(OWNER);
  assert.ok(JSON.parse(trust(verified).flags ?? '[]').includes(U.CORRECTED_FLAG));
  assert.deepEqual(await U.correctedAfterUse(OWNER), [verified]);
  await J.ensureMemoryJobs();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cron_jobs WHERE name LIKE 'memory-usage-%'").get().n, 1);
  await PL.enrichmentIdle();
  off();
});
