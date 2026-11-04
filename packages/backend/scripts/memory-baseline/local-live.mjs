// STORE-MAP-01 P2b (LOCAL-ONLY-01, XP3): one live run of the five memory verbs on the local Ollama
// (loopback only, free), with GIRRU_STORE_P2B and every memory switch on, the model held to an 8k
// window (CHAT_NUM_CTX=8192), through the real chat route (tools on demand, the adaptive budget,
// checked calls). Synthetic facts in a throwaway data folder. The owner accepts each waiting proposal,
// as in the chat. The result is recorded ("memory limited" when it fails) and printed.
// Run from packages/backend: node --import tsx scripts/memory-baseline/local-live.mjs [--model qwen3:4b] [--out f.json]
import { backendDir, dataRoot, addUser, argValue, cleanup, ollamaHas, openDb, quietly, OLLAMA } from './env.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MODEL = argValue('model', 'qwen3:4b');
const out = argValue('out', null);
if (!(await ollamaHas(MODEL))) { console.error(`${MODEL} is not on the local Ollama`); process.exit(2); }
process.env.OLLAMA_URL = OLLAMA;
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.NODE_ENV = 'test';
process.env.CHAT_NUM_CTX = '8192';
delete process.env.OLLAMA_THINK; // the chat's own default (thinking stays out of the answer)
process.env.AGENT_PLAYER_CONFIG_DIR = join(dataRoot, 'cli-config');
for (const k of ['GIRRU_STORE_PILOT', 'GIRRU_STORE_P2', 'GIRRU_STORE_P3', 'GIRRU_STORE_P4', 'GIRRU_STORE_P5', 'GIRRU_STORE_P6', 'GIRRU_STORE_P7', 'GIRRU_STORE_P8', 'GIRRU_STORE_P9', 'GIRRU_STORE_P9B', 'GIRRU_STORE_P2B']) process.env[k] = '1';
mkdirSync(join(dataRoot, '.data', 'multi-agent'), { recursive: true });

// Every model request is recorded (sizes only) to show it fits the window.
const requests = [];
const guarded = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url) === `${OLLAMA}/api/chat`) { const b = JSON.parse(init.body); requests.push({ numCtx: b.options?.num_ctx, numPredict: b.options?.num_predict, tools: (b.tools ?? []).map((t) => t.function.name), chars: JSON.stringify(b.messages).length + JSON.stringify(b.tools ?? []).length }); }
  if (String(url) === `${OLLAMA}/api/generate`) return new Response('{"error":"background off in this run"}', { status: 503 });
  return guarded(url, init);
};

