/**
 * CP15 (Mohamed, 2026-11-10): agents run commands in the chat's project folder, for every engine
 * (Claude Code, Codex, Gemini, API and local models).
 *
 *  - Off until the owner turns on Settings › Permissions › "Agents can run commands on this computer".
 *  - run_command runs only a short list of known read-and-sync commands (git status/log/diff/pull…, ls, cat,
 *    grep…), started directly without a shell, with paths inside the project folder and git hooks turned off.
 *    Security review: a list of blocked words can always be got around, so the boundary is this allowlist.
 *  - Everything else (builds, tests, pipes, deleting, pushing, anything outside the folder) goes through
 *    run_command_owner, which shows the exact command and runs it only after the owner presses Run.
 *  - The child gets a minimal environment (no server secrets) and never the server's own folder.
 */
import {spawn, spawnSync} from 'node:child_process';
import path from 'node:path';
import {realpathSync, statSync} from 'node:fs';
import os from 'node:os';
import type {Tool, ToolExecutionContext, ToolResult} from '../types.js';
import {minimalChildEnv, safeChildCwd} from '../exec-policy.js';
import {getPref} from '../../repositories/user-prefs.js';

export const AGENT_COMMANDS_PREF = 'agent-commands';
const MAX_TIMEOUT = 120_000, MAX_OUTPUT = 64 * 1024;

/** The owner's switch for this computer. */
export async function agentCommandsOn(userId: string | undefined | null): Promise<boolean> {
  if (!userId) return false;
  try { return (await getPref(userId, AGENT_COMMANDS_PREF)) === true; } catch { return false; }
}

