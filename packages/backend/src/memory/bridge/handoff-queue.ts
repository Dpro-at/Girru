/**
 * STORE-MAP-01 P9 (FAIL5): the dpro-memory server keeps a handoff it could
 * not deliver (GIRRU_STORE_P9 in that process's environment).
 *
 * When Girru cannot be reached, `handoff_write` (and the contract verb
 * `memory_handoff`) is kept in a small local queue,
 * `<config dir>/handoff-queue.jsonl` (0600, at most QUEUE_MAX notes, each at
 * most QUEUE_DAYS old), and the coding app is told so. The next call that
 * reaches Girru from the same folder sends that folder's queued notes,
 * oldest first, through this session (notes of other folders wait for a
 * session there); a note Girru refuses (not a connection failure) is dropped. A read tool that cannot
 * reach Girru says memory is offline and points to the project's brief
 * file. Girru's health view counts the queued notes (queuedHandoffs).
 */

import fs from 'node:fs';
import path from 'node:path';
import { BridgeClientError, type BridgeBackend } from './mcp-server.js';

export const QUEUE_FILE = 'handoff-queue.jsonl';
export const QUEUE_MAX = 20;
export const QUEUE_DAYS = 7;
const QUEUED_TOOLS = new Set(['handoff_write', 'memory_handoff']);
const OFFLINE = /Cannot reach Girru/;

interface Queued { at: string; cwd: string; tool: string; args: Record<string, unknown> }

export const OFFLINE_READ_TEXT = 'Girru memory is offline right now. Work from the project\'s .girru/brief.md (or AGENTS.md) if it exists, and do not guess what memory would say.';
export const QUEUED_TEXT = 'Girru is not reachable, so this handoff is kept on this computer and sent when Girru is back.';

function readQueue(file: string, now: number): Queued[] {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out: Queued[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const q = JSON.parse(line) as Queued;
      if (typeof q.tool !== 'string' || !QUEUED_TOOLS.has(q.tool) || typeof q.cwd !== 'string' || !q.args || typeof q.args !== 'object') continue;
      if (now - new Date(q.at).getTime() > QUEUE_DAYS * 86_400_000) continue;
      out.push(q);
    } catch { /* a broken line is skipped */ }
  }
  return out.slice(-QUEUE_MAX);
}

function writeQueue(file: string, items: Queued[]): void {
  if (items.length === 0) { fs.rmSync(file, { force: true }); return; }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, items.map((q) => JSON.stringify(q)).join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** How many handoffs wait in a config dir's queue (for the health view). */
export function queuedHandoffs(configDir: string, now = Date.now()): number {
  return readQueue(path.join(configDir, QUEUE_FILE), now).length;
}

/** Wrap a backend so handoffs survive Girru being away (`cwd`: the folder this process works in). */
export function queueingBackend(inner: BridgeBackend, o: { configDir: string; cwd: string }): BridgeBackend {
  const file = path.join(o.configDir, QUEUE_FILE);
  let flushing: Promise<void> | null = null;

  async function flush(): Promise<void> {
    const items = readQueue(file, Date.now());
    if (!items.some((q) => q.cwd === o.cwd)) return;
    const left: Queued[] = [];
    let away = false;
    for (const q of items) {
      if (away || q.cwd !== o.cwd) { left.push(q); continue; }
      try { await inner.call(q.tool, q.args); } catch (err) {
        // Still away: keep this and the rest; refused: drop it (it would never pass).
        if (err instanceof BridgeClientError && OFFLINE.test(err.message)) { left.push(q); away = true; }
      }
    }
    writeQueue(file, left);
  }

  return {
    async call(tool, args) {
      try {
        const r = await inner.call(tool, args);
        if (!flushing) flushing = flush().catch(() => undefined).finally(() => { flushing = null; });
        await flushing;
        return r;
      } catch (err) {
        if (!(err instanceof BridgeClientError) || !OFFLINE.test(err.message)) throw err;
        if (QUEUED_TOOLS.has(tool)) {
          const items = readQueue(file, Date.now());
          items.push({ at: new Date().toISOString(), cwd: o.cwd, tool, args });
          fs.mkdirSync(o.configDir, { recursive: true });
          writeQueue(file, items.slice(-QUEUE_MAX));
          return { text: QUEUED_TEXT };
        }
        return { text: OFFLINE_READ_TEXT };
      }
    },
  };
}
