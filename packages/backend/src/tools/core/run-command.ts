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
import {spawn} from 'node:child_process';
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

const SIMPLE = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'echo', 'date', 'whoami']);
const VERSION_ONLY = new Set(['node', 'npm', 'pnpm', 'yarn', 'python', 'python3', 'go', 'cargo', 'java', 'dotnet', 'git']);
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'grep', 'fetch', 'pull', 'ls-remote', 'remote', 'branch', 'tag', 'stash']);
const GIT_BAD_FLAG = /^(--(upload-pack|receive-pack|exec|config-env|git-dir|work-tree|output|ext-diff|textconv|open-files-in-pager|rebase|recurse-submodules|pre|pre-glob|namespace)\b|-O|-c$|-u$|-C$)/;

function insideFolder(arg: string, cwd: string): boolean {
  const value = arg.startsWith('-') ? (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : '') : arg;
  if (!value) return true;
  if (value.startsWith('~') || /^[A-Za-z]:/.test(value) && !path.isAbsolute(value)) return false;
  if (!/[\\/]/.test(value) && value !== '..' && !path.isAbsolute(value)) return true;
  const rel = path.relative(cwd, path.resolve(cwd, value));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The allowlist: the words to start without a shell, or null when the command needs the owner's Run. */
export function allowedCommand(command: string, cwd: string): string[] | null {
  const words = splitCommand(command);
  if (!words) return null;
  const [cmd, ...args] = words;
  if (!args.every(a => insideFolder(a, cwd)) || args.some(a => a.includes('::') || /^ext:/i.test(a))) return null;
  if (VERSION_ONLY.has(cmd) && args.length === 1 && ['--version', '-v', 'version'].includes(args[0])) return words;
  if (SIMPLE.has(cmd)) return cmd === 'rg' && args.some(a => /^--pre/.test(a)) ? null : words;
  if (cmd !== 'git' || !args.length || !GIT_READ.has(args[0])) return null;
  const [sub, ...rest] = args;
  if (rest.some(a => GIT_BAD_FLAG.test(a))) return null;
  if (sub === 'remote' && !(rest.length === 0 || (rest.length === 1 && rest[0] === '-v'))) return null;
  if (sub === 'branch' && !rest.every(a => ['-a', '-r', '-v', '-vv', '--show-current', '--list'].includes(a))) return null;
  if (sub === 'tag' && !rest.every(a => a === '-l' || a === '--list')) return null;
  if (sub === 'stash' && !(rest.length === 1 && rest[0] === 'list')) return null;
  // Hooks, file monitors and external diff programs never run from an agent's git command.
  const noDiffTools = ['diff', 'show', 'log'].includes(sub) ? ['--no-ext-diff', '--no-textconv'] : [];
  return ['git', '-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false', sub, ...noDiffTools, ...rest];
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

const text = (s: string, error?: string): ToolResult => ({content: [{type: 'text', text: s}], ...(error ? {error} : {})});

/** Runs words directly (no shell) or, for a command the owner approved, a whole line through the system shell. */
export function runShell(command: string | string[], cwd: string, timeout: number): Promise<{code: number | null; out: string; timedOut: boolean; ms: number}> {
  const started = Date.now();
  return new Promise(resolve => {
    const win = process.platform === 'win32';
    const direct = Array.isArray(command);
    const file = direct ? command[0] : (win ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh');
    const args = direct ? command.slice(1) : (win ? ['/d', '/s', '/c', command] : ['-c', command]);
    const env = {...minimalChildEnv(), GIT_TERMINAL_PROMPT: '0'};
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