const { db } = await openDb();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await quietly(() => getCredentialStorage().initialize());
const { getOrchestrator } = await import(join(backendDir, 'src/multi-agent/index.ts'));
await quietly(() => getOrchestrator().initialize(join(dataRoot, '.data', 'multi-agent', 'orchestrator.db')));
const OWNER = 'live-owner';
addUser(db, OWNER, 'owner');
db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(OWNER);
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary, system_prompt) VALUES ('live-main', 'Rafid', 'ollama', ?, 1, 'You are Rafid. Keep answers short. Use your memory tools when asked to remember, recall, correct, hand off or propose.')`).run(MODEL);
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { createConversation } = await import(join(backendDir, 'src/repositories/chat-conversations.ts'));
const { recordLocalConformance } = await import(join(backendDir, 'src/memory/local-conformance.ts'));
const app = await quietly(() => buildServer({ logger: false }));
await quietly(() => app.ready());
const auth = { authorization: `Bearer ${generateToken(OWNER, 1)}` };
const call = (method, url, payload) => app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
async function approvePending() {
  const list = (await call('GET', '/api/memory/proposals?status=pending')).json();
  let n = 0;
  const statuses = [];
  for (const p of list.proposals ?? list.items ?? list) {
    const full = (await call('GET', `/api/memory/proposals/${p.id}`)).json();
    if (/two reviewers/i.test(JSON.stringify(full))) continue; // the propose step stays waiting for the owner
    const r = await call('POST', `/api/memory/proposals/${p.id}/approve`, { expectedReviewHash: full.reviewHash ?? full.proposal?.reviewHash });
    statuses.push(r.statusCode);
    n++;
  }
  return { n, statuses };
}

const conv = await createConversation(OWNER, { title: 'P2b live', agentId: 'live-main' });
const TURNS = [
  ['save', 'Remember this with the topic key "orbit-release-day": The Orbit release day is Friday.'],
  ['recall', 'Search your memory: what is the Orbit release day?'],
  ['supersede', 'Correction: the Orbit release day is Thursday. Save it with the same topic key "orbit-release-day" so it replaces the old one.'],
  ['handoff', 'Leave a handoff note now: done = moved the Orbit release; next = tell the team.'],
  ['propose', 'Save this decision with importance 9 so the owner reviews it: every Orbit release needs two reviewers.'],
  ['last', 'Search your memory again: what is the Orbit release day now? Answer with the day only.'],
];
const history = [];
const rows = [];
for (const [verb, text] of TURNS) {
  history.push({ role: 'user', content: text });
  const started = Date.now();
  const before = requests.length;
  const r = await quietly(() => call('POST', '/api/chat', { stream: true, agentId: 'live-main', sessionId: conv.id, messages: history }));
  const frames = r.body.split('\n').filter((l) => l.startsWith('data: ')).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
  const answer = frames.filter((f) => f.type === 'text').map((f) => f.content).join('');
  const tools = frames.filter((f) => f.type === 'tool_start').flatMap((f) => f.tools.map((t) => ({ name: t.name, input: t.input })));
  const results = frames.filter((f) => f.type === 'tool_result').flatMap((f) => f.results.map((x) => ({ name: x.name, isError: x.isError, output: x.output.slice(0, 300) })));
  const approved = await approvePending();
  history.push({ role: 'assistant', content: answer || '(no text)' });
  rows.push({ verb, ms: Date.now() - started, tools, results, answer: answer.slice(-600), approved, requests: requests.slice(before) });
}

const used = (names) => rows.some((r) => r.results.some((x) => names.includes(x.name) && !x.isError));
const facts = db.prepare(`SELECT content, valid_to, superseded_by, status, metadata FROM memories WHERE user_id = ? AND (content LIKE '%Orbit%' OR content LIKE '%hursday%' OR content LIKE '%riday%' OR metadata LIKE '%orbit-release-day%')`).all(OWNER);
const current = facts.filter((m) => !m.valid_to && !m.superseded_by && m.status !== 'superseded' && m.status !== 'deleted');
const handoffs = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'agent_handoffs'`).get().n
  ? db.prepare('SELECT COUNT(*) AS n FROM agent_handoffs').get().n : null;
const pending = (await call('GET', '/api/memory/proposals?status=pending')).json();
const last = rows.at(-1);
const checks = {
  save: rows[0].results.some((x) => x.name === 'memory_save' && !x.isError),
  recall: /friday/i.test(rows[1].answer),
  supersede: current.some((m) => /thursday/i.test(m.content)) && !current.some((m) => /friday/i.test(m.content) && !/thursday/i.test(m.content)),
  handoff: rows[3].results.some((x) => x.name === 'handoff_save' && !x.isError),
  propose: JSON.stringify(pending).includes('two reviewers'),
  lastRecall: /thursday/i.test(last.answer) && !/friday/i.test(last.answer),
  fits8k: requests.every((q) => q.numCtx === 8192 && Math.ceil(q.chars / 3) <= 8192 - (q.numPredict ?? 0)),
};
const failures = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
const record = recordLocalConformance({ provider: 'ollama', model: MODEL, passed: failures.length === 0, failures, window: requests[0]?.numCtx ?? null });
const report = { memories: facts.map((m) => ({ content: m.content.slice(0, 120), status: m.status, replaced: !!(m.valid_to || m.superseded_by) })), pendingProposals: JSON.stringify(pending).slice(0, 600), model: MODEL, window: 8192, passed: record.passed, memoryLimited: !record.passed, failures, checks, handoffRows: handoffs, usedTools: [...new Set(rows.flatMap((r) => r.tools.map((t) => t.name)))],
  turns: rows.map((r) => ({ verb: r.verb, ms: r.ms, tools: r.tools.map((t) => `${t.name} ${t.input.slice(0, 120)}`), errors: r.results.filter((x) => x.isError).map((x) => `${x.name}: ${x.output.slice(0, 160)}`), answer: r.answer, requests: r.requests.map((q) => ({ numCtx: q.numCtx, numPredict: q.numPredict, tools: q.tools.length, estTokens: Math.ceil(q.chars / 3) })) })) };
console.log(JSON.stringify(report, null, 2));
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
await app.close();
cleanup();
process.exit(0);
