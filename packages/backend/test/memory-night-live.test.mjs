// MEM-LIVE-01: night work says what it does — the file it is on, a short list newest first, Stop after the file.
// Run: node --import tsx --test test/memory-night-live.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const backendDir = process.cwd();
const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-night-live-')));
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
const OWNER = 'live-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(OWNER, `${OWNER}@example.test`, OWNER);
// MEM-PANEL-01: the real RAM check is not part of these tests (unknown = go on).
(await load('src/memory/helper-settings.ts')).setRamDeps({ availableBytes: async () => null });
const N = await load('src/memory/night-work.ts');

const state = async () => ({ idleSeconds: 9999, onPower: true });
let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 12, 1, 4, clock++));

test('while it runs: the step, the file it is on, files read so far and the list, newest first', async () => {
  let release, seenMid;
  const gate = new Promise((r) => { release = r; });
  const steps = {
    async readFiles(_o, hooks) {
      for (const f of ['README.md', 'docs/storage-map.md']) { hooks.onFile({ project: 'girru', file: f, phase: 'reading' }); hooks.onFile({ project: 'girru', file: f, phase: 'read' }); }
      hooks.onFile({ project: 'girru', file: 'notes/today.md', phase: 'reading' });
      seenMid = N.nightRunning(OWNER);
      await gate;
      return { files: 2, projects: 1, proposals: 3, bySlug: { girru: 2 } };
    },
    async summaries(_o, _n, hooks) { hooks.onSummary('Girru', 'girru'); return { names: ['Girru'], slugs: ['girru'] }; },
    async tidy() { return { keys: 0, duplicates: 1 }; },
  };
  const run = N.runNightWork(OWNER, { force: true, state, now, steps });
  await new Promise((r) => setImmediate(r));
  assert.equal(seenMid.running, true);
  assert.deepEqual({ step: seenMid.now.step, file: seenMid.now.file, project: seenMid.now.project, read: seenMid.now.read }, { step: 'read', file: 'notes/today.md', project: 'girru', read: 2 });
  const mid = await N.nightEvents(OWNER);
  assert.deepEqual(mid.map((e) => e.text), ['Read docs/storage-map.md', 'Read README.md', 'Started (Run now)']);
  release();
  const report = await run;
  assert.equal(report.stopped, 'done');
  assert.equal(N.nightRunning(OWNER).now, null, 'nothing live after it ends');
  const kinds = (await N.nightEvents(OWNER)).map((e) => e.kind);
  assert.deepEqual(kinds, ['done', 'tidy', 'summary', 'idea', 'read', 'read', 'start'], 'the last run is kept with the report');
  const texts = (await N.nightEvents(OWNER)).map((e) => e.text);
  assert.equal(texts[0], 'Done: 2 files read, 1 summary, 3 ideas');
  assert.equal(texts[3], '3 ideas wait for you in Needs you');
  assert.ok(texts.every((t) => !/password|secret/i.test(t)));
});

test('Stop ends after the file it is on; nothing after it runs', async () => {
  let summaries = 0;
  const steps = {
    async readFiles(_o, hooks) {
      let read = 0;
      for (const f of ['a.md', 'b.md', 'c.md']) {
        if (hooks.shouldStop()) break;
        hooks.onFile({ project: 'girru', file: f, phase: 'reading' });
        if (f === 'a.md') N.stopNightWorkFor(OWNER);
        hooks.onFile({ project: 'girru', file: f, phase: 'read' }); read++;
      }
      return { files: read, projects: 1, proposals: 0 };
    },
    async summaries() { summaries++; return []; },
    async tidy() { return { keys: 0, duplicates: 0 }; },
  };
  const report = await N.runNightWork(OWNER, { force: true, state, now, steps });
  assert.equal(report.stopped, 'stopped');
  assert.equal(report.files, 1, 'only the file it was on');
  assert.equal(summaries, 0, 'the next steps never start');
  const ev = await N.nightEvents(OWNER);
  assert.equal(ev[0].kind, 'stopped');
  assert.match(ev[0].text, /Run now goes on/);
});

test('the agent status tool lists what it did, newest first', async () => {
  const H = await load('src/tools/memory/helper.ts');
  const ctx = { workspaceDir: dir, userId: OWNER, agentId: 'live-agent', memoryDrawers: [{ kind: 'owner' }] };
  const res = await H.memoryHelperStatusTool.execute({}, ctx);
  assert.equal(res.error, undefined, res.error);
  assert.ok(Array.isArray(res.data.events));
  assert.match(res.content[0].text, /Last run, newest first:/);
});
