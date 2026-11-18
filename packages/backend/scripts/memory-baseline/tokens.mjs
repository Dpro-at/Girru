// STORE-MAP-01 P0 baseline: prompt size per entry point (A4, SUB5, CX11).
// One synthetic company (a hired primary agent with starter rules, three
// skills, 3,000 memories, pinned facts, a short chat history) and the prompt
// each entry point sends for the same user question:
//   chat          the real /api/chat route; the local model is a stub that
//                 records the exact request (system prompt, history, tools)
//   channel       the same route as a channel turn (as plugins/sdk.ts sends it)
//   task run      task-run-executor.ts:369-400 rebuilt with its own functions
//   coding app    chat.ts subscription branch: agent context + memory pack +
//                 history + the Girru tool protocol (subscriptionToolLoop)
//   MCP           dpro-memory tool list + instructions, project_brief and an
//                 8-result memory_search answer
// Tokens: counted with the Qwen3 tokenizer of the local Ollama
// (qwen3-embedding:0.6b, prompt_eval_count; no generation, no paid call).
// Claude / OpenAI tokenizers are not available offline: chars/3 (the app's
// estimateTokens) and chars/4 are reported as ESTIMATES.
// Run from packages/backend: node --import tsx scripts/memory-baseline/tokens.mjs [--out f.json]
import { backendDir, moduleUrl, dataRoot, addUser, argValue, cleanup, ollamaHas, openDb, quietly, realFetch, OLLAMA } from './env.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syntheticMemories } from './corpus.mjs';

const out = argValue('out', null);
const TOKENIZER = 'qwen3-embedding:0.6b';
if (!(await ollamaHas(TOKENIZER))) { console.error(`${TOKENIZER} is not on the local Ollama; no tokenizer`); process.exit(2); }
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.OLLAMA_URL = OLLAMA;
process.env.NODE_ENV = 'test';
process.env.AGENT_PLAYER_CONFIG_DIR = join(dataRoot, 'cli-config');
for (const k of ['AGENT_EXEC_TOOLS', 'OLLAMA_THINK', 'DEFAULT_MODEL', 'OUTSIDER_AGENT_MEMORY']) delete process.env[k];
mkdirSync(join(dataRoot, '.data', 'multi-agent'), { recursive: true });

// The stub local model: records each /api/chat request, answers "ok".
const captured = [];
const guarded = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === `${OLLAMA}/api/chat`) {
    captured.push(JSON.parse(init.body));
    const enc = new TextEncoder();
    return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n')); c.close(); } }), { status: 200 });
  }
  if (u === `${OLLAMA}/api/generate`) return new Response('{"error":"stub"}', { status: 503 }); // background summaries: never the real model
  return guarded(url, init);
};

// --- Tokenizer -------------------------------------------------------------
async function qwenCount(text) {
  const res = await realFetch(`${OLLAMA}/api/embed`, { method: 'POST', body: JSON.stringify({ model: TOKENIZER, input: text, truncate: false }) });
  if (!res.ok) throw new Error(`tokenizer: ${res.status} ${await res.text()}`);
  return (await res.json()).prompt_eval_count;
}
const OVERHEAD = (await qwenCount('a')) - 1; // special tokens added per call
async function tokens(text) {
  if (!text) return 0;
  let total = 0;
  for (let i = 0; i < text.length; i += 24000) total += (await qwenCount(text.slice(i, i + 24000))) - OVERHEAD;
  return total;
}
async function measure(parts) {
  const row = {};
  let chars = 0, qwen = 0;
  for (const [name, text] of Object.entries(parts)) {
    const t = await tokens(text);
    row[name] = { chars: text.length, qwenTokens: t };
    chars += text.length; qwen += t;
  }
  row.total = { chars, qwenTokens: qwen, estimateChars3: Math.ceil(chars / 3), estimateChars4: Math.ceil(chars / 4) };
  return row;
}

