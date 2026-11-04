// STORE-MAP-01 P9 (GIRRU_STORE_P9) memory quality, M1–M4 and M7.
//  - M1 write side: one fact per memory, duplicates caught on write (any order or form),
//    an extraction never gives itself a pinned importance; a fixed test set of cases;
//  - M2 a lesson repeated in the experience drawer becomes a rule or skill PROPOSAL, once;
//  - M3 recall ranks by the agent's specialty, department and team (same memories, other order);
//  - M4 keeping the new side of a contradiction supersedes the old fact (valid_to, superseded_by);
//  - M7 a periodic, versioned project summary that never rides in every prompt;
//  - off: nothing of this changes today's behaviour.
// Run: node --import tsx --test test/store-p9-quality.test.mjs
// Throwaway DB + cwd + HOME, random test-only secrets, no network, no real model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { clearEnv } from './helpers/switches.mjs';
const backendDir = process.cwd();
const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-store-p9-quality-')));
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
for (const k of ['GIRRU_STORE_P9', 'GIRRU_STORE_P3', 'GIRRU_STORE_P2']) clearEnv(k);
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await load('src/db/database.ts');
const db = getDatabase();
await db.initialize();
const OWNER = 'p9q-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(OWNER, `${OWNER}@example.test`, OWNER);
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary, department, specialty) VALUES
  ('q-back', 'Back', 'ollama', 'qwen-test', 0, 'backend', 'Database API engineer'),
  ('q-back2', 'Back2', 'ollama', 'qwen-test', 0, 'backend', NULL),
  ('q-mkt', 'Mkt', 'ollama', 'qwen-test', 0, 'marketing', 'Social campaign writer')`).run();

const W = await load('src/memory/write-quality.ts');
const L = await load('src/memory/learning.ts');
const F = await load('src/memory/memory-files.ts');
const P = await load('src/memory/context/pack.ts');
const R = await load('src/memory/agent-relevance.ts');
const J = await load('src/memory/jobs.ts');
const S = await load('src/memory/project-summary.ts');
const { getMemoryStorage } = await load('src/memory/storage.ts');
const storage = getMemoryStorage();
await storage.initialize();

const on = () => { process.env.GIRRU_STORE_P9 = '1'; };
const off = () => { process.env.GIRRU_STORE_P9 = '0'; };
const row = (id) => db.prepare('SELECT id, content, status, valid_to, superseded_by, topic_key, importance_score FROM memories WHERE id = ?').get(id);
const extraction = (content, importance = 5) => ({ content, type: 'fact', importance, origin: 'extraction' });
let n = 0;
const insert = (drawer, content, extra = {}) => {
  const id = `q-${++n}`;
  db.prepare(`INSERT INTO memories (id, user_id, type, content, memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, drawer_key, source_agent_id)
    VALUES (?, ?, ?, ?, 'factual', 'active', '{}', ?, ?, 0, ?, ?, ?)`)
    .run(id, OWNER, extra.type ?? 'fact', content, extra.importance ?? 0.5, new Date(Date.now() - 1000 * (1000 - n)).toISOString(), drawer.kind, drawer.key ?? '', extra.agent ?? null);
  return id;
};

// M1: the write-side test set. Each case: the text, the facts it holds.
const SPLIT_CASES = [
  ['User lives in Berlin. User works as a nurse at the city hospital.', 2],
  ['User prefers dark mode in every editor', 1],
  ['User has a cat. She is called Mimi and likes fish.', 1], // the second part leans back
  ['The deploy runs on Fridays, e.g. after the weekly review meeting.', 1],
  ['Project alpha ships in March; Project beta waits for the new design system.', 2],
  ['- User drinks green tea every morning\n- User walks to the office every day', 2],
  ['المستخدم يسكن في بغداد. المستخدم يعمل مهندس برمجيات في شركة.', 2],
  ['A. B. C.', 1],
];
const DUPLICATE_CASES = [
  ['User prefers dark mode', 'dark mode is preferred by the user', true],
  ['The release happens every Friday', 'Every Friday the release happens', true],
  ['User likes tea', 'User likes coffee', false],
  ['User likes tea', 'User does not like tea', false],
  ['Tea', 'tea!', false], // too short for a near-duplicate (word-for-word still catches it)
  ['Deploys run on Friday evenings', 'Deploys never run on Friday evenings', false],
  ['The team should merge on Fridays', 'The team merges on Fridays', false],
  ['Am Freitag wird deployed', 'Am Freitag wird nicht deployed', false],
  ['المستخدم يشرب القهوة صباحا', 'المستخدم لا يشرب القهوة صباحا', false],
];

test('M1 test set: one fact per memory and near-duplicates (pure)', () => {
  for (const [text, facts] of SPLIT_CASES) assert.equal(W.splitFacts(text).length, facts, text);
  for (const [a, b, same] of DUPLICATE_CASES) assert.equal(W.nearDuplicate(a, b), same, `${a} / ${b}`);
  assert.equal(W.calibratedImportance('extraction', 10), W.EXTRACTED_MAX_IMPORTANCE);
  assert.equal(W.calibratedImportance('owner', 10), 10);
  assert.equal(W.calibratedImportance('extraction', 4), 4);
});

test('off: learning saves as today (no split, no near-duplicate, no importance cap)', async () => {
  off();
  const a = await L.learn({ userId: OWNER, actor: 'extraction', candidates: [extraction('The bakery opens at six. The bakery closes at noon on Saturdays.', 9)] });
  assert.equal(a.saved.length, 1);
  assert.equal(a.saved[0].importance, 9);
  const b = await L.learn({ userId: OWNER, actor: 'extraction', candidates: [extraction('at six the bakery opens')] });
  assert.equal(b.saved.length, 1, 'not caught while off');
  assert.deepEqual(await J.runMemoryJob({ job: 'quality', userId: OWNER }), { skipped: 'off' });
  await J.ensureMemoryJobs();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cron_jobs WHERE name LIKE 'memory-quality-%'").get().n, 0);
});

test('M1 on: an extraction is split per fact, near-duplicates are known, importance is calibrated', async () => {
  on();
  const a = await L.learn({ userId: OWNER, actor: 'extraction', candidates: [extraction('User plays chess every Sunday. User studies Portuguese at night school.', 9)] });
  assert.equal(a.saved.length, 2, 'one memory per fact');
  assert.ok(a.saved.every((m) => m.importance === W.EXTRACTED_MAX_IMPORTANCE), 'no pinned importance from extraction');
  const b = await L.learn({ userId: OWNER, actor: 'extraction', candidates: [extraction('every Sunday the user plays chess')] });
  assert.equal(b.saved.length, 0);
  assert.equal(b.skipped[0]?.reason, 'already known');
  // The owner's own save keeps its importance and is never split.
  const c = await L.learn({ userId: OWNER, actor: `owner:${OWNER}`, candidates: [{ content: 'Weekly sync is on Tuesday. Retro is on Thursday.', type: 'fact', importance: 9, origin: 'owner' }] });
  assert.equal(c.saved.length, 1);
  assert.equal(c.saved[0].importance, 9);
  await J.ensureMemoryJobs();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cron_jobs WHERE name LIKE 'memory-quality-%'").get().n, 1);
  off();
});

async function conflictProposal(content) {
  const out = await L.learn({ userId: OWNER, actor: 'extraction', candidates: [extraction(content)] });
  assert.equal(out.proposed.length, 1, `a conflict proposal for: ${content}`);
  assert.ok(out.proposed[0].conflictWith);
  return out.proposed[0];
}

test('M4 off: keep new writes the new text over the old memory (today)', async () => {
  off();
  const old = (await L.learn({ userId: OWNER, actor: 'extraction', candidates: [extraction('The office printer is enabled for guests')] })).saved[0];
  const p = await conflictProposal('The office printer is disabled for guests');
  assert.equal(p.conflictWith, old.id);
  const r = await F.decideConflict(OWNER, p.id, 'keep_new', OWNER, p.reviewHash);
  assert.deepEqual(r.applied.updated, [old.id]);
  assert.equal(r.applied.replaced, undefined);
  assert.equal(row(old.id).content, 'The office printer is disabled for guests');
  assert.equal(row(old.id).superseded_by, null);
});

test('M4 on: keep new supersedes the old fact; it stays in History with valid_to', async () => {
  on();
  const old = (await L.learn({ userId: OWNER, actor: 'extraction', candidates: [{ ...extraction('The staging server is open on weekends'), topicKey: 'staging weekends' }] })).saved[0];
  const p = await conflictProposal('The staging server is closed on weekends');
  assert.equal(p.conflictWith, old.id);
  const r = await F.decideConflict(OWNER, p.id, 'keep_new', OWNER, p.reviewHash);
  assert.deepEqual(r.applied.replaced, [old.id]);
  assert.equal(r.applied.updated.length, 0);
  const [newId] = r.applied.added;
  const was = row(old.id);
  assert.equal(was.content, 'The staging server is open on weekends', 'old text kept');
  assert.equal(was.status, 'replaced');
  assert.ok(was.valid_to);
  assert.equal(was.superseded_by, newId);
  const now = row(newId);
  assert.equal(now.content, 'The staging server is closed on weekends');
  assert.equal(now.status, 'active');
  assert.equal(now.topic_key, 'staging-weekends', 'the topic moves to the current fact');
  assert.equal((await storage.getByTopicKey(OWNER, { kind: 'owner' }, 'staging-weekends')).id, newId);
  const versions = db.prepare('SELECT change FROM memory_versions WHERE memory_id = ? ORDER BY version').all(old.id).map((v) => v.change);
  assert.ok(versions.includes('create') || versions.includes('baseline'), 'old history kept');
  // Keep both and keep old are unchanged.
  const p2 = await conflictProposal('The staging server is open on weekends');
  const r2 = await F.decideConflict(OWNER, p2.id, 'keep_old', OWNER, p2.reviewHash);
  assert.equal(r2.applied, null);
  assert.equal(row(newId).status, 'active');
  off();
});

test('M3: recall ranks the same memories by specialty, department and team', async () => {
  const drawer = { kind: 'project', key: 'rank' };
  const api = insert(drawer, 'Launch checklist rank alpha: database API pooling settings');
  const ads = insert(drawer, 'Launch checklist rank alpha: social campaign posting slots');
  const team = insert(drawer, 'Launch checklist rank alpha: rollback plan and owner on call', { agent: 'q-back2' });
  const drawers = [drawer];
  const recallFor = async (agentId) => {
    const pack = await P.contextPack({ userId: OWNER, agentId, drawers, persona: `persona ${agentId}` });
    const r = await P.messageRecall({ userId: OWNER, drawers, query: 'launch checklist rank alpha', pack, agentId });
    return r.items.map((i) => i.id);
  };
  off();
  // P9b's re-rank (MD6) uses the agent's relevance too: "off" here means both off.
  const p9b = process.env.GIRRU_STORE_P9B;
  process.env.GIRRU_STORE_P9B = '0';
  const offBack = await recallFor('q-back');
  const offMkt = await recallFor('q-mkt');
  if (p9b !== undefined) process.env.GIRRU_STORE_P9B = p9b;
  assert.deepEqual(offBack, offMkt, 'off: the agent does not change the order');
  on();
  const back = await recallFor('q-back');
  const mkt = await recallFor('q-mkt');
  assert.deepEqual([...back].sort(), [...offBack].sort(), 'the same memories, no more');
  assert.equal(back.length, offBack.length, 'the prompt gets no extra memory');
  assert.ok(back.indexOf(api) < back.indexOf(ads), 'backend agent: the API memory first');
  assert.ok(back.indexOf(team) < back.indexOf(ads), 'backend agent: its team mate\'s memory before marketing');
  assert.ok(mkt.indexOf(ads) < mkt.indexOf(api), 'marketing agent: the campaign memory first');
  const profile = await R.agentProfile('q-back');
  assert.ok(profile.team.has('q-back2') && !profile.team.has('q-mkt'));
  assert.equal(await R.agentProfile('missing-agent'), null);
  assert.equal(R.rankedScore(0.5, null, { content: 'x' }), 0.5);
  assert.ok(R.rankedScore(0.5, profile, { content: 'database api' }) <= 0.5 * (1 + R.AGENT_RELEVANCE_WEIGHT));
  off();
});

test('M2: a repeated lesson becomes a rule or skill proposal, once; nothing changes by itself', async () => {
  const exp = { kind: 'experience' };
  for (const t of [
    'Always run the migration test before pushing a schema change',
    'Always run the migration test before you push any schema change',
    'Run the migration test always before pushing schema changes',
  ]) insert(exp, t, { type: 'insight' });
  for (const t of [
    'The embedding endpoint answers 404 when the local model is not pulled yet',
    'Embedding endpoint 404 means the local model was not pulled',
    'A 404 from the embedding endpoint: the local model is not pulled',
  ]) insert(exp, t, { type: 'insight' });
  insert(exp, 'Unrelated single lesson about screenshots in dark mode', { type: 'insight' });
  const activeRules = () => db.prepare("SELECT COUNT(*) AS n FROM agent_rules WHERE status = 'active'").get().n;
  const rulesBefore = activeRules();
  const skillsBefore = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND type = 'skill'").get(OWNER).n;
  on();
  const res = await J.runMemoryJob({ job: 'quality', userId: OWNER });
  assert.equal(res.lessons, 2);
  const rule = db.prepare("SELECT * FROM agent_rules WHERE status = 'suggested' AND reason LIKE '%lesson:%'").get();
  assert.ok(rule, 'an instruction becomes a suggested rule');
  assert.match(rule.text, /migration test/);
  assert.equal(activeRules(), rulesBefore, 'a suggested rule is never sent before the owner accepts it');
  const prop = db.prepare("SELECT * FROM memory_file_proposals WHERE user_id = ? AND reasons LIKE '%lesson-promotion%'").get(OWNER);
  assert.ok(prop, 'a finding becomes a skill proposal');
  assert.equal(prop.status, 'pending');
  assert.equal(prop.drawer_kind, 'experience');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND type = 'skill'").get(OWNER).n, skillsBefore, 'nothing saved before approval');
  assert.equal((await J.runMemoryJob({ job: 'quality', userId: OWNER })).lessons, 0, 'proposed once');
  // Rejected: still not proposed again.
  const p = await F.getProposal(OWNER, prop.id);
  await F.rejectProposal(OWNER, p.id, OWNER, p.reviewHash);
  assert.equal((await J.runMemoryJob({ job: 'quality', userId: OWNER })).lessons, 0);
  off();
});

test('M7: a versioned project summary; unchanged = no new version; never in every prompt', async () => {
  const drawer = { kind: 'project', key: 'summ' };
  for (let i = 1; i <= 5; i++) insert(drawer, `Summ project fact number ${i} about the billing module`, { importance: i / 10 });
  const drawers = [drawer];
  const packText = async (tag) => (await P.contextPack({ userId: OWNER, agentId: null, drawers, persona: `p-${tag}` })).text;
  const before = await packText('a');
  on();
  const first = await S.runProjectSummaries(OWNER);
  const mine = first.find((x) => x.drawer === 'project:summ');
  assert.ok(mine);
  assert.equal(mine.version, 1);
  const v1 = row(mine.memoryId);
  assert.equal(v1.topic_key, S.PROJECT_SUMMARY_TOPIC);
  assert.match(v1.content, /^Project summary \(version 1, as of \d{4}-\d{2}-\d{2}\)\n5 memories: fact 5\./);
  assert.match(v1.content, /Most important:\n- Summ project fact number 5/);
  assert.ok(v1.content.length <= S.SUMMARY_CHARS + 60);
  assert.equal((await S.runProjectSummaries(OWNER)).filter((x) => x.drawer === 'project:summ').length, 0, 'nothing changed, nothing written');
  assert.equal(await packText('b'), before.replace('p-a', 'p-b'), 'the summary is not a standing topic of every prompt');
  insert(drawer, 'Summ project fact number 6 about the billing module');
  const second = (await S.runProjectSummaries(OWNER)).find((x) => x.drawer === 'project:summ');
  assert.equal(second.version, 2);
  assert.equal(second.replaced, mine.memoryId);
  assert.equal(row(mine.memoryId).status, 'replaced');
  assert.equal(row(mine.memoryId).superseded_by, second.memoryId);
  const versions = await S.projectSummaryVersions(OWNER, drawer);
  assert.deepEqual(versions.map((v) => v.current), [true, false]);
  assert.match(versions[0].content, /version 2/);
  // Below the minimum: no summary.
  const tiny = { kind: 'project', key: 'tiny' };
  insert(tiny, 'Only one tiny memory here');
  assert.equal(await S.buildProjectSummary(OWNER, tiny), null);
  off();
});

test('forget reaches what quality built: lesson rules and proposals, project summaries', async () => {
  on();
  const F2 = await load('src/memory/forget.ts');
  const exp = { kind: 'experience' };
  const ids = [
    insert(exp, 'Never deploy the forgetme service on a public holiday', { type: 'insight' }),
    insert(exp, 'Never deploy the forgetme service on public holidays', { type: 'insight' }),
    insert(exp, 'Do not deploy the forgetme service on a public holiday ever', { type: 'insight' }),
    insert(exp, 'The forgetme cache warms up in about ninety seconds', { type: 'insight' }),
    insert(exp, 'The forgetme cache warms up within ninety seconds', { type: 'insight' }),
    insert(exp, 'Warming the forgetme cache takes about ninety seconds', { type: 'insight' }),
  ];
  const props = await (await load('src/memory/lessons.ts')).promoteLessons(OWNER);
  const rule = props.find((x) => x.kind === 'rule');
  const skill = props.find((x) => x.kind === 'skill');
  assert.ok(rule && skill);
  const why = db.prepare('SELECT reason FROM agent_rules WHERE id = ?').get(rule.id).reason;
  assert.ok(ids.slice(0, 3).every((id) => why.includes(id)), 'the rule keeps its source ids');
  await F2.forgetMemory(OWNER, ids[2], OWNER);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_rules WHERE id = ?').get(rule.id).n, 0, 'the suggested rule goes with a source');
  await F2.forgetMemory(OWNER, ids[5], OWNER);
  const p = db.prepare('SELECT status, changes FROM memory_file_proposals WHERE id = ?').get(skill.id);
  assert.equal(p.status, 'cancelled');
  assert.doesNotMatch(p.changes, /forgetme/, 'no text kept in the cancelled proposal');
  // A project summary (current and replaced) goes when a memory it quotes is forgotten.
  const drawer = { kind: 'project', key: 'forg' };
  const mids = [];
  for (let i = 1; i <= 5; i++) mids.push(insert(drawer, `Forg project secret fact number ${i}`, { importance: 0.9 - i / 20 }));
  await S.runProjectSummaries(OWNER);
  insert(drawer, 'Forg project fact number six');
  await S.runProjectSummaries(OWNER);
  assert.equal((await S.projectSummaryVersions(OWNER, drawer)).length, 2);
  await F2.forgetMemory(OWNER, mids[0], OWNER);
  assert.equal((await S.projectSummaryVersions(OWNER, drawer)).length, 0, 'every summary version is gone');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_versions WHERE user_id = ? AND content LIKE '%secret fact number 1%'").get(OWNER).n, 0);
  const again = (await S.runProjectSummaries(OWNER)).find((x) => x.drawer === 'project:forg');
  assert.equal(again.version, 1, 'rebuilt from what is left');
  assert.doesNotMatch(row(again.memoryId).content, /number 1\b/);
  off();
});
