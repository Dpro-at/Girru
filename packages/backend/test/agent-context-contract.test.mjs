// STORE-MAP-01 P2 contract (CX6, AG1, AG6): what every entry point gives the same agent.
// With GIRRU_STORE_P2 off nothing changes (the known gaps are pinned here: chat drops the hired
// instructions, task runs drop the owner rules, skills go in as full text). With it on:
//  - chat, task run and coding app all carry the agent's name, its hired instructions and its
//    owner rules, rules first, grouped by precedence (safety, project, the agent, its department,
//    all agents);
//  - skills and specialties are listed by name and one line; guide_read loads one of the agent's
//    own guides and nothing else;
//  - a channel turn gets the same definition but no owner memory.
// Run: node --import tsx --test test/agent-context-contract.test.mjs
// Throwaway DB/keys; the local model is a stub that records the request (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-context-contract-')));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
for (const k of ['AGENT_EXEC_TOOLS', 'OLLAMA_THINK', 'DEFAULT_MODEL', 'OUTSIDER_AGENT_MEMORY', 'GIRRU_STORE_P2', 'GIRRU_STORE_P8', 'GIRRU_STORE_PILOT', 'GIRRU_STORE_PILOT_AGENT']) delete process.env[k];

const bodies = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === 'http://127.0.0.1:11434/api/chat') {
    bodies.push(JSON.parse(init.body));
    const enc = new TextEncoder();
    return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n')); c.close(); } }), { status: 200 });
  }
  if (u === 'http://127.0.0.1:11434/api/generate') return new Response('{"error":"stub"}', { status: 503 });
  throw new Error(`unexpected network call in test: ${u}`);
};
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const { projectKeyOf } = await import(join(backendDir, 'src/memory/project-keys.ts')); // project memory key (id while GIRRU_STORE_P3 is on)
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const { getOrchestrator } = await import(join(backendDir, 'src/multi-agent/index.ts'));
await getOrchestrator().initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));
const OWNER = 'cc-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(OWNER, `${OWNER}@example.test`, OWNER);
const HIRED = 'Your specialty is release engineering. Always test before you say done.';
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary, system_prompt, department) VALUES ('cc-agent', 'Rafid', 'ollama', 'qwen-test', 1, ?, 'engineering')`).run(HIRED);
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('cc-other', 'Nora', 'ollama', 'qwen-test', 0)`).run();

const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { createProject, createConversation } = await import(join(backendDir, 'src/repositories/chat-conversations.ts'));
const { addStarterRules, createRule, rulesByPrecedence } = await import(join(backendDir, 'src/services/agent-rules.ts'));
const { centralSkills } = await import(join(backendDir, 'src/skills/central-store.ts'));
const { addPinnedFact, parsePinnedScope } = await import(join(backendDir, 'src/memory/scopes/pinned.ts'));
const { taskRunBasePrompt } = await import(join(backendDir, 'src/services/task-run-executor.ts'));
const { resolveAgentContext } = await import(join(backendDir, 'src/services/agent-context/resolve.ts'));
const { renderCodingAppInstructions, renderMemoryData } = await import(join(backendDir, 'src/services/agent-context/render.ts'));
const { guideReadTool } = await import(join(backendDir, 'src/tools/skills/guide-read.ts'));
const { createAgentToolsRegistry } = await import(join(backendDir, 'src/tools/index.ts'));
const { beginChannelTurn, CHANNEL_TURN_HEADER } = await import(join(backendDir, 'src/tools/channel-policy.ts'));

const app = await buildServer({ logger: false });
await app.ready();
const auth = { authorization: `Bearer ${generateToken(OWNER, 1)}` };

const project = await createProject(OWNER, { name: 'Alpha' });
const conv = await createConversation(OWNER, { title: 'Release', agentId: 'cc-agent', projectId: project.id });
await addStarterRules(OWNER);
await createRule({ text: 'In Alpha, release only on Tuesdays.', when: null, projectId: project.id, who: 'all', targets: [], paused: false }, OWNER);
await createRule({ text: 'Engineering writes tests first.', when: null, projectId: null, who: 'departments', targets: ['engineering'], paused: false }, OWNER);
await addPinnedFact(OWNER, parsePinnedScope(`project:${projectKeyOf(project)}`), 'Alpha is for Al-Zawraa Trading.', OWNER);
const STEP = 'Keep each release step reversible and write the decision down with its reason.';
const skill = await centralSkills().installMarkdown(`---\nname: release-check\ndescription: How we check a release before it ships.\n---\n\n# Release check\n\n${STEP}\n`, 'release-check', 'contract-test');
const skillId = skill.id ?? skill.skill?.id;
const { revision } = await centralSkills().assignments('cc-agent');
await centralSkills().assign('cc-agent', [skillId], revision);