// --- Synthetic company -----------------------------------------------------
const { resolveAgentContext } = await import(moduleUrl(backendDir, 'src/services/agent-context/resolve.ts'));
const { db, closeDatabase } = await openDb();
const { getCredentialStorage } = await import(moduleUrl(backendDir, 'src/credentials/storage.ts'));
await quietly(() => getCredentialStorage().initialize());
const { getOrchestrator } = await import(moduleUrl(backendDir, 'src/multi-agent/index.ts'));
await quietly(() => getOrchestrator().initialize(join(dataRoot, '.data', 'multi-agent', 'orchestrator.db')));
const OWNER = 'p0-owner';
addUser(db, OWNER, 'owner');
db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(OWNER);
const AGENT = 'p0-main';
const HIRED = `Your specialty is backend engineering for small business software. You plan, build and review server code, databases and integrations.
Work in small steps, explain trade-offs briefly, test before you say something is done, and ask the owner once when a decision is theirs.
Write code and comments in English; reply to the owner in simple Arabic unless asked otherwise. Never put keys, passwords or tokens in replies or memory.`;
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary, system_prompt) VALUES (?, 'Rafid', 'ollama', 'qwen3:4b', 1, ?)`).run(AGENT, HIRED);

const { addStarterRules } = await import(moduleUrl(backendDir, 'src/services/agent-rules.ts'));
const rules = await quietly(() => addStarterRules(OWNER));

const { centralSkills } = await import(moduleUrl(backendDir, 'src/skills/central-store.ts'));
const skillDoc = (name, topic) => `---\nname: ${name}\ndescription: How we handle ${topic} in client projects.\n---\n\n# ${name}\n\n` +
  Array.from({ length: 14 }, (_, i) => `## Step ${i + 1}\nWhen working on ${topic}, check the project notes first, follow the house style, keep changes small and reversible, write a short test, and record the decision with its reason. Prefer boring, well-known tools. Ask the owner before anything that costs money or touches production data.\n`).join('\n');
const skillIds = [];
for (const [n, t] of [['db-migrations', 'database migrations'], ['api-review', 'API reviews'], ['release-notes', 'release notes']]) {
  const s = await quietly(() => centralSkills().installMarkdown(skillDoc(n, t), n, 'p0-baseline'));
  skillIds.push(s.id ?? s.skill?.id);
}
const { revision } = await centralSkills().assignments(AGENT);
await quietly(() => centralSkills().assign(AGENT, skillIds.filter(Boolean), revision));

const insert = db.prepare(`INSERT INTO memories (id, user_id, type, content, embedding, embedding_model, embedding_dims,
  memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, drawer_key)
  VALUES (?, ?, ?, ?, ?, 'hash-v2', 256, 'factual', 'active', '{}', ?, ?, 0, ?, ?)`);
const { hashEmbed } = await import(moduleUrl(backendDir, 'src/memory/embedding.ts'));
const { normalizeMemoryText } = await import(moduleUrl(backendDir, 'src/memory/text-normalize.ts'));
let n = 0;
db.transaction(() => {
  for (const m of syntheticMemories(3000, 5)) {
    const imp = n % 25 === 0 ? 0.95 : 0.5; // a few pinned-level memories, as owners mark them
    insert.run(`m-${n++}`, OWNER, m.type, m.content, JSON.stringify(hashEmbed(normalizeMemoryText(m.content))), imp, m.createdAt, m.drawerKind, m.drawerKey);
  }
});
const { addPinnedFact, parsePinnedScope } = await import(moduleUrl(backendDir, 'src/memory/scopes/pinned.ts'));
for (const [scope, text] of [
  ['company', 'We are a small software company in Vienna; clients are small businesses in Austria and Iraq.'],
  ['company', 'Never send client data to a cloud service without the owner saying yes.'],
  ['company', 'Invoices go out in German and Arabic.'],
  ['project:alpha', 'Alpha is the desktop invoicing app for Al-Zawraa Trading.'],
  ['project:alpha', 'Alpha targets Windows 11 and macOS 15.'],
]) await quietly(() => addPinnedFact(OWNER, parsePinnedScope(scope), text, OWNER));

