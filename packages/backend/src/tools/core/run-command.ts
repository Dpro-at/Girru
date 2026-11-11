/**
 * CP15 (Mohamed, 2026-11-10): agents run commands like a person at a terminal, in the chat's
 * project folder, for every engine (Claude Code, Codex, Gemini, API and local models).
 *
 *  - Off until the owner turns on Settings › Permissions › "Agents can run commands on this computer".
 *  - run_command runs ordinary commands at once; the chat shows only the agent's final answer.
 *  - A risky command (deleting, pushing, force, sudo, anything outside the project folder) is refused
 *    by run_command and must go through run_command_owner, which waits for the owner's Run (approval card).
 *  - The child gets a minimal environment (no server secrets) and never the server's data folder.
 *  - Sign-ins and keys are never typed by the agent: the environment carries no secrets.
 */
import {spawn} from 'node:child_process';
import path from 'node:path';
import {realpathSync, statSync} from 'node:fs';
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

const RISKY_WORDS: RegExp[] = [
  /(^|[\s;&|(])(rm|rmdir|del|erase|rd|unlink|shred|truncate|mkfs|format|diskpart|dd)(\s|$)/i,
  /Remove-Item|Clear-Content|Format-Volume/i,
  /(^|[\s;&|(])(sudo|su|doas|runas|chmod|chown|chgrp|icacls|takeown|reg|setx|launchctl|systemctl|crontab|schtasks)(\s|$)/i,
  /\bgit\s+(push|clean|reset\s+--hard|rebase|filter-branch|filter-repo|update-ref|gc\s+--prune|reflog\s+expire|branch\s+-D|tag\s+-d|stash\s+(drop|clear))\b/i,
  /\bgit\s+checkout\s+--\s/i, /\s--force(\s|$|=)|\s-f(\s|$)/,
  /\b(curl|wget|iwr|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(sh|bash|zsh|pwsh|powershell|iex|python|node)\b/i,
  /\b(npm|pnpm|yarn)\s+publish\b|\bgh\s+(pr\s+merge|release|repo\s+delete)\b/i,
  /\b(shutdown|reboot|halt|poweroff|kill|killall|pkill|taskkill)\b/i,
];

/** True when a command needs the owner's Run: it may delete, push, act as another user, or reach outside the project folder. */
export function riskyCommand(command: string, cwd: string): boolean {
  if (RISKY_WORDS.some(r => r.test(command))) return true;
  // Paths outside the project folder (absolute, home or parent paths).
  for (const raw of command.match(/(?:^|\s|=|["'])((?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/]?|\.\.[\\/]?)[^\s"'|;&<>]*)/g) ?? []) {
    const p = raw.replace(/^[\s="']+/, '');
    if (p.startsWith('~') || p === '..' || /^\.\.[\\/]/.test(p)) return true;
    const abs = path.resolve(p);
    const rel = path.relative(cwd, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return true;
  }
  return /(^|[^<])>\s*\/dev\/(sd|disk|nvme)/.test(command);
}

function projectCwd(context: ToolExecutionContext | undefined): string | null {
  try { const cwd = realpathSync(safeChildCwd(context?.workspaceDir)); safeChildCwd(cwd); return statSync(cwd).isDirectory() ? cwd : null; } catch { return null; }
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

function runShell(command: string, cwd: string, timeout: number): Promise<{code: number | null; out: string; timedOut: boolean; ms: number}> {
  const started = Date.now();
  return new Promise(resolve => {
    const win = process.platform === 'win32';
    const child = spawn(win ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh', win ? ['/d', '/s', '/c', command] : ['-c', command], {cwd, env: minimalChildEnv(), windowsHide: true, windowsVerbatimArguments: win});
    let out = '', timedOut = false;
    const add = (b: Buffer) => { if (out.length < MAX_OUTPUT) out += b.toString('utf8').slice(0, MAX_OUTPUT - out.length); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.on('error', e => { clearTimeout(timer); resolve({code: null, out: out + String(e.message), timedOut, ms: Date.now() - started}); });
    child.on('close', code => { clearTimeout(timer); resolve({code, out, timedOut, ms: Date.now() - started}); });
  });
}

async function execute(params: unknown, context: ToolExecutionContext | undefined, ownerApproved: boolean): Promise<ToolResult> {
  if (!await agentCommandsOn(context?.accessOwnerId ?? context?.userId)) return text('Running commands is off on this computer. The owner can turn it on in Settings › Permissions › Agents can run commands.', 'agent_commands_off');
  const plan = readParams(params);
  if (!plan) return text('Give one command as text (and an optional timeout in milliseconds).', 'invalid_command');
  const cwd = projectCwd(context);
  if (!cwd) return text('This chat has no project folder, so commands cannot run here. Choose a folder for the chat first.', 'no_project_folder');
  if (!ownerApproved && riskyCommand(plan.command, cwd)) return text(`This command needs the owner: call run_command_owner with the same command, and Girru shows it with a Run button.\n${plan.command}`, 'owner_run_required');
  const r = await runShell(plan.command, cwd, plan.timeout);
  const head = r.timedOut ? `Stopped after ${Math.round(plan.timeout / 1000)} s.` : `Exit code ${r.code ?? 'unknown'} · ${r.ms} ms.`;
  return text(`${head}\n${r.out || '(no output)'}`, r.timedOut ? 'timeout' : r.code === 0 ? undefined : 'nonzero_exit');
}

const schema = {type: 'object', properties: {command: {type: 'string', description: 'One shell command, run in the chat’s project folder.'}, timeout: {type: 'number', description: 'Milliseconds, at most 120000. Default 60000.'}}, required: ['command'], additionalProperties: false} as const;

export const runCommandTool: Tool = {
  name: 'run_command',
  description: 'Run a shell command in this chat’s project folder (git, tests, builds, search, listing files…) and get its output. Deleting, pushing, force options, sudo and paths outside the project are refused here: use run_command_owner for those.',
  input_schema: schema as any,
  async execute(params, context) { return execute(params, context, false); },
};

export const runCommandOwnerTool: Tool = {
  name: 'run_command_owner',
  requiresApproval: true,
  description: 'Ask the owner to run a risky command (delete, push, force, sudo, outside the project folder) in this chat’s project folder. Girru shows the exact command with a Run button; it runs only after the owner presses it.',
  input_schema: schema as any,
  async execute(params, context) { return execute(params, context, true); },
};
