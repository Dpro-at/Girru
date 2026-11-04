/**
 * FIRSTRUN-01: the steps after the owner account (AI tools · Local model · Team),
 * then a Welcome chat in which the Main agent greets the owner.
 *
 * State lives in onboarding_state (migration 050) with `answers.firstRun = true`.
 * Only an owner created by the setup route gets that row, so owners who existed
 * before this feature never see the setup steps again.
 *
 * Nothing here runs an install or sign-in: those commands are fixed strings
 * the app runs in Girru's own terminal when the owner presses Install or Sign in.
 * Sign-in is checked by the presence of each tool's own files (and, for Claude Code
 * on macOS, its keychain item); no file content or value that holds a credential is
 * read or returned.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { all, lockName, one, run, sql, type Step } from '../repositories/sql-steps.js';
import { subscriptionSearchDirs } from '../services/subscription-chat.js';
import { storeP7Enabled } from '../services/store-p7.js';
import { listLocalModels } from '../llm/local-models.js';
import { firstRunDiscovery } from './discovery.js';
import { enableFirstRunAutomaticImport } from '../memory/import/automatic-project-import.js';
import { addAssistantMessage, createConversation } from '../repositories/chat-conversations.js';

export const FIRST_RUN_STEPS = ['discovery', 'tools', 'model', 'team'] as const;
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number];
export type WorkspaceType = 'individual' | 'company';
export type FirstRunState = Readonly<{ pending: boolean; step: FirstRunStep; workspaceType?: WorkspaceType; companyName?: string }>;

export const validCompanyName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && [...value].length <= 100 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);

type Row = { answers: string; completed: number };
const answersOf = (raw: string | undefined): Record<string, unknown> => {
  try { const v = JSON.parse(raw ?? '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
};
const stepOf = (v: unknown): FirstRunStep => (FIRST_RUN_STEPS as readonly unknown[]).includes(v) ? v as FirstRunStep : 'tools';

/** Inside the owner-creation transaction: the new owner goes through the setup steps once. */
export function* startFirstRunStep(userId: string, workspaceType?: WorkspaceType, companyName?: string): Step<void> {
  yield* run(`INSERT INTO onboarding_state (user_id, current_step, answers, completed, skipped, updated_at)
    VALUES (?, 1, ?, 0, 0, CURRENT_TIMESTAMP)`, userId, JSON.stringify({ firstRun: true, firstRunStep: 'discovery', ...(workspaceType ? { workspaceType, companyName: workspaceType === 'company' ? companyName : undefined } : {}) }));
}

export async function firstRunState(userId: string): Promise<FirstRunState> {
  const row = await sql().read(one<Row>('SELECT answers, completed FROM onboarding_state WHERE user_id = ?', userId));
  const a = answersOf(row?.answers);
  return { pending: !!row && row.completed === 0 && a.firstRun === true, step: stepOf(a.firstRunStep), ...(['individual', 'company'].includes(a.workspaceType as string) ? { workspaceType: a.workspaceType as WorkspaceType, ...(a.workspaceType === 'company' && validCompanyName(a.companyName) ? { companyName: a.companyName } : {}) } : {}) };
}

/** Remembers the step reached, so a restart continues where the owner left. */
export async function saveFirstRunStep(userId: string, step: FirstRunStep, workspaceType?: WorkspaceType, companyName?: string): Promise<FirstRunState> {
  const discoveryDone = (await firstRunDiscovery(userId)).status === 'done';
  await sql().tx(function* () {
    yield* lockName(`onboarding_state:${userId}`);
    const row = yield* one<Row>('SELECT answers, completed FROM onboarding_state WHERE user_id = ?', userId);
    const a = answersOf(row?.answers);
    if (!row || row.completed !== 0 || a.firstRun !== true) return;
    if (a.firstRunStep === 'discovery' && step !== 'discovery' && !discoveryDone) throw Object.assign(new Error('Discovery must complete first'), {code:'discovery_required'});
    yield* run('UPDATE onboarding_state SET answers = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?', JSON.stringify({ ...a, ...(a.firstRunStep === 'discovery' && step !== 'discovery' && discoveryDone ? {firstRunDiscovery:true} : {}), firstRunStep: step, ...(workspaceType ? { workspaceType, companyName: workspaceType === 'company' ? companyName : undefined } : {}) }), userId);
  });
  return firstRunState(userId);
}

