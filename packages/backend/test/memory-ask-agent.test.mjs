// MEM-READ-01 MR5: Ask an agent in the shared editor — a proposal only; hidden keys never leave.
//  - the agent sees hidden-key references and placeholders for keys still in clear, never a value;
//  - its proposal keeps them; a key it writes in clear is hidden; nothing is saved;
//  - bad input, an unknown agent and an answer without a document are refused.
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
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-ask-agent-')));
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
const OWNER = 'ask-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(OWNER, `${OWNER}@example.test`, OWNER);
const A = await load('src/memory/ask-agent.ts');
db.prepare("INSERT INTO agents_config (id, name, model, provider) VALUES ('grenzer-agent', 'Grenzer agent', 'qwen3.5:9b', 'ollama')").run();

test('the agent gets placeholders, never key values; the proposal keeps them; a new clear key is hidden', async () => {
  const seen = [];
  const answer = async (_t, prompt) => { seen.push(prompt); const doc = /<document>\n([\s\S]*?)\n<\/document>/.exec(prompt)[1];
    return `<document>\n${doc}\n**SSH port:** 2222\nnew token=${'tok_' + 'Q1w2E3r4T5y6U7i8O9p0'}\n</document>\nNote: Added the SSH port.`; };
  const text = `# VPS\n**SSH login:** [SECRET:password:k3j9x0a1bq]\nadmin password: ${'Clear-Test-Pass-77'}`;
  const out = await A.askAgentToEdit(OWNER, { agentId: 'grenzer-agent', request: 'Add the SSH port 2222', text }, { answer });
  assert.doesNotMatch(seen[0], /Clear-Test-Pass-77/);
  assert.match(seen[0], /\[SECRET:password:k3j9x0a1bq\]/);
  assert.match(seen[0], /\[KEEP:0\]/);
  assert.match(out.text, /\[SECRET:password:k3j9x0a1bq\]/);
  assert.match(out.text, /\*\*SSH port:\*\* 2222/);
  assert.doesNotMatch(out.text, /Q1w2E3r4|Clear-Test-Pass-77/);
  assert.equal(out.note, 'Added the SSH port.');
  // Nothing was saved: no memory was written.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM memories WHERE user_id = ?').get(OWNER).n, 0);
});

test('bad input, unknown agent, and an answer without a document are refused', async () => {
  const answer = async () => 'I changed it.';
  await assert.rejects(A.askAgentToEdit(OWNER, { agentId: 'grenzer-agent', request: '', text: 'x' }, { answer }), /Say what should change/);
  await assert.rejects(A.askAgentToEdit(OWNER, { agentId: 'nobody', request: 'x', text: 'x' }, { answer }), /Agent not found/);
  await assert.rejects(A.askAgentToEdit(OWNER, { agentId: 'grenzer-agent', request: 'x', text: 'x' }, { answer }), /did not answer with a document/);
  assert.deepEqual(A.parseAnswer('<document>\na\nb\n</document>\nNote: done'), { text: 'a\nb', note: 'done' });
});

test('the ask runs as a job for its owner only', async () => {
  const answer = async (_t, prompt) => `thinking <document>\nnot this\n</document> then\n<document>\n${/<document>\n([\s\S]*?)\n<\/document>/.exec(prompt)[1]}\nmore\n</document>\nNote: ok`;
  const id = A.startAskJob(OWNER, { agentId: 'grenzer-agent', request: 'add more', text: 'line' }, { answer });
  assert.equal(A.askJob('someone-else', id), null);
  let r; for (let i = 0; i < 50 && (r = A.askJob(OWNER, id)).state === 'running'; i++) await new Promise(res => setTimeout(res, 10));
  assert.deepEqual(r, { state: 'done', text: 'line\nmore', note: 'ok', agentId: 'grenzer-agent' });
});