/** Splits a command into words with plain quotes; null when it uses any shell feature (pipes, redirects, $, `, ;, &…). */
export function splitCommand(command: string): string[] | null {
  const out: string[] = []; let cur = '', quote: string | null = null, has = false;
  for (const ch of command) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (has || cur) out.push(cur); cur = ''; has = false; continue; }
    if (/[|;&<>$`(){}\n\r]/.test(ch)) return null;
    cur += ch; has = true;
  }
  if (quote) return null;
  if (has || cur) out.push(cur);
  return out.length ? out : null;
}

// Security review: every command accepts only flags listed here (exact words); anything else needs the owner.
const NUM = /^-\d{1,6}$|^-n\d{1,6}$|^--max-count=\d{1,6}$/;
const FLAGS: Record<string, string[]> = {
  ls: ['-l', '-a', '-la', '-al', '-lh', '-lah', '-R', '-1', '-A'], cat: [], wc: ['-l', '-w', '-c'], pwd: [], date: [], whoami: [],
  head: ['#n'], tail: ['#n'], grep: ['-n', '-i', '-r', '-l', '-c', '-w', '-v', '-E', '-F', '-I', '-rn', '-rin', '-ri'], rg: ['-n', '-i', '-l', '-c', '-w', '-F', '--hidden'],
};
const GIT_FLAGS: Record<string, string[]> = {
  status: ['-s', '--short', '-b', '--branch', '-sb', '--porcelain'],
  log: ['#n', '--oneline', '--stat', '--graph', '--decorate', '--all', '-p', '--name-only', '--name-status', '--pretty=oneline', '--pretty=short', '--pretty=medium', '--pretty=full'],
  diff: ['--stat', '--name-only', '--name-status', '--cached', '--staged', '--shortstat', '-p'], show: ['--stat', '--name-only', '--name-status', '--oneline', '-p', '--shortstat'],
  'rev-parse': ['--short', '--abbrev-ref', '--show-toplevel', '--is-inside-work-tree', '--verify'], 'ls-files': ['-m', '-o', '-c', '--others', '--modified', '--cached', '--exclude-standard'],
  blame: ['-s'], describe: ['--tags', '--always'], shortlog: ['-s', '-n', '-e', '-sn', '-sne'], grep: ['-n', '-i', '-l', '-c', '-w', '-I', '--count'],
  fetch: ['--all', '--prune', '-p', '--tags', '--dry-run'], pull: ['--ff-only', '--no-rebase'], 'ls-remote': ['--heads', '--tags'],
  remote: ['-v'], branch: ['-a', '-r', '-v', '-vv', '--show-current', '--list'], tag: ['-l', '--list'], stash: [],
};
const VERSION_ONLY = new Set(['node', 'npm', 'pnpm', 'yarn', 'python', 'python3', 'go', 'cargo', 'java', 'dotnet', 'git']);
const GIT_WORD = /^[A-Za-z0-9._\/~^@+-]{1,200}$/;

/** A path the command may read: inside the project folder after links are followed. */
function insideFolder(value: string, cwd: string): boolean {
  if (value.startsWith('~') || /^[A-Za-z]:/.test(value) || value.startsWith('\\\\')) return false;
  let abs = path.resolve(cwd, value);
  try { abs = realpathSync(abs); } catch { /* not there yet: checked as written */ }
  const rel = path.relative(cwd, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Splits flags from other words; null when a flag is not listed. '#n' allows -N, -nN, --max-count=N and "-n N". */
function checkFlags(args: string[], allowed: string[]): string[] | null {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) { rest.push(a); continue; }
    if (allowed.includes('#n') && (NUM.test(a) || (a === '-n' && /^\d{1,6}$/.test(args[i + 1] ?? '') && ++i))) continue;
    if (a === '--') return null;
    if (!allowed.includes(a)) return null;
  }
  return rest;
}

/** Security review: the project's own git settings (local and worktree scope) may hold only these known-safe keys;
 *  any other key could start a program, so git commands then wait for the owner's Run. The owner's global settings stay as they are. */
const SAFE_GIT_KEY = /^(core\.(bare|repositoryformatversion|filemode|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|quotepath)|remote\.[^=]+\.(url|fetch|pushurl|tagopt|prune)|branch\.[^=]+\.(remote|merge|description|vscode-merge-base|github-pr-owner-number)|user\.(name|email)|lfs\.repositoryformatversion|submodule\.active|extensions\.worktreeconfig|pull\.ff|fetch\.prune|init\.defaultbranch|color\.[a-z.]+)$/i;
/** Takes exact key names (from `git config --name-only -z`), never `key=value` lines: a value can never pass as a key. */
export function gitConfigIsPlain(names: string[]): boolean {
  return names.every(n => !/[=\s]/.test(n) && SAFE_GIT_KEY.test(n));
}
/** The key names git really uses from the project (local and worktree scope, includes followed), NUL-separated so
 *  no value can be read as a key; null when it cannot be read. */
function localGitConfig(cwd: string): string[] | null {
  try {
    const r = spawnSync('git', ['config', '--list', '--show-scope', '--includes', '--name-only', '-z'], {cwd, encoding: 'utf8', timeout: 5000, env: {...minimalChildEnv(), GIT_CONFIG_NOSYSTEM: '1'}, windowsHide: true});
    if (r.status !== 0) return null;
    const parts = r.stdout.split('\0'); if (parts.at(-1) === '') parts.pop();
    if (parts.length % 2) return null;
    const names: string[] = [];
    for (let i = 0; i < parts.length; i += 2) if (parts[i] !== 'global' && parts[i] !== 'system') names.push(parts[i + 1]);
    return names;
  } catch { return null; }
}

function gitRemotes(cwd: string): string[] {
  try { const r = spawnSync('git', ['remote'], {cwd, encoding: 'utf8', timeout: 5000, env: minimalChildEnv(), windowsHide: true}); return r.status === 0 ? r.stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean) : []; } catch { return []; }
}

/** The allowlist: the words to start without a shell, or null when the command needs the owner's Run. */
export function allowedCommand(command: string, cwd: string, remotes: (cwd: string) => string[] = gitRemotes, localConfig: (cwd: string) => string[] | null = localGitConfig): string[] | null {
  const words = splitCommand(command);
  if (!words) return null;
  const [cmd, ...args] = words;
  if (VERSION_ONLY.has(cmd) && args.length === 1 && ['--version', '-v', 'version'].includes(args[0])) return words;
  if (cmd === 'echo') return args.some(a => a.startsWith('-')) ? null : words;
  if (cmd !== 'git') {
    const rest = Object.hasOwn(FLAGS, cmd) ? checkFlags(args, FLAGS[cmd]) : null;
    if (!rest) return null;
    // grep/rg take the pattern first; every other word is a path in the folder.
    const paths = cmd === 'grep' || cmd === 'rg' ? rest.slice(1) : rest;
    return paths.every(p => insideFolder(p, cwd)) ? words : null;
  }
  const [sub, ...gitArgs] = args;
  if (!sub || !Object.hasOwn(GIT_FLAGS, sub)) return null;
  const rest = checkFlags(gitArgs, GIT_FLAGS[sub]);
  if (!rest) return null;
  if (sub === 'stash' ? !(rest.length === 1 && rest[0] === 'list') : sub === 'remote' || sub === 'branch' || sub === 'tag' ? rest.length > 0 : false) return null;
  if (sub === 'grep') { if (!rest.length || !rest.slice(1).every(p => GIT_WORD.test(p) && !p.includes('..') && insideFolder(p, cwd))) return null; }
  else if (!rest.every(w => GIT_WORD.test(w) && !w.includes('..') && !w.includes('//') && insideFolder(w, cwd))) return null;
  // Network commands: only the project's own remotes by name, never an address.
  if ((sub === 'fetch' || sub === 'pull' || sub === 'ls-remote') && rest.length && !remotes(cwd).includes(rest[0])) return null;
  const config = localConfig(cwd);
  if (!config || !gitConfigIsPlain(config)) return null;
  // Hooks, file monitors, pagers and external diff programs never run from an agent's git command.
  const noDiffTools = ['diff', 'show', 'log'].includes(sub) ? ['--no-ext-diff', '--no-textconv'] : sub === 'blame' || sub === 'grep' ? ['--no-textconv'] : [];
  return ['git', '-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'core.gitProxy=', '-c', 'pull.rebase=false', '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false', '-c', 'diff.ignoreSubmodules=all', '-c', 'status.submoduleSummary=false', sub, ...noDiffTools, ...(sub === 'pull' ? ['--no-rebase', '--no-recurse-submodules'] : sub === 'fetch' ? ['--no-recurse-submodules'] : sub === 'status' || sub === 'diff' ? ['--ignore-submodules=all'] : []), ...gitArgs];
}

/** True when the command needs the owner's Run (not on the allowlist). */
export function riskyCommand(command: string, cwd: string): boolean {
  return allowedCommand(command, cwd) === null;
}

/** Review fix: only the chat's own project folder; never the server's folder, its parents, the home folder or the disk root. */
function projectCwd(context: ToolExecutionContext | undefined): string | null {
  const root = context?.fileReadRoot || context?.workspaceDir;
  if (!root) return null;
  try {
    const cwd = realpathSync(safeChildCwd(root));
    const server = realpathSync(process.cwd());
    const inside = (a: string, b: string) => { const r = path.relative(b, a); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
    if (inside(server, cwd) || cwd === realpathSync(os.homedir()) || cwd === path.parse(cwd).root) return null;
    return statSync(cwd).isDirectory() ? cwd : null;
  } catch { return null; }
}

function readParams(params: unknown): {command: string; timeout: number} | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const p = params as Record<string, unknown>;
  if (Object.keys(p).some(k => k !== 'command' && k !== 'timeout')) return null;
  if (typeof p.command !== 'string' || !p.command.trim() || p.command.length > 8000 || /\x00/.test(p.command)) return null;
  const t = p.timeout === undefined ? 60_000 : p.timeout;
  if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < 1) return null;
  return {command: p.command, timeout: Math.min(t, MAX_TIMEOUT)};
}

/** Review fix: only Girru's own styling reaches the Terminal; control characters from a command or its output are dropped. */
export const plainText = (s: string) => s.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const text = (s: string, error?: string): ToolResult => ({content: [{type: 'text', text: s}], ...(error ? {error} : {})});

/** Runs words directly (no shell) or, for a command the owner approved, a whole line through the system shell. */
export function runShell(command: string | string[], cwd: string, timeout: number): Promise<{code: number | null; out: string; timedOut: boolean; ms: number}> {
  const started = Date.now();
  return new Promise(resolve => {
    const win = process.platform === 'win32';
    const direct = Array.isArray(command);
    const file = direct ? command[0] : (win ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh');
    const args = direct ? command.slice(1) : (win ? ['/d', '/s', '/c', command] : ['-c', command]);
    const env = {...minimalChildEnv(), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_LITERAL_PATHSPECS: '1'};
    let child;
    try { child = spawn(file, args, {cwd, env, windowsHide: true, windowsVerbatimArguments: win && !direct, detached: !win, shell: false}); }
    catch (e) { resolve({code: null, out: String((e as Error).message), timedOut: false, ms: 0}); return; }
    let out = '', timedOut = false, done = false;
    const finish = (code: number | null, extra = '') => { if (done) return; done = true; clearTimeout(timer); resolve({code, out: out + extra, timedOut, ms: Date.now() - started}); };
    const add = (b: Buffer) => { if (out.length < MAX_OUTPUT) out += b.toString('utf8').slice(0, MAX_OUTPUT - out.length); };
    child.stdout?.on('data', add); child.stderr?.on('data', add);
    // The timeout stops the whole process group (children too), and a child left holding the output cannot keep the call open.
    const killAll = () => {
      try { if (win && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {windowsHide: true}); else if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    };
    const timer = setTimeout(() => { timedOut = true; killAll(); setTimeout(() => finish(null), 2000).unref(); }, timeout);
    child.on('error', e => finish(null, String(e.message)));
    child.on('exit', code => { setTimeout(() => { killAll(); finish(code); }, 500).unref(); });
    child.on('close', code => finish(code));
  });
}

async function execute(params: unknown, context: ToolExecutionContext | undefined, ownerApproved: boolean): Promise<ToolResult> {
  if (!await agentCommandsOn(context?.accessOwnerId ?? context?.userId)) return text('Running commands is off on this computer. The owner can turn it on in Settings › Permissions › Agents can run commands.', 'agent_commands_off');
  const plan = readParams(params);
  if (!plan) return text('Give one command as text (and an optional timeout in milliseconds).', 'invalid_command');
  const cwd = projectCwd(context);
  if (!cwd) return text('This chat has no project folder, so commands cannot run here. Choose a folder for the chat first.', 'no_project_folder');
  const words = ownerApproved ? null : allowedCommand(plan.command, cwd);
  if (!ownerApproved && !words) return text(`This command needs the owner: call run_command_owner with the same command, and Girru shows it with a Run button.\n${plan.command}`, 'owner_run_required');
  const r = await runShell(words ?? plan.command, cwd, plan.timeout);
  // CP15: every command and its output also show in Girru's Terminal, in the "Agent commands" tab.
  try {
    const owner = context?.accessOwnerId ?? context?.userId;
    if (owner) { const {terminalManager} = await import('../../api/routes/terminal.js'); const out = plainText(r.out.slice(0, 16_000)); terminalManager.appendLog(owner, `\x1b[2m${new Date().toLocaleTimeString()} · ${plainText(path.basename(cwd))}${ownerApproved ? ' · run by the owner' : ''}\x1b[0m\n$ ${plainText(plan.command)}\n${out}${out.endsWith('\n') || !out ? '' : '\n'}\x1b[2m${r.timedOut ? 'stopped (time limit)' : `exit ${r.code ?? '?'}`}\x1b[0m\n\n`); }
  } catch { /* the Terminal is optional */ }
  const head = r.timedOut ? `Stopped after ${Math.round(plan.timeout / 1000)} s.` : `Exit code ${r.code ?? 'unknown'} · ${r.ms} ms.`;
  return text(`${head}\n${r.out || '(no output)'}`, r.timedOut ? 'timeout' : r.code === 0 ? undefined : 'nonzero_exit');
}

const schema = {type: 'object', properties: {command: {type: 'string', description: 'One command, run in the chat’s project folder.'}, timeout: {type: 'number', description: 'Milliseconds, at most 120000. Default 60000.'}}, required: ['command'], additionalProperties: false} as const;

export const runCommandTool: Tool = {
  name: 'run_command',
  description: 'Run a read or sync command in this chat’s project folder and get its output, at once: git status/log/diff/show/branch/fetch/pull/rev-parse/ls-files/grep, ls, cat, head, tail, wc, grep, rg, and --version checks. No pipes or shell features. Anything else (builds, tests, installs, deleting, pushing, pipes, paths outside the folder) goes through run_command_owner.',
  input_schema: schema as any,
  async execute(params, context) { return execute(params, context, false); },
};

export const runCommandOwnerTool: Tool = {
  name: 'run_command_owner',
  requiresApproval: true,
  description: 'Ask the owner to run any other command (builds, tests, installs, pipes, delete, push, outside the folder) in this chat’s project folder. Girru shows the exact command with a Run button; it runs only after the owner presses it.',
  input_schema: schema as any,
  async execute(params, context) { return execute(params, context, true); },
};