// ---- AI tools ---------------------------------------------------------------

export type AiToolId = 'claude' | 'codex' | 'gemini';
export type AiTool = Readonly<{ id: AiToolId; name: string; installed: boolean; signedIn: boolean; install: string | null; signIn: string; needs?: 'node' }>;
type Env = { home: string; platform: NodeJS.Platform; dirs: string[]; keychain?: (service: string, home: string) => Promise<boolean> };

async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch { return false; } }
async function findBinary(env: Env, names: readonly string[]): Promise<string | null> {
  const exts = env.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of env.dirs) for (const n of names) for (const e of exts) { const f = path.join(dir, n + e); if (await exists(f)) return f; }
  return null;
}
/**
 * True when the macOS keychain this HOME uses holds an item for `service`. Only the item's presence
 * is asked (no -w / -g), so no secret is read and the system never asks for the password.
 */
export function keychainItem(service: string, home: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', service], { env: { ...process.env, HOME: home }, timeout: 5000, windowsHide: true }, error => resolve(!error));
  });
}
/**
 * Claude Code is signed in when its login is saved: ~/.claude/.credentials.json (Linux, Windows), or the
 * "Claude Code-credentials" keychain item on macOS. ~/.claude.json alone is not enough: Claude writes the
 * account there before it saves the login, so a save that failed ("Couldn't save your login") left the
 * row showing "signed in". Only presence is checked, never a value.
 */