const { createProject } = await import(moduleUrl(backendDir, 'src/repositories/chat-conversations.ts'));
const alphaProjectId = (await createProject(OWNER, { name: 'alpha' })).id;
const { generateToken } = await import(moduleUrl(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(moduleUrl(backendDir, 'src/api/app.ts'));
const app = await quietly(() => buildServer({ logger: false }));
await quietly(() => app.ready());
const auth = { authorization: `Bearer ${generateToken(OWNER, 1)}` };

const QUESTION = 'Where is the alpha staging database hosted, and when is it restored? Answer briefly.';
const HISTORY = [
  { role: 'user', content: 'Good morning. What is left on the alpha release?' },
  { role: 'assistant', content: 'Three items: the invoice export bug, the Windows installer signing, and the German translation review. The export bug is the biggest.' },
  { role: 'user', content: 'شلون ماشي موضوع التوقيع؟' },
  { role: 'assistant', content: 'التوقيع جاهز تقريباً، باقي نجرّب ملف التنصيب على ويندوز ونتأكد من الشهادة.' },
];
const turnMessages = [...HISTORY, { role: 'user', content: QUESTION }];
const splitBody = (body) => {
  const msgs = body.messages || [];
  const system = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const convo = msgs.filter((m) => m.role !== 'system').map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n\n');
  return { system, conversation: convo, toolSchemas: body.tools ? JSON.stringify(body.tools) : '' };
};
const report = { tokenizer: `ollama ${TOKENIZER} (Qwen3 BPE), overhead ${OVERHEAD} per call subtracted`, rules: rules.length, skills: skillIds.length, memories: n, entryPoints: {} };

// 1. Chat (owner, project alpha open).
captured.length = 0;
const chatRes = await quietly(() => app.inject({ method: 'POST', url: '/api/chat', headers: auth,
  payload: { stream: false, agentId: AGENT, sessionId: 'p0-session-chat', messages: turnMessages, memoryScope: { project: 'alpha' } } }));
if (!captured.length) throw new Error(`chat made no model call: ${chatRes.statusCode} ${chatRes.body.slice(0, 300)}`);
const chatBody = captured[0];
const has = (body, text) => JSON.stringify(body.messages || []).includes(text);
const { rulesContext } = await import(moduleUrl(backendDir, 'src/services/agent-rules.ts'));
const ruleLine = (await quietly(() => rulesContext(AGENT, {}))).split('\n').find((l) => /^\s*[-*\d]/.test(l) && l.trim().length > 20) ?? '\u0000';
const MARK = { hired: 'Your specialty is backend engineering', rules: ruleLine.trim().slice(0, 40), pinned: 'small software company in Vienna' };
report.ruleMarker = MARK.rules;
const present = (body) => Object.fromEntries(Object.entries(MARK).map(([k, v]) => [k, has(body, v)]));
report.entryPoints.chat = { status: chatRes.statusCode, modelCalls: captured.length, tools: chatBody.tools?.length ?? 0, includes: present(chatBody), ...(await measure(splitBody(chatBody))) };
// P9b: what per-message recall put next to the question (line count, and whether it said "nothing reliable").
{
  const convo = splitBody(chatBody).conversation;
  const block = convo.match(/\[Memory recalled for this message[\s\S]*?\[End of recalled memory\]/)?.[0] ?? '';
  report.entryPoints.chat.recall = { lines: block.split('\n').filter((l) => l.startsWith('- ')).length, chars: block.length, noReliable: convo.includes('nothing reliable is stored'),
    sample: block.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(0, 90)) };
}

// 2. Channel turn (outside sender, as plugins/sdk.ts sends it).
const { beginChannelTurn, CHANNEL_TURN_HEADER } = await import(moduleUrl(backendDir, 'src/tools/channel-policy.ts'));
captured.length = 0;
const turn = beginChannelTurn({ channel: 'telegram', conversationId: 'p0-tg-1', allowedDestinations: [] }, OWNER);
const chRes = await quietly(() => app.inject({ method: 'POST', url: '/api/chat',
  headers: { origin: 'http://localhost:41521', [CHANNEL_TURN_HEADER]: turn.token },
  payload: { sessionId: 'p0-session-channel', stream: false, messages: turnMessages,
    systemPromptAppend: 'Reply in plain text suitable for a messaging channel. Do not output UI specifications.',
    chatContext: { sessionType: 'minimal', hasAvatarViewer: false, hasDesktopControl: false } } }));
turn.end();
report.entryPoints.channel = captured.length
  ? { status: chRes.statusCode, modelCalls: captured.length, tools: captured[0].tools?.length ?? 0, includes: present(captured[0]), ...(await measure(splitBody(captured[0]))) }
  : { status: chRes.statusCode, error: chRes.body.slice(0, 300) };

// 3. Task run, rebuilt from task-run-executor.ts:369-400 with the same functions.
const { agentSkillsPrompt } = await import(moduleUrl(backendDir, 'src/skills/central-store.ts'));
const { HANDOFF_NOTE } = await import(moduleUrl(backendDir, 'src/memory/handoff/store.ts'));
const { createAgentToolsRegistry } = await import(moduleUrl(backendDir, 'src/tools/index.ts'));
const { taskRunPinnedFacts } = await import(moduleUrl(backendDir, 'src/memory/scopes/task-facts.ts'));
const { toolMemoryDrawers } = await import(moduleUrl(backendDir, 'src/tools/memory/scope.ts'));
const taskRegistry = await quietly(() => createAgentToolsRegistry({ userId: AGENT, accessOwnerId: OWNER, sessionId: 'cron-p0-task', workspaceDir: dataRoot, agentId: AGENT, taskId: 'p0-task' }));
// The executor's own base prompt (today's builder, or the resolved context with GIRRU_STORE_P2 on).
const { taskRunBasePrompt } = await import(moduleUrl(backendDir, 'src/services/task-run-executor.ts'));
let taskSystem = (await quietly(() => taskRunBasePrompt({ id: AGENT, name: 'Rafid', system_prompt: HIRED }, { user_id: OWNER }))) + `\n\n${HANDOFF_NOTE}`;
const facts = await quietly(() => taskRunPinnedFacts({ ownerId: OWNER, agentId: AGENT, taskId: 'p0-task', delegatedFrom: [], drawers: toolMemoryDrawers(taskRegistry.getContext()), drawersNarrowed: false })).catch(() => '');
if (facts) taskSystem += `\n\n${facts}`;
report.entryPoints.taskRun = { reconstructed: 'task-run-executor.ts:369-400', tools: taskRegistry.getToolsForAPI().length,
  includes: { hired: true, rules: taskSystem.includes(MARK.rules), pinned: taskSystem.includes(MARK.pinned) },
  ...(await measure({ system: taskSystem, conversation: `user: Task: ${QUESTION}`, toolSchemas: JSON.stringify(taskRegistry.getToolsForAPI()) })) };

// 3a. STORE-MAP-01 P2b: the same task run on the local model as the executor builds it with P2b on
// (tools on demand, the model's window from the local Ollama capped by CHAT_NUM_CTX, the memory rule).
const { storeP2bEnabled } = await import(moduleUrl(backendDir, 'src/services/store-p2b.ts'));
if (storeP2bEnabled()) {
  const { localModelWindow, NO_INVENTED_MEMORY } = await import(moduleUrl(backendDir, 'src/services/local-turn.ts'));
  const { planLocalBudget } = await import(moduleUrl(backendDir, 'src/memory/context/local-budget.ts'));
  const { OnDemandTools } = await import(moduleUrl(backendDir, 'src/tools/on-demand.ts'));
  const { capTokens: cap } = await import(moduleUrl(backendDir, 'src/services/agent-context/budget.ts'));
  const w = await localModelWindow('ollama', 'qwen3:4b');
  const b = planLocalBudget(w.tokens);
  const od = new OnDemandTools(taskRegistry.getToolsForAPI(), b.tier, { fitTokens: b.tools });
  const sys = cap([taskSystem, od.index(), NO_INVENTED_MEMORY].join('\n\n---\n\n'), b.system);
  report.window = { tokens: w.tokens, source: w.source, tier: b.tier, replyTokens: b.replyTokens, promptTokens: b.promptTokens };
  report.entryPoints.taskRunLocalP2b = { tools: od.definitions().length, includes: { rules: sys.includes(MARK.rules), pinned: sys.includes(MARK.pinned) },
    ...(await measure({ system: sys, conversation: `user: Task: ${QUESTION}`, toolSchemas: JSON.stringify(od.definitions()) })) };
}

// 3b. Task run of the storage pilot agent (resolved context, CX6): same tools, the one resolved
// context instead of the old builder, plus the executor's handoff note and narrowed pinned facts.
const { renderSystemPrompt } = await import(moduleUrl(backendDir, 'src/services/agent-context/render.ts'));
let pilotTask = renderSystemPrompt(await quietly(() => resolveAgentContext({ agentId: AGENT, entry: 'task', ownerId: OWNER, projectId: null }))) + `\n\n${HANDOFF_NOTE}`;
if (facts) pilotTask += `\n\n${facts}`;
report.entryPoints.taskRunPilot = { resolved: 'services/agent-context (STORE-MAP-01 pilot)', tools: taskRegistry.getToolsForAPI().length,
  includes: { hired: pilotTask.includes(MARK.hired), rules: pilotTask.includes(MARK.rules), pinned: pilotTask.includes(MARK.pinned) },
  ...(await measure({ system: pilotTask, conversation: `user: Task: ${QUESTION}`, toolSchemas: JSON.stringify(taskRegistry.getToolsForAPI()) })) };

// 4. Coding app (subscription) reply, as the chat.ts subscription branch builds it.
const { subscriptionAgentContext, subscriptionReplyPrompt } = await import(moduleUrl(backendDir, 'src/services/subscription-agent-context.ts'));
const { subscriptionToolLoop } = await import(moduleUrl(backendDir, 'src/services/subscription-tool-loop.ts'));
const { contextPack } = await import(moduleUrl(backendDir, 'src/memory/context/pack.ts'));
const D = await import(moduleUrl(backendDir, 'src/memory/drawers.ts'));
const drawers = D.selectDrawers({ audience: 'owner', project: 'alpha' });
// As chat.ts builds it: GIRRU_STORE_P2 on = the resolved context, its data part and a token budget.
const { storeP2Enabled } = await import(moduleUrl(backendDir, 'src/services/agent-context/switch.ts'));
const { renderCodingAppInstructions, renderMemoryData } = await import(moduleUrl(backendDir, 'src/services/agent-context/render.ts'));
const { capTokens, CODING_APP_MEMORY_TOKENS } = await import(moduleUrl(backendDir, 'src/services/agent-context/budget.ts'));
const p2Ctx = storeP2Enabled() ? await quietly(() => resolveAgentContext({ agentId: AGENT, entry: 'coding_app', ownerId: OWNER, projectId: alphaProjectId })) : null;
const context = p2Ctx ? renderCodingAppInstructions(p2Ctx) : await quietly(() => subscriptionAgentContext(AGENT, { sessionId: 'p0-session-sub' }));
let pack = (await quietly(() => contextPack({ userId: OWNER, agentId: AGENT, drawers, persona: '', scopeFacts: null, handoff: null }))).text.trim();
if (p2Ctx) { const data = renderMemoryData(p2Ctx); if (data) pack = pack ? `${data}\n\n${pack}` : data; }
const SUBSCRIPTION_MEMORY_CHARS = 6000; // chat.ts:363
const memoryPart = p2Ctx ? capTokens(pack, CODING_APP_MEMORY_TOKENS) : pack.length > SUBSCRIPTION_MEMORY_CHARS ? pack.slice(0, SUBSCRIPTION_MEMORY_CHARS) : pack;
const history = turnMessages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
const replyPrompt = subscriptionReplyPrompt(context, `${memoryPart}\n\n${history}`);
const subRegistry = await quietly(() => createAgentToolsRegistry({ userId: OWNER, sessionId: 'p0-session-sub', agentId: AGENT, workspaceDir: dataRoot, fileReadRoot: dataRoot, memoryDrawers: drawers, chatPlan: true }));
let firstPrompt = '';
// STORE-MAP-01 P2b (XP1): as chat.ts does, tools on demand for the coding app too (index in the context).
const subAll = subRegistry.getAll().map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
const { OnDemandTools: SubOD } = await import(moduleUrl(backendDir, 'src/tools/on-demand.ts'));
const subOd = storeP2bEnabled() ? new SubOD(subAll, 'large') : null;
const subPrompt = subOd ? subscriptionReplyPrompt(`${context}\n\n${subOd.index()}`, `${memoryPart}\n\n${history}`) : replyPrompt;
await subscriptionToolLoop({ prompt: subPrompt, signal: AbortSignal.timeout(10_000),
  tools: subOd ? subOd.definitions() : subAll,
  reply: async (p) => { firstPrompt ||= p; return 'ok'; }, execute: async () => ({ content: [] }), onTool: () => {} });
report.entryPoints.codingApp = { tools: subRegistry.getAll().length,
  includes: { hired: firstPrompt.includes(MARK.hired), rules: firstPrompt.includes(MARK.rules), pinned: firstPrompt.includes(MARK.pinned) }, ...(await measure({
  agentContext: subOd ? `${context}\n\n${subOd.index()}` : context, memoryPack: memoryPart, conversation: history, toolProtocol: firstPrompt.slice(subPrompt.length) })),
  note: 'the app itself only records estimateTokens(replyPrompt) and no CLI usage (SUB5)' };

// 5. MCP (dpro-memory) for a coding tool working in the alpha folder.
const { BRIDGE_TOOL_DEFINITIONS } = await import(moduleUrl(backendDir, 'src/memory/bridge/mcp-server.ts'));
const { projectBrief, briefMarkdown, clean } = await import(moduleUrl(backendDir, 'src/memory/bridge/brief.ts'));
const { getMemoryStorage } = await import(moduleUrl(backendDir, 'src/memory/storage.ts'));
const brief = briefMarkdown(await quietly(() => projectBrief(OWNER, { id: 'p0-alpha', name: 'Alpha', slug: 'alpha' })));
const hits = await quietly(() => getMemoryStorage().search({ userId: OWNER, query: QUESTION, drawers: [{ kind: 'project', key: 'alpha' }], limit: 8 }));
report.entryPoints.mcp = await measure({
  toolList: JSON.stringify(BRIDGE_TOOL_DEFINITIONS),
  projectBrief: brief,
  memorySearch8: hits.map((h) => `- ${clean(h.memory.content)}`).join('\n'),
});

// Shared parts, measured alone (they repeat in several entry points).
report.components = await measure({
  skillsAndSpecialties: await agentSkillsPrompt(AGENT),
  ownerRules: await quietly(() => rulesContext(AGENT, {})),
  hiredInstructions: HIRED,
  memoryPackChat: (await quietly(() => contextPack({ userId: OWNER, agentId: AGENT, drawers, persona: '', scopeFacts: null, handoff: null }))).text,
});

console.log(JSON.stringify(report, null, 2));
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
await app.close();
closeDatabase();
cleanup();
process.exit(0);