const QUESTION = 'Can we release Alpha today?';
async function chatPrompt(channel = false) {
  bodies.length = 0;
  let headers = auth;
  let turn;
  if (channel) {
    turn = beginChannelTurn({ channel: 'telegram', conversationId: 'cc-tg', allowedDestinations: [] }, OWNER);
    headers = { origin: 'http://localhost:41521', [CHANNEL_TURN_HEADER]: turn.token };
  }
  try {
    const res = await app.inject({ method: 'POST', url: '/api/chat', headers,
      payload: { stream: false, sessionId: conv.id, ...(channel ? {} : { agentId: 'cc-agent', memoryScope: { project: projectKeyOf(project) } }), messages: [{ role: 'user', content: QUESTION }] } });
    assert.ok(bodies.length, `no model call: ${res.statusCode} ${res.body.slice(0, 200)}`);
    const body = bodies[0];
    return { system: body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n'), tools: (body.tools ?? []).map((t) => t.function?.name ?? t.name) };
  } finally { turn?.end(); }
}
const withP2 = async (fn) => { process.env.GIRRU_STORE_P2 = '1'; try { return await fn(); } finally { delete process.env.GIRRU_STORE_P2; } };

test('switch off: every entry point is unchanged (known gaps pinned)', async () => {
  const chat = await chatPrompt();
  assert.ok(!chat.system.includes(HIRED), 'today chat drops the hired instructions');
  assert.ok(chat.system.includes(STEP), 'today the full skill text goes into chat');
  assert.ok(!chat.tools.includes('guide_read'));
  const task = await taskRunBasePrompt({ id: 'cc-agent', name: 'Rafid', system_prompt: HIRED }, { user_id: OWNER });
  assert.ok(task.includes(HIRED));
  assert.ok(!task.includes('release only on Tuesdays'), 'today task runs drop the owner rules');
});

test('switch on: chat, task run and coding app carry the name, hired instructions and owner rules, rules first', async () => {
  await withP2(async () => {
    const chat = (await chatPrompt()).system;
    const task = await taskRunBasePrompt({ id: 'cc-agent', name: 'Rafid', system_prompt: HIRED }, { user_id: OWNER });
    const coding = renderCodingAppInstructions(await resolveAgentContext({ agentId: 'cc-agent', entry: 'coding_app', ownerId: OWNER, sessionId: conv.id }));
    for (const [name, text] of [['chat', chat], ['task', task], ['coding app', coding]]) {
      assert.ok(text.includes('Rafid'), `${name}: name`);
      assert.ok(text.includes(HIRED), `${name}: hired instructions`);
      assert.ok(text.indexOf('## Owner rules') >= 0 && text.indexOf('## Owner rules') < text.indexOf(HIRED), `${name}: rules before the definition`);
      assert.ok(text.includes('### Safety rules (always on)'), `${name}: safety group first`);
      assert.ok(text.includes('Engineering writes tests first.'), `${name}: department rule`);
    }
    // The chat and coding app know the project of the conversation; its rule is in the project group.
    for (const text of [chat, coding]) {
      assert.ok(text.indexOf('### Rules for this project') < text.indexOf('### Rules for your department'), 'project rules before department rules');
      assert.ok(text.includes('release only on Tuesdays'));
    }
    assert.match(chat, /Alpha is for Al-Zawraa Trading/, 'chat keeps its pinned facts (context pack)');
    assert.match(renderMemoryData(await resolveAgentContext({ agentId: 'cc-agent', entry: 'coding_app', ownerId: OWNER, sessionId: conv.id })), /Al-Zawraa/, 'coding app gets pinned facts as data');
  });
});

test('switch on: guides by name and one line; the full text only through guide_read, and only the agent’s own', async () => {
  await withP2(async () => {
    const chat = await chatPrompt();
    assert.match(chat.system, /- Skill: release-check — How we check a release before it ships\./);
    assert.ok(!chat.system.includes(STEP), 'the full skill text is not in the prompt');
    assert.ok(chat.tools.includes('guide_read'), 'chat offers guide_read');
    const reg = await createAgentToolsRegistry({ userId: 'cc-agent', accessOwnerId: OWNER, sessionId: 'cron-cc', workspaceDir: dir, agentId: 'cc-agent', taskId: 'cc-task' });
    assert.ok(reg.getToolsForAPI().some((t) => (t.function?.name ?? t.name) === 'guide_read'), 'task runs offer guide_read');
    const r = await guideReadTool.execute({ name: 'Release-Check' }, { agentId: 'cc-agent' });
    assert.ok(!r.error && r.content[0].text.includes(STEP));
    const other = await guideReadTool.execute({ name: 'release-check' }, { agentId: 'cc-other' });
    assert.ok(other.error, 'another agent cannot read a guide that is not its own');
  });
  assert.ok(!(await chatPrompt()).tools.includes('guide_read'), 'off again: not offered');
});

test('switch on: a channel turn gets the definition and rules but no owner memory', async () => {
  await withP2(async () => {
    const ch = (await chatPrompt(true)).system;
    assert.ok(ch.includes(HIRED));
    assert.ok(ch.includes('### Safety rules (always on)'));
    assert.doesNotMatch(ch, /Al-Zawraa/);
  });
});

test('rules by precedence: groups in order, numbered across groups', async () => {
  const text = await rulesByPrecedence('cc-agent', project.id);
  const order = ['### Safety rules (always on)', '### Rules for this project', '### Rules for your department', '### Rules for all agents'].map((h) => text.indexOf(h));
  assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), order.join(','));
  assert.match(text, /the rule in the group listed first wins/);
  assert.equal(await rulesByPrecedence('nobody', null), '');
});

