// MEM-READ-01 MR7: a project's size in tokens and who reads it.
// Run: node --import tsx --test test/memory-ask-agent.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const backendDir = process.cwd();
const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-proj-size-')));
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
const OWNER = 'ps-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(OWNER, `${OWNER}@example.test`, OWNER);
const S = await load('src/memory/project-size.ts');
const add = (c) => db.prepare("INSERT INTO memories (id, user_id, type, content, drawer_kind, drawer_key, created_at) VALUES (?, ?, 'fact', ?, 'project', 'grenzer', ?)").run('m' + Math.random().toString(36).slice(2), OWNER, c, new Date().toISOString());

test('size per part: memories, key files and other documents; per reply is capped by the memory budget', async () => {
  add('x'.repeat(3000)); add('y'.repeat(30000));
  db.prepare("INSERT INTO doc_index_sources (id, owner_id, kind, ref_id) VALUES ('s1', ?, 'project', 'grenzer')").run(OWNER);
  for (const [id, p, b] of [['f1', 'CLAUDE.md', 12300], ['f2', 'docs/architecture.md', 3000], ['f3', '.cursor/rules/a.mdc', 300]])
    db.prepare("INSERT INTO doc_index_files (id, source_id, owner_id, root, rel_path, display_path, file_hash, bytes, mtime_ms, status, indexed_at) VALUES (?, 's1', ?, '/p', ?, ?, 'h', ?, 0, 'ok', '2026-11-12')").run(id, OWNER, p, p, b);
  const s = await S.projectSize(OWNER, 'grenzer');
  assert.deepEqual(s.memories, { count: 2, tokens: 11000 });
  assert.deepEqual(s.keyFiles, { count: 2, tokens: 4200 });
  assert.deepEqual(s.documents, { count: 1, tokens: 1000 });
  assert.equal(s.total, 16200);
  assert.ok(s.perReply > 0 && s.perReply < s.memories.tokens);
  assert.deepEqual(s.biggest, { name: 'CLAUDE.md', tokens: 4100 });
  const t = await S.projectLoadText(OWNER, 'grenzer');
  assert.match(t.text, /Memory ≈ 16k tokens .* loads ≈ [\d.]+k? per reply/);
  assert.match(t.text, /Read by: /);
});

test('MR6: key files come first with what they are for; the others after', async () => {
  const D = await S.projectDocuments(OWNER, 'grenzer');
  assert.deepEqual(D.key.map(d => [d.path, d.purpose]), [['CLAUDE.md', 'Instructions for Claude Code'], ['.cursor/rules/a.mdc', 'Rules for Cursor']]);
  assert.deepEqual(D.other.map(d => d.path), ['docs/architecture.md']);
});

test('MR6: today / this week / month from handoffs, only when there was work; agents get the same lines', async () => {
  const P = await load('src/memory/project-summaries.ts');
  const now = new Date(2026, 10, 12, 18, 0, 0); // Thursday 12 Nov 2026
  const at = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
  db.prepare("INSERT INTO agents_config (id, name) VALUES ('ga', 'Grenzer agent')").run();
  const add = (id, when, done, left, next) => db.prepare("INSERT INTO agent_handoffs (id, owner_id, agent_id, scope_kind, scope_id, project_id, version, done, remaining, next_steps, source, created_at) VALUES (?, ?, 'ga', 'conversation', ?, 'grenzer', 1, ?, ?, ?, 'agent', ?)")
    .run(id, OWNER, 'c-' + id, JSON.stringify(done), JSON.stringify(left), JSON.stringify(next), at(when));
  assert.deepEqual(await P.projectSummaries(OWNER, 'grenzer', now), [], 'no work, no rows');
  add('h1', new Date(2026, 10, 12, 10), ['nftables fallback tested on the VPS'], ['backup module tests'], ['release 0.3.1']);
  add('h2', new Date(2026, 10, 10, 10), ['Stripe test mode ready'], [], []);
  add('h3', new Date(2026, 10, 3, 10), ['Backup module designed'], [], []);
  add('h4', new Date(2026, 9, 30, 10), ['Old October work'], [], []);
  const list = await P.projectSummaries(OWNER, 'grenzer', now);
  assert.deepEqual(list.map(s => [s.label, s.sessions]), [['Today', 1], ['This week', 2], ['November', 3]]);
  assert.deepEqual(list[0].done, ['nftables fallback tested on the VPS']);
  assert.deepEqual(list[0].sources, ['Grenzer agent']);
  const text = P.summariesText(list);
  assert.match(text, /### Where the work stands\n- Today \(1 session · Grenzer agent\): Done: nftables fallback tested on the VPS\. Left: backup module tests\. Next: release 0\.3\.1\./);
  assert.doesNotMatch(text, /October/);
});
