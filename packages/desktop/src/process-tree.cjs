'use strict';
const { execFile } = require('node:child_process');

/**
 * Stops a child process and everything it started. The Code editor server starts an extension
 * host (and file watchers) that outlive it when only the server is stopped: they are moved to
 * the system's init process and keep running after Girru quits. So the whole tree is read first,
 * while the links between parent and child still exist, then the child is stopped, and anything
 * from that tree that is still alive is stopped too (SIGTERM, then SIGKILL after a grace time).
 */

const run = (file, args) => new Promise(resolve => {
  execFile(file, args, { windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? '' : String(stdout)));
});

/** [{ pid, ppid }] for every process this user can see; empty when the table cannot be read. */
async function processTable({ platform = process.platform, exec = run } = {}) {
  const out = platform === 'win32'
    ? await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'])
    : await exec('ps', ['-A', '-o', 'pid=,ppid=']);
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]) });
  }
  return rows;
}

/** Every process below `root` in the table (not `root` itself), parents before children. */
function descendants(table, root) {
  const children = new Map();
  for (const { pid, ppid } of table) { if (pid === ppid) continue; if (!children.has(ppid)) children.set(ppid, []); children.get(ppid).push(pid); }
  const found = [], seen = new Set([root]), queue = [root];
  while (queue.length) for (const pid of children.get(queue.shift()) ?? []) if (!seen.has(pid)) { seen.add(pid); found.push(pid); queue.push(pid); }
  return found;
}

const alive = (pid, kill) => { try { kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };
const signal = (pid, name, kill) => { try { kill(pid, name); } catch { /* already gone */ } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Runs `stop()` (the child's own graceful stop), then stops what is left of the tree under `pid`.
 * A process is only signalled when it was in the tree before the stop and, after it, is still
 * under that tree or was moved to init (ppid 1): a reused pid that belongs to someone else is left alone.
 */
async function stopProcessTree(pid, stop, { platform = process.platform, exec = run, kill = process.kill.bind(process), graceMs = 3000, onLog = () => {} } = {}) {
  const tree = Number.isSafeInteger(pid) && pid > 1 ? descendants(await processTable({ platform, exec }), pid) : [];
  try { await stop?.(); }
  finally {
    if (tree.length) {
      const members = new Set([pid, ...tree]);
      const owned = async () => {
        const now = new Map((await processTable({ platform, exec })).map(row => [row.pid, row.ppid]));
        return tree.filter(child => now.has(child) && (members.has(now.get(child)) || now.get(child) === 1 || !now.has(now.get(child))) && alive(child, kill));
      };
      let left = await owned();
      if (left.length) {
        onLog(`Stopping ${left.length} leftover editor ${left.length === 1 ? 'process' : 'processes'}.`);
        for (const child of left) signal(child, 'SIGTERM', kill);
        const until = Date.now() + graceMs;
        while (Date.now() < until && (left = left.filter(child => alive(child, kill))).length) await pause(100);
        for (const child of left) signal(child, 'SIGKILL', kill);
      }
    }
  }
}

module.exports = { stopProcessTree, processTable, descendants };