test('MD4 and MD9: save criteria lead memory_save and the brief; recalled memories carry their date and place', async () => {
  const { memorySaveTool } = await import(join(backendDir, 'src/tools/memory/save.ts'));
  const { SAVE_CRITERIA } = await import(join(backendDir, 'src/services/agent-context/switch.ts'));
  const { standingRules } = await import(join(backendDir, 'src/memory/bridge/brief.ts'));
  const { messageRecall } = await import(join(backendDir, 'src/memory/context/pack.ts'));
  const { newMemory, saveVersioned } = await import(join(backendDir, 'src/memory/learning.ts'));
  assert.ok(!memorySaveTool.description.startsWith(SAVE_CRITERIA), 'off: unchanged');
  assert.ok(!standingRules().includes(SAVE_CRITERIA));
  await saveVersioned(newMemory(OWNER, { kind: 'project', key: projectKeyOf(project) }, { type: 'fact', importance: 6, content: 'Alpha staging is restored every Sunday night.' }, {}), 'test', 'test');
  const drawers = [{ kind: 'project', key: projectKeyOf(project) }];
  const pack = { key: 'contract', text: '', memoryChars: 0, items: [], hit: false, memoryIds: [] };
  const off = await messageRecall({ userId: OWNER, drawers, query: 'When is alpha staging restored?', pack });
  // P9b (MD3): the line also carries its confidence.
  assert.match(off.text, process.env.GIRRU_STORE_P9B === '1' ? /restored every Sunday night\. \(confidence \w+\)\n/ : /restored every Sunday night\.\n/);
  await withP2(async () => {
    assert.ok(memorySaveTool.description.startsWith(SAVE_CRITERIA));
    assert.equal(standingRules()[0], SAVE_CRITERIA);
    const on = await messageRecall({ userId: OWNER, drawers, query: 'When is the alpha staging data restored on Sunday?', pack });
    assert.match(on.text, new RegExp(`restored every Sunday night\\. \\(as of \\d{4}-\\d{2}-\\d{2} · project:${projectKeyOf(project)}${process.env.GIRRU_STORE_P9B === '1' ? ' · confidence \\w+' : ''}\\)`));
  });
});

test('routes for the app: the switch, and the eye list strongest group first with groups', async () => {
  const get = (url) => app.inject({ method: 'GET', url, headers: auth });
  assert.deepEqual((await get('/api/store-switches')).json(), { p2: false, p3: process.env.GIRRU_STORE_P3 === '1', p4: process.env.GIRRU_STORE_P4 === '1', ...(/^(1|true|yes|on)$/i.test(process.env.GIRRU_STORE_P6 ?? '') ? { p6: true } : {}) });
  assert.equal((await get('/api/agent-rules')).json().precedence, false);
  const before = (await get(`/api/agent-rules/effective?agentId=cc-agent&projectId=${project.id}`)).json();
  assert.ok(!('precedence' in before) && before.rules.every((r) => !('group' in r)), 'off: unchanged');
  await withP2(async () => {
    assert.deepEqual((await get('/api/store-switches')).json(), { p2: true, p3: process.env.GIRRU_STORE_P3 === '1', p4: process.env.GIRRU_STORE_P4 === '1' });
    assert.equal((await get('/api/agent-rules')).json().precedence, true);
    const eye = (await get(`/api/agent-rules/effective?agentId=cc-agent&projectId=${project.id}`)).json();
    assert.equal(eye.precedence, true);
    const order = ['safety', 'project', 'agents', 'departments', 'all'];
    const groups = eye.rules.map((r) => r.group);
    assert.ok(groups.every((g, i) => i === 0 || order.indexOf(g) >= order.indexOf(groups[i - 1])), groups.join(','));
    assert.ok(groups.includes('safety') && groups.includes('project') && groups.includes('departments'));
  });
  const other = await app.inject({ method: 'GET', url: '/api/store-switches' });
  assert.equal(other.statusCode, 401, 'owner only');
});
