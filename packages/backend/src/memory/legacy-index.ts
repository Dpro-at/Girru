/**
 * STORE-MAP-01 P4 (D8): the old hybrid index file `memory/memory.db`.
 *
 * Nothing writes it any more; only forget still purged a memory from it when
 * the file existed. While GIRRU_STORE_P4 is on, start-up retires it in one
 * step: a full backup that passes its check and verifiably holds the file,
 * then the file (and its -wal/-shm) is deleted. Without such a backup the
 * file is kept and the next start tries again. Once the file is gone, forget
 * has nothing to purge (see removeFromIndexFile in forget.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MEMORY_CONFIG } from './types.js';

export type LegacyIndexOutcome =
  | { state: 'none' }
  | { state: 'retired'; backupId: string }
  | { state: 'kept'; reason: string };

export function legacyIndexFile(): string {
  return path.resolve(process.cwd(), DEFAULT_MEMORY_CONFIG.dbPath);
}

/** Back up, check the backup holds the file, then delete it. Never deletes without that backup. */
export async function retireLegacyIndex(deps: {
  backUp?: () => Promise<{ id: string; checked: boolean }>;
  holds?: (id: string, rel: string) => Promise<boolean>;
} = {}): Promise<LegacyIndexOutcome> {
  const file = legacyIndexFile();
  if (!fs.existsSync(file)) return { state: 'none' };
  const B = await import('../services/backups.js');
  const backUp = deps.backUp ?? (() => B.backUpNow('before-update'));
  const holds = deps.holds ?? B.backupHolds;
  let b: { id: string; checked: boolean };
  try { b = await backUp(); } catch (err) { return { state: 'kept', reason: `no backup: ${(err as Error).message}` }; }
  if (!b.checked) return { state: 'kept', reason: 'the backup did not pass its check' };
  if (!(await holds(b.id, 'memory/memory.db').catch(() => false))) return { state: 'kept', reason: 'the backup does not hold memory/memory.db' };
  for (const side of ['', '-wal', '-shm', '-journal']) fs.rmSync(file + side, { force: true });
  return { state: 'retired', backupId: b.id };
}
