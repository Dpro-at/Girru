/**
 * STORE-MAP-01 P7 (SUB2): subscription replies on Windows.
 *
 * The POSIX launcher (subscription-launcher.ts) tracks a process group in a
 * journal. Windows has no process groups; it has Job Objects. Here the leader
 * is Windows PowerShell (the copy in System32, never one found on PATH). It
 * puts ITSELF into a new job with KILL_ON_JOB_CLOSE before it starts the CLI,
 * so the CLI and everything the CLI starts belong to that job. The job ends
 * with the leader: when the CLI is done, when Girru stops the reply (the
 * leader is killed), or when Girru itself goes away (the leader watches
 * Girru's process through a handle it opened at start, so a reused process id
 * cannot fool it). No journal is needed: nothing outlives the leader.
 *
 * Only `.exe` programs are started (a `.cmd`/`.bat` shim would pass the
 * arguments through cmd.exe). The arguments are joined with the Windows
 * C runtime's quoting rules, so each one reaches the CLI as one argument.
 * The prompt goes to the CLI's stdin, never into a command line.
 *
 * Tests: test/subscription-launcher-win.test.mjs (Windows CI only for the
 * real job; the quoting and the leader script are checked everywhere).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { storeP7Enabled } from './store-p7.js';

const MAX_COMMAND_LINE = 30_000;
/** Windows needs these to start PowerShell and compile its helper; the rest of the env stays minimal. */
const WINDOWS_BASE_ENV = ['SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'COMSPEC', 'PATHEXT'];

/** One argument quoted the way CommandLineToArgvW / the MS C runtime reads it back. */
export function quoteWindowsArg(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) return arg;
  let out = '"', slashes = 0;
  for (const ch of arg) {
    if (ch === '\\') { slashes++; continue; }
    if (ch === '"') { out += '\\'.repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
    out += '\\'.repeat(slashes) + ch; slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

export const windowsCommandLine = (args: readonly string[]): string => args.map(quoteWindowsArg).join(' ');

/** The C# helper: a job with KILL_ON_JOB_CLOSE (0x2000) that the leader joins itself. */
const JOB_HELPER = `
using System; using System.Runtime.InteropServices;
public static class GirruJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong R, W, O, RB, WB, OB; }
  [StructLayout(LayoutKind.Sequential)] struct Ext { public Basic B; public Io I; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref Ext i, uint l);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  public static IntPtr Job;
  public static void Enter() {
    Job = CreateJobObject(IntPtr.Zero, null);
    if (Job == IntPtr.Zero) throw new Exception("job_unavailable");
    Ext e = new Ext(); e.B.LimitFlags = 0x2000;
    if (!SetInformationJobObject(Job, 9, ref e, (uint)Marshal.SizeOf(typeof(Ext)))) throw new Exception("job_unavailable");
    if (!AssignProcessToJobObject(Job, GetCurrentProcess())) throw new Exception("job_unavailable");
  }
}`;

/** The leader. Its spec comes in GIRRU_LAUNCH_SPEC (base64 JSON), which the CLI never sees. */
export const WINDOWS_LEADER = `$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
${JOB_HELPER}
'@
  [GirruJob]::Enter()
  $spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:GIRRU_LAUNCH_SPEC)) | ConvertFrom-Json
  $parent = [Diagnostics.Process]::GetProcessById([int]$spec.parent)
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $spec.program; $psi.Arguments = $spec.commandLine; $psi.WorkingDirectory = $spec.cwd
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  [void]$psi.EnvironmentVariables.Remove('GIRRU_LAUNCH_SPEC')
  $p = [Diagnostics.Process]::Start($psi)
} catch { [Console]::Error.WriteLine('subscription_launch_unavailable'); exit 1 }
$out = [Console]::OpenStandardOutput(); $err = [Console]::OpenStandardError(); $in = [Console]::OpenStandardInput()
$t1 = $p.StandardOutput.BaseStream.CopyToAsync($out); $t2 = $p.StandardError.BaseStream.CopyToAsync($err)
try { $in.CopyTo($p.StandardInput.BaseStream) } catch {} finally { try { $p.StandardInput.Close() } catch {} }
while (-not $p.WaitForExit(250)) { if ($parent.HasExited) { exit 1 } }
try { [void]$t1.Wait(5000); [void]$t2.Wait(5000); $out.Flush(); $err.Flush() } catch {}
exit $p.ExitCode
`;

const encoded = (script: string) => Buffer.from(script, 'utf16le').toString('base64');

/** Leaders of replies still running, so a shutdown ends them (and their jobs). */
const running = new Set<ChildProcess>();
export function stopWindowsSubscriptions(): void { for (const c of running) { try { c.kill(); } catch { /* already gone */ } } }

export function windowsPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export async function launchWindowsSubscription(program: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; maxInputBytes?: number; platform?: NodeJS.Platform })
  : Promise<{ child: ChildProcess; start: (prompt: string) => void; completion: Promise<number> }> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' || !storeP7Enabled()) throw Error('subscription_launch_invalid');
  if (!path.win32.isAbsolute(program) || path.win32.extname(program).toLowerCase() !== '.exe' || !path.win32.isAbsolute(options.cwd)
    || !Array.isArray(args) || args.length > 256 || args.some((a) => typeof a !== 'string' || a.includes('\0'))) throw Error('subscription_launch_invalid');
  const commandLine = windowsCommandLine(args);
  if (commandLine.length > MAX_COMMAND_LINE) throw Error('subscription_launch_invalid');
  const env: NodeJS.ProcessEnv = { ...options.env };
  for (const k of WINDOWS_BASE_ENV) if (env[k] === undefined && process.env[k] !== undefined) env[k] = process.env[k];
  env.GIRRU_LAUNCH_SPEC = Buffer.from(JSON.stringify({ program, commandLine, cwd: options.cwd, parent: process.pid }), 'utf8').toString('base64');
  const child = spawn(windowsPowerShell(env), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded(WINDOWS_LEADER)],
    { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
  running.add(child);
  let finish: (code: number) => void = () => {};
  const completion = new Promise<number>((resolve) => { finish = resolve; });
  child.once('close', (code) => { running.delete(child); finish(Number.isInteger(code) ? Number(code) : 1); });
  child.once('error', () => { running.delete(child); finish(1); });
  child.stdin!.on('error', () => {});
  if (!child.pid) { running.delete(child); throw Error('subscription_launch_unavailable'); }
  let started = false;
  return {
    child, completion,
    start(prompt: string) {
      if (started || typeof prompt !== 'string' || Buffer.byteLength(prompt, 'utf8') > (options.maxInputBytes ?? 200000)) { child.kill(); throw Error('subscription_launch_invalid'); }
      started = true;
      child.stdin!.end(prompt);
    },
  };
}
