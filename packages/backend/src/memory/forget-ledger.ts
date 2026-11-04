/**
 * STORE-MAP-01 P9 (PRIV4, S7): the forget ledger (GIRRU_STORE_P9).
 *
 * Forget removes a memory from the database, its history, its files and the
 * caches. A backup made before that still holds it, so restoring the backup
 * would bring it back. The ledger remembers every forget, with ids and keyed
 * hashes only (never the text), and is re-applied after every restore.
 *
 *  - It lives in the data folder as `forget-ledger.jsonl` (0600), NOT in the
 *    database a restore replaces. A backup carries a copy (for a new
 *    computer); a restore keeps the current file and adds the backup's lines.
 *  - Each line: { v, at, userId, memoryId, kind, mac? }. `mac` is an HMAC of
 *    the forgotten text with `forget-ledger.key`, a key that stays in the data
 *    folder and is never in a backup, so the line cannot be used to confirm a
 *    guess of the text; on this computer the replay also forgets another copy
 *    of the very same text saved under another id.
 *  - After a restore (`forget-replay.json` marker, written by the restore),
 *    the next start re-applies every line: forget is idempotent, so lines
 *    from before the backup do nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { dataRoot } from '../config/data-root.js';
import { all, sql } from '../repositories/sql-steps.js';

export const LEDGER_FILE = 'forget-ledger.jsonl';
export const LEDGER_KEY_FILE = 'forget-ledger.key';
export const REPLAY_MARKER = 'forget-replay.json';
const ID = /^[A-Za-z0-9_.@-]{1,200}$/;

export interface LedgerLine {
  v: 1;
  at: string;
  userId: string;
  memoryId: string;
  /** 'memory': one memory; 'person': a whole person's drawer (PRIV6), memoryId = the person's key. */
  kind: 'memory' | 'person';
  mac?: string;
}

const ledgerPath = () => path.join(dataRoot(), LEDGER_FILE);

function ledgerKey(create: boolean): Buffer | null {
  const file = path.join(dataRoot(), LEDGER_KEY_FILE);
  try { const k = fs.readFileSync(file); if (k.length === 32) return k; } catch { /* none yet */ }
  if (!create) return null;
  const k = randomBytes(32);
  try { fs.writeFileSync(file, k, { mode: 0o600, flag: 'wx' }); } catch { return ledgerKey(false); }
  return k;
}

/** Keyed hash of a text (never the text itself); null without a key. */
export function textMac(text: string, create = false): string | null {
  const key = ledgerKey(create);
  return key ? createHmac('sha256', key).update(text.normalize('NFC')).digest('hex') : null;
}

function valid(l: unknown): l is LedgerLine {
  const x = l as LedgerLine;
  return !!x && x.v === 1 && typeof x.at === 'string' && typeof x.userId === 'string' && ID.test(x.userId)
    && typeof x.memoryId === 'string' && ID.test(x.memoryId) && (x.kind === 'memory' || x.kind === 'person')
    && (x.mac === undefined || (typeof x.mac === 'string' && /^[0-9a-f]{64}$/.test(x.mac)));
}

/** Every valid line of a ledger file (a broken line is skipped, never fatal). */
export function readLedger(file = ledgerPath()): LedgerLine[] {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out: LedgerLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try { const l = JSON.parse(raw); if (valid(l)) out.push(l); } catch { /* skip */ }
  }
  return out;
}

/** Append lines (0600); a forget that already has a line is not written twice. */
export function recordForgets(lines: Array<Omit<LedgerLine, 'v' | 'at'> & { at?: string }>): void {
  if (lines.length === 0) return;
  const file = ledgerPath();
  const have = new Set(readLedger(file).map((l) => `${l.kind}\u0000${l.userId}\u0000${l.memoryId}\u0000${l.mac ?? ''}`));
  const fresh: LedgerLine[] = [];
  for (const l of lines) {
    const line: LedgerLine = { v: 1, at: l.at ?? new Date().toISOString(), userId: l.userId, memoryId: l.memoryId, kind: l.kind, ...(l.mac ? { mac: l.mac } : {}) };
    const k = `${line.kind}\u0000${line.userId}\u0000${line.memoryId}\u0000${line.mac ?? ''}`;
    if (!valid(line) || have.has(k)) continue;
    have.add(k);
    fresh.push(line);
  }
  if (fresh.length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, fresh.map((l) => JSON.stringify(l)).join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** One forgotten memory: its id and the keyed hash of each text it had. */
export function recordMemoryForget(userId: string, memoryId: string, texts: string[]): void {
  const macs = [...new Set(texts.map((t) => textMac(t, true)).filter((m): m is string => !!m))];
  recordForgets(macs.length ? macs.map((mac) => ({ userId, memoryId, kind: 'memory' as const, mac })) : [{ userId, memoryId, kind: 'memory' }]);
}

/**
 * The restore's part: keep the current ledger and add the lines of the
 * backup's copy (`fromBackup`, a plain file), then leave the replay marker.
 */
export function mergeLedgerAfterRestore(fromBackup: string | null): void {
  if (fromBackup) {
    recordForgets(readLedger(fromBackup));
  }
  fs.writeFileSync(path.join(dataRoot(), REPLAY_MARKER), JSON.stringify({ at: new Date().toISOString() }) + '\n', { mode: 0o600 });
}

export function replayPending(): boolean {
  return fs.existsSync(path.join(dataRoot(), REPLAY_MARKER));
}

/**
 * Re-apply every forget of the ledger (after a restore). Returns how many
 * memories were forgotten again. The marker is removed only when every line
 * was applied, so a failed replay runs again on the next start.
 */
export async function replayForgetLedger(): Promise<{ lines: number; forgotten: number; failed: number }> {
  const { forgetMemory, forgetPersonMemories } = await import('./forget.js');
  const lines = readLedger();
  let forgotten = 0;
  let failed = 0;
  const macsByUser = new Map<string, Set<string>>();
  for (const l of lines) {
    try {
      if (l.kind === 'person') forgotten += (await forgetPersonMemories(l.userId, l.memoryId, 'forget-ledger')).forgotten;
      else if (await forgetMemory(l.userId, l.memoryId, 'forget-ledger')) forgotten++;
    } catch {
      failed++;
    }
    if (l.mac) {
      if (!macsByUser.has(l.userId)) macsByUser.set(l.userId, new Set());
      macsByUser.get(l.userId)!.add(l.mac);
    }
  }
  // The very same text under another id (saved again, imported again) goes too.
  if (ledgerKey(false)) {
    for (const [userId, macs] of macsByUser) {
      const rows = await sql().read(all<{ id: string; content: string }>('SELECT id, content FROM memories WHERE user_id = ?', userId));
      for (const r of rows) {
        if (!macs.has(textMac(r.content) ?? '')) continue;
        try { if (await forgetMemory(userId, r.id, 'forget-ledger')) forgotten++; } catch { failed++; }
      }
    }
  }
  if (failed === 0) fs.rmSync(path.join(dataRoot(), REPLAY_MARKER), { force: true });
  return { lines: lines.length, forgotten, failed };
}
