// End to end: two coding tools on one Girru memory, through everything that really runs.
//
// `test/memory-bridge.test.mjs` already drives the MCP server, but in this process and with a stubbed
// fetch. This starts the backend on a real loopback port and runs `mcp-stdio.ts` as its own OS process
// per tool, exactly as Claude Code and Codex start it — the session handshake (install proof, token),
// the HTTP calls and the MCP protocol over stdin/stdout are all the real ones. Two processes on one
// SQLite file is also what the change log (MEM-CONC-03) is for, so a handoff written by one tool has
// to be readable by the other straight away.
//
// Run from packages/backend:
//   node --import tsx scripts/memory-baseline/bridge-e2e.mjs
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const backendDir = process.cwd();
const mod = (rel) => pathToFileURL(join(backendDir, rel)).href;
if (!backendDir.endsWith(join('packages', 'backend'))) throw new Error('Run from packages/backend');

const dir = mkdtempSync(join(tmpdir(), 'girru-e2e-'));
const folder = join(dir, 'project');
mkdirSync(join(dir, '.data'), { recursive: true });
mkdirSync(folder, { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:9'; // no model is reached
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
for (const k of ['CODEX_HOME', 'AGENT_EXEC_TOOLS', 'DEFAULT_MODEL']) delete process.env[k];

const log = console.log;
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
/** What the tool answered, for a failing check (an error text says why far better than a length). */
const said = (r) => `${r.ms} ms · ${JSON.stringify(r.text.replace(/\s+/g, ' ').slice(0, 160))}`;

const { getDatabase } = await import(mod('src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(mod('src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const { getOrchestrator } = await import(mod('src/multi-agent/index.ts'));
await getOrchestrator().initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));

const OWNER = 'e2e-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(OWNER, 'e2e@example.test', OWNER);
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('e2e-main', 'Main', 'ollama', 'qwen-test', 1)`).run();

const { buildServer } = await import(mod('src/api/app.ts'));
const { createProject } = await import(mod('src/repositories/chat-conversations.ts'));
const { learn } = await import(mod('src/memory/learning.ts'));
const { publishInstanceIdentity } = await import(mod('src/services/instance-identity.ts'));
const { setBridgeEnv, setClient } = await import(mod('src/memory/bridge/service.ts'));
const { launchCapability } = await import(mod('src/memory/bridge/capability.ts'));
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

setBridgeEnv({ home: dir, env: {} });
publishInstanceIdentity();

const project = await createProject(OWNER, { name: 'Falcon', folder });
// One approved memory the coding tools must be able to find.
await learn({
  userId: OWNER, content: 'Falcon: the server database is ClickHouse; we moved off MariaDB because the monthly reports needed window functions.',
  type: 'fact', drawer: { kind: 'project', key: project.id }, importance: 7, actor: 'owner', reason: 'e2e setup',
}).catch(async () => {
  // `learn` shapes differ with the switches; fall back to the storage path.
  const { getMemoryStorage } = await import(mod('src/memory/storage.ts'));
  await getMemoryStorage().save({
    id: 'e2e-fact', userId: OWNER, type: 'fact', content: 'Falcon: the server database is ClickHouse; we moved off MariaDB because the monthly reports needed window functions.',
    drawer: { kind: 'project', key: project.id }, memoryLayer: 'factual', importanceScore: 0.7, status: 'active',
    metadata: {}, createdAt: new Date(), accessCount: 0, expiryTimestamp: null,
  });
});

// The owner switches each coding tool on (off by default, as in the app).
for (const cl of ['claude-code', 'codex']) await setClient(OWNER, cl, true);

const app = await buildServer({ logger: false });
await app.ready();
await app.listen({ port: 0, host: '127.0.0.1' });
const port = app.server.address().port;
const url = `http://127.0.0.1:${port}`;
process.env.AGENT_PLAYER_URL = url;
log(`backend        ${url}  ·  project folder ${folder}`);

/** One coding tool: its own process running mcp-stdio.ts, spoken to over stdio as the real CLI does. */
async function tool(client) {
  // STORE-MAP-01 P6: a coding tool reaches a project only with the session capability Girru's launcher
  // gives it, in GIRRU_SESSION_CAPABILITY. Without it every call answers "needs a session from Girru",
  // which is what a tool started by hand outside Girru gets.
  const { token: capability } = await launchCapability(OWNER, project.id, client, true);
  const transport = new StdioClientTransport({
    command: process.execPath,
    // The server runs in the project folder (that is how it knows which project), so `tsx` has to be
    // named by its absolute path: from that folder Node cannot resolve it as a package.
    args: ['--import', import.meta.resolve('tsx'), join(backendDir, 'src/memory/bridge/mcp-stdio.ts'), '--client', client],
    cwd: folder,
    env: { ...process.env, AGENT_PLAYER_URL: url, GIRRU_SESSION_CAPABILITY: capability },
    stderr: 'pipe',
  });
  const c = new Client({ name: `e2e-${client}`, version: '1' });
  // The server's own diagnostics go to stderr; without them a crash is just "connection closed".
  const errs = [];
  await c.connect(transport);
  transport.stderr?.on('data', (d) => {
    const t = String(d).trim();
    if (!t) return;
    errs.push(t);
    log(`  [${client} stderr] ${t.replace(/\s+/g, ' ').slice(0, 400)}`);
  });
  return {
    client,
    list: async () => (await c.listTools()).tools.map((t) => t.name),
    call: async (name, args = {}) => {
      const t = Date.now();
      const r = await c.callTool({ name, arguments: args });
      return { text: r.content?.[0]?.text ?? '', isError: !!r.isError, ms: Date.now() - t };
    },
    close: () => c.close().catch(() => {}),
  };
}

let claude = null, codex = null;
try {
  claude = await tool('claude-code');
  const tools = await claude.list();
  check('Claude Code connects to the dpro-memory server in its own process', tools.length > 0, `${tools.length} tools: ${tools.join(', ')}`);
  // The one memory contract (P6) renames the write tools to verbs; take whichever this build serves.
  const RECALL = tools.includes('memory_recall') ? 'memory_recall' : 'memory_search';
  const HANDOFF = tools.includes('memory_handoff') ? 'memory_handoff' : 'handoff_write';
  const SAVE = tools.includes('memory_save') ? 'memory_save' : null;

  const brief = await claude.call('project_brief');
  check('project_brief answers for the folder', !brief.isError && brief.text.length > 60, said(brief));

  const found = await claude.call(RECALL, { query: 'which database does the server use' });
  check('memory_search finds the approved memory', !found.isError && /ClickHouse/i.test(found.text), said(found));

  const note = `Done the export fix; left the retry limit; next the invoice totals (${randomBytes(3).toString('hex')}).`;
  const wrote = await claude.call(HANDOFF, { done: ['the export fix'], left: ['the retry limit'], next: ['the invoice totals'], questions: [] });
  check('handoff_write accepts a note from Claude Code', !wrote.isError, said(wrote));

  // The other tool, a second OS process on the same SQLite file.
  codex = await tool('codex');
  const read = await codex.call('latest_handoff');
  check('Codex reads that handoff at once, in another process', !read.isError && /export fix/i.test(read.text), said(read));

  const codexFound = await codex.call(RECALL, { query: 'why did we move off MariaDB' });
  check('Codex finds the same memory', !codexFound.isError && /window functions/i.test(codexFound.text), said(codexFound));

  const proposed = await codex.call('memory_propose', { content: 'Falcon: the retry limit is 5 attempts.' });
  check('memory_propose only proposes (the owner approves)', !proposed.isError && /review|propos|approve/i.test(proposed.text), proposed.text.slice(0, 80));

  const pending = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND status = 'active' AND content LIKE '%retry limit is 5%'`).get(OWNER);
  check('the proposal is NOT live memory yet', pending.n === 0, `${pending.n} active rows`);

  // memory_save is the contract's write verb; through a coding app it still needs the owner's review.
  if (SAVE) {
    const saved = await claude.call(SAVE, { content: 'Falcon: the nightly export runs at 02:00.' });
    const live = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND status = 'active' AND content LIKE '%nightly export runs%'`).get(OWNER);
    check(`${SAVE} from a coding tool does not write live memory`, !saved.isError && live.n === 0, `${said(saved)} · ${live.n} active rows`);
  }

  // The handoff a tool leaves is in the owner's own memory too, not only in the tool's answer.
  const notes = db.prepare(`SELECT COUNT(*) AS n FROM memory_bridge_handoffs WHERE owner_id = ?`).get(OWNER);
  check('the handoff is stored in Girru', (notes?.n ?? 0) > 0, `${notes?.n ?? 0} handoff rows`);
} catch (err) {
  check('the run finished', false, String(err?.message ?? err).slice(0, 300));
  if (err?.stack) log(err.stack.split('\n').slice(0, 6).join('\n'));
} finally {
  await claude?.close(); await codex?.close();
  await app.close().catch(() => {});
  process.chdir(backendDir);
  try { rmSync(dir, { recursive: true, force: true }); } catch { log(`left behind    ${dir}`); }
}

const failed = results.filter((r) => !r.ok);
log(`\n${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