async function claudeSignedIn(home: string, platform: NodeJS.Platform, keychain: (service: string, home: string) => Promise<boolean>): Promise<boolean> {
  if (await exists(path.join(home, '.claude', '.credentials.json'))) return true;
  if (platform !== 'darwin') return false;
  try { const v = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8')); if (!v || typeof v !== 'object' || !v.oauthAccount) return false; } catch { return false; }
  return keychain('Claude Code-credentials', home);
}

/**
 * SUB1 (STORE-MAP-01 P7): Antigravity's CLI `agy` signs in with the Google
 * account kept in ~/.gemini (the active account's presence only, never its value).
 */
async function antigravitySignedIn(home: string): Promise<boolean> {
  if (await exists(path.join(home, '.gemini', 'oauth_creds.json'))) return true;
  try { const v = JSON.parse(await fs.readFile(path.join(home, '.gemini', 'google_accounts.json'), 'utf8')); return !!v && typeof v === 'object' && typeof v.active === 'string' && !!v.active; } catch { return false; }
}

export async function aiTools(env?: Partial<Env>): Promise<AiTool[]> {
  const home = env?.home ?? os.homedir(), platform = env?.platform ?? process.platform;
  const e: Env = { home, platform, dirs: env?.dirs ?? await subscriptionSearchDirs(home) };
  const win = platform === 'win32';
  const npm = await findBinary(e, ['npm']), brew = win ? null : await findBinary(e, ['brew']);
  const pkg = (npmName: string, brewName: string) => npm ? `npm install -g ${npmName}` : brew ? `brew install ${brewName}` : `npm install -g ${npmName}`;
  const claude = await findBinary(e, ['claude']), codex = await findBinary(e, ['codex']), gemini = await findBinary(e, ['gemini']);
  const codexHome = process.env.CODEX_HOME && !env?.home ? process.env.CODEX_HOME : path.join(home, '.codex');
  // SUB1 (P7): the Google app is Antigravity (`agy`); the Gemini CLI no longer serves personal accounts.
  const agy = storeP7Enabled() ? await findBinary(e, ['agy']) : null;
  const google: AiTool = storeP7Enabled()
    ? { id: 'gemini', name: 'Antigravity', installed: !!agy, signedIn: !!agy && await antigravitySignedIn(home), install: null, signIn: 'agy' }
    : { id: 'gemini', name: 'Gemini CLI', installed: !!gemini, signedIn: !!gemini && await exists(path.join(home, '.gemini', 'oauth_creds.json')),
      install: gemini ? null : pkg('@google/gemini-cli', 'gemini-cli'), signIn: 'gemini', ...(!gemini && !npm && !brew ? { needs: 'node' as const } : {}) };
  return [
    { id: 'claude', name: 'Claude Code', installed: !!claude, signedIn: !!claude && await claudeSignedIn(home, platform, env?.keychain ?? keychainItem),
      install: claude ? null : win ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash', signIn: 'claude' },
    { id: 'codex', name: 'ChatGPT Codex', installed: !!codex, signedIn: !!codex && await exists(path.join(codexHome, 'auth.json')),
      install: codex ? null : pkg('@openai/codex', 'codex'), signIn: 'codex login', ...(!codex && !npm && !brew ? { needs: 'node' as const } : {}) },
    google,
  ];
}

// ---- Local model --------------------------------------------------------------

export type LocalChoice = Readonly<{ id: string; label: string; sizeGb: number; note: string; minMemoryGb: number; installed?: boolean }>;
/**
 * The memory each model needs leaves room for Girru, the AI tools and the owner's
 * own programs: a model sized to all the memory froze a 32 GB Mac (Mohamed 2026-10-31),
 * so the recommendation stays one size below.
 */
export const LOCAL_CHOICES: readonly LocalChoice[] = [
  { id: 'qwen3:4b', label: 'Qwen 3 · 4B', sizeGb: 3, note: 'Quick, simpler answers. For 8 to 16 GB of memory.', minMemoryGb: 8 },
  { id: 'qwen3.5:9b', label: 'Qwen 3.5 · 9B', sizeGb: 6, note: 'Good answers. For 24 GB of memory or more.', minMemoryGb: 24 },
  { id: 'qwen3:14b', label: 'Qwen 3 · 14B', sizeGb: 9, note: 'Better answers. For 48 GB of memory or more.', minMemoryGb: 48 },
];
/** The recommended model to download for this much memory (D3). */
export function recommendedLocal(memoryGb: number): LocalChoice {
  return [...LOCAL_CHOICES].reverse().find(c => memoryGb >= c.minMemoryGb) ?? LOCAL_CHOICES[0];
}

export type LocalModelStep = Readonly<{ memoryGb: number; recommended: string; choices: readonly LocalChoice[]; ollama: boolean; installed: readonly string[]; install: string | null; download: string | null }>;
export async function localModelStep(env?: Partial<Env> & { memoryBytes?: number; models?: () => Promise<{ name: string; size?: number; chat?: boolean }[]> }): Promise<LocalModelStep> {
  const home = env?.home ?? os.homedir(), platform = env?.platform ?? process.platform;
  const e: Env = { home, platform, dirs: env?.dirs ?? await subscriptionSearchDirs(home) };
  const memoryGb = Math.round((env?.memoryBytes ?? os.totalmem()) / 1024 ** 3);
  const ollama = !!(await findBinary(e, ['ollama'])) || (platform === 'darwin' && await exists('/Applications/Ollama.app'));
  // Chat models only: an embedding model (memory search) cannot answer.
  let models: { name: string; size?: number; chat?: boolean }[] = [];
  try { models = (await (env?.models ?? listLocalModels)()).filter(m => m.chat ?? !/embed/i.test(m.name)); } catch { /* Ollama not running yet */ }
  const installed = models.map(m => m.name);
  const listed = (name: string) => LOCAL_CHOICES.find(c => name === c.id || name.startsWith(c.id + '-'));
  // A model already on this computer is offered first, so nothing is downloaded twice.
  const own: LocalChoice[] = models.filter(m => !listed(m.name)).map(m => ({ id: m.name, label: m.name, sizeGb: Math.round((m.size ?? 0) / 1e9 * 10) / 10, note: 'Already on this computer.', minMemoryGb: 0, installed: true }));
  const choices = [...own, ...LOCAL_CHOICES.map(c => installed.some(n => listed(n) === c) ? { ...c, installed: true } : c)];
  const ready = choices.filter(c => c.installed);
  const recommended = (ready.find(c => memoryGb >= c.minMemoryGb) ?? recommendedLocal(memoryGb)).id;
  const brew = platform === 'darwin' ? await findBinary(e, ['brew']) : null;
  const install = ollama ? null : platform === 'linux' ? 'curl -fsSL https://ollama.com/install.sh | sh' : platform === 'win32' ? 'winget install Ollama.Ollama' : brew ? 'brew install ollama && brew services start ollama' : null;
  return { memoryGb, recommended, choices, ollama, installed, install,
    download: !ollama && !install ? 'https://ollama.com/download' : null };
}
/** The command typed for one model: install Ollama first when it is missing (and installable from the terminal). */
export function localModelCommand(step: LocalModelStep, modelId: string): string | null {
  if (!LOCAL_CHOICES.some(c => c.id === modelId)) return null;
  if (!step.ollama && !step.install) return null;
  return step.install ? `${step.install} && ollama pull ${modelId}` : `ollama pull ${modelId}`;
}

// ---- Finish: the Welcome chat -------------------------------------------------------

export const WELCOME_CHOICES = ['Here in Girru', 'On my phone', 'Telegram', 'WhatsApp', 'Another channel'] as const;
type AgentRow = { id: string; name: string; department: string | null; is_primary: number };

/** Plain words for the team, e.g. "Nora (marketing), Omar (sales) and Lina (support)". */
export function teamLine(agents: readonly { name: string; department: string | null }[], max = 6): string {
  const names = agents.slice(0, max).map(a => a.department ? `**${a.name}** (${a.department})` : `**${a.name}**`);
  if (agents.length > max) names.push(`${agents.length - max} more`);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
export function welcomeText(ownerName: string, mainName: string, team: readonly { name: string; department: string | null }[]): string {
  const first = ownerName.trim().split(/\s+/)[0] || 'there';
  const intro = team.length
    ? `Hi ${first}, I'm ${mainName}, your Main agent. Your team is ready: ${teamLine(team)}. Everyone asks you before doing anything outside Girru.`
    : `Hi ${first}, I'm ${mainName}, your Main agent. Everyone asks you before doing anything outside Girru.`;
  return `${intro}\n\nA few quick questions, then we start. **Where do you want to talk to me?**\n\nNext, one at a time: what should I call you, should I keep the name ${mainName}, and which language you want me to use.`;
}

/** Ends the setup steps and opens the Welcome chat with the Main agent's greeting. Repeat calls return the same chat. */
export async function finishFirstRun(userId: string): Promise<{ conversationId: string | null }> {
  const state = await sql().read(one<Row>('SELECT answers, completed FROM onboarding_state WHERE user_id = ?', userId));
  const a = answersOf(state?.answers);
  if (!state || a.firstRun !== true) return { conversationId: null };
  if (a.firstRunStep === 'discovery') throw Object.assign(new Error('Discovery must complete first'), {code:'discovery_required'});
  if (state.completed === 1) return { conversationId: typeof a.welcomeChat === 'string' ? a.welcomeChat : null };
  const owner = await sql().read(one<{ full_name: string | null }>('SELECT full_name FROM users WHERE id = ?', userId));
  const agents = await sql().read(all<AgentRow>('SELECT id, name, department, is_primary FROM agents_config ORDER BY is_primary DESC, created_at ASC'));
  const main = agents.find(x => x.is_primary === 1) ?? agents[0];
  const team = agents.filter(x => x !== main);
  const chat = await createConversation(userId, { title: 'Welcome', agentId: main?.id ?? null });
  const text = welcomeText(owner?.full_name ?? '', main?.name ?? 'your Main agent', team);
  await addAssistantMessage(chat.id, { runId: `welcome-${chat.id}`, content: text, durationMs: 0, status: 'complete', agentId: main?.id ?? null,
    parts: [{ kind: 'text', text }, { kind: 'notice', code: 'choices', text: WELCOME_CHOICES.join('\n') }] });
  await sql().tx(function* () {
    yield* lockName(`onboarding_state:${userId}`);
    yield* run('UPDATE onboarding_state SET completed = 1, completed_at = CURRENT_TIMESTAMP, answers = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
      JSON.stringify({ ...a, welcomeChat: chat.id }), userId);
  });
  if(a.firstRunDiscovery===true)await enableFirstRunAutomaticImport(userId);
  return { conversationId: chat.id };
}
