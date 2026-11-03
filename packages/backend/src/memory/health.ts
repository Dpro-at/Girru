/**
 * STORE-MAP-01 P9 (OPS6, FAIL4–FAIL6, A6): memory health, on this computer
 * only (GIRRU_STORE_P9). No telemetry: nothing here is sent anywhere.
 *
 *  - Failures are counted (memory_health_events, migration 180): a save that
 *    did not happen, a recall that failed (the reply went on without memory),
 *    a scheduled memory doctor run. Ids and counts only, never memory text;
 *    rows older than KEEP_DAYS are removed when new ones come.
 *  - A failure of the same kind twice within a day raises ONE notice (at
 *    most one per kind per day).
 *  - memoryHealth: the five rows of the health view (Remembering, Saving,
 *    Backups, Coding apps, Background jobs) with a state word each and the
 *    7-day counts; a sixth, Memory helper, while GIRRU_MEMORY_HELPER is on.
 *  - supportBundle: versions, counts, ids and timings the owner may choose
 *    to share; never memory text, names, keys or paths in the home folder.
 *  - The scheduled doctor (jobs.ts 'doctor') only reads: it records the
 *    counts of its report; fixes still need the owner's confirm.
 */

import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { all, one, run, sql } from '../repositories/sql-steps.js';
import { storeP9Enabled } from '../services/store-p9.js';
import { recallIndexStats } from './recall-index.js';

export type HealthKind = 'save_failed' | 'recall_failed' | 'doctor';

/** FAIL4 (AG8): what a reply is told when its memory could not be read. */
export const MEMORY_UNAVAILABLE_NOTE = 'Memory note: Girru\'s memory was not available for this reply. Answer without it; if the answer depends on what you would remember, say that memory was unavailable. Never invent what memory would say.';
export const KEEP_DAYS = 30;
const DAY = 86_400_000;

const ID = /^[A-Za-z0-9_.:@-]{1,200}$/;

/**
 * Count one event (best effort: never throws, never slows the caller).
 * `ref` is an id (agent, run, memory, report hash), never text.
 */
export async function recordHealthEvent(ownerId: string | null | undefined, kind: HealthKind, ref?: string | null, detail?: Record<string, number>): Promise<void> {
  if (!ownerId || !storeP9Enabled()) return;
  try {
    const now = new Date();
    const safeRef = typeof ref === 'string' && ID.test(ref) ? ref : null;
    await sql().read(run('INSERT INTO memory_health_events (id, owner_id, kind, ref, detail, at) VALUES (?, ?, ?, ?, ?, ?)',
      uuidv4(), ownerId, kind, safeRef, detail ? JSON.stringify(detail) : null, now.toISOString()));
    await sql().read(run('DELETE FROM memory_health_events WHERE owner_id = ? AND at < ?', ownerId, new Date(now.getTime() - KEEP_DAYS * DAY).toISOString()));
    if (kind !== 'doctor') await noticeOnRepeat(ownerId, kind, now);
  } catch { /* health must never break a reply or a save */ }
}

const NOTICE_TEXT: Record<Exclude<HealthKind, 'doctor'>, { title: string; body: string }> = {
  save_failed: { title: 'Memory could not save twice today', body: 'Open Settings › Memory › Health to try again.' },
  recall_failed: { title: 'Memory was not available twice today', body: 'Replies went on without memory. Open Settings › Memory › Health.' },
};

async function noticeOnRepeat(ownerId: string, kind: Exclude<HealthKind, 'doctor'>, now: Date): Promise<void> {
  const since = new Date(now.getTime() - DAY).toISOString();
  const r = await sql().read(one<{ n: number }>('SELECT COUNT(*) AS n FROM memory_health_events WHERE owner_id = ? AND kind = ? AND at >= ?', ownerId, kind, since));
  if (Number(r?.n ?? 0) !== 2) return; // exactly the second one: one notice per burst
  const sent = await sql().read(one<{ n: number }>("SELECT COUNT(*) AS n FROM memory_health_events WHERE owner_id = ? AND kind = 'notice' AND ref = ? AND at >= ?", ownerId, kind, since));
  if (Number(sent?.n ?? 0) > 0) return;
  await sql().read(run("INSERT INTO memory_health_events (id, owner_id, kind, ref, detail, at) VALUES (?, ?, 'notice', ?, NULL, ?)", uuidv4(), ownerId, kind, now.toISOString()));
  const { notify } = await import('../services/notification-service.js');
  await notify({ userId: ownerId, ...NOTICE_TEXT[kind], type: 'warning', channel: 'in_app', actionUrl: '/settings/memory/health', source: 'system' }).catch(() => undefined);
}

async function counts(ownerId: string, sinceMs: number): Promise<Record<string, number>> {
  const rows = await sql().read(all<{ kind: string; n: number }>('SELECT kind, COUNT(*) AS n FROM memory_health_events WHERE owner_id = ? AND at >= ? GROUP BY kind', ownerId, new Date(sinceMs).toISOString())).catch(() => []);
  return Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
}

export type HealthState = 'ok' | 'needs_you';
export interface HealthRow { id: 'remembering' | 'saving' | 'backups' | 'coding_apps' | 'background' | 'memory_helper'; state: HealthState; word: string; detail: Record<string, unknown> }

/** The health view (owner only, callers check). */
export async function memoryHealth(ownerId: string, now: Date = new Date()): Promise<{ checkedAt: string; rows: HealthRow[] }> {
  const day = await counts(ownerId, now.getTime() - DAY);
  const week = await counts(ownerId, now.getTime() - 7 * DAY);
  const rows: HealthRow[] = [];

  rows.push({ id: 'remembering', state: (day.recall_failed ?? 0) > 0 ? 'needs_you' : 'ok', word: (day.recall_failed ?? 0) > 0 ? 'Not available today' : 'Working',
    detail: { recallFailed7d: week.recall_failed ?? 0, index: recallIndexStats() } });
  rows.push({ id: 'saving', state: (day.save_failed ?? 0) > 0 ? 'needs_you' : 'ok', word: (day.save_failed ?? 0) > 0 ? `${day.save_failed} not saved` : 'Working',
    detail: { saveFailed7d: week.save_failed ?? 0 } });

  const { dbDriver } = await import('../db/pg/config.js');
  if (dbDriver() === 'postgres') {
    const { pgDumpStatus } = await import('../services/backups.js');
    const pg = pgDumpStatus(now);
    rows.push({ id: 'backups', state: pg.fresh ? 'ok' : 'needs_you', word: pg.fresh ? 'Database copy found' : 'No recent database copy', detail: { postgres: true, ageHours: pg.ageHours } });
  } else {
    const { backupStatus } = await import('../services/backups.js');
    const st = backupStatus(now);
    const last = st.last;
    const fresh = !!last && now.getTime() - new Date(last.at).getTime() <= 2 * DAY;
    const ok = !!last && last.checked && last.restoreTested !== false && fresh && !st.lastError;
    rows.push({ id: 'backups', state: ok ? 'ok' : 'needs_you', word: !last ? 'No backup yet' : !last.checked || last.restoreTested === false ? 'Last check failed' : !fresh ? 'No recent backup' : last.restoreTested ? 'Restored and checked' : 'Checked',
      detail: { lastAt: last?.at ?? null, restoreTested: last?.restoreTested ?? null, count: st.backups.length } });
  }

  const { queuedHandoffs } = await import('./bridge/handoff-queue.js');
  const { cliConfigDir } = await import('../services/instance-identity.js');
  const queued = queuedHandoffs(cliConfigDir());
  rows.push({ id: 'coding_apps', state: queued > 0 ? 'needs_you' : 'ok', word: queued > 0 ? `${queued} handoff${queued === 1 ? '' : 's'} waiting` : 'Up to date', detail: { queuedHandoffs: queued } });

  const doctor = await sql().read(one<{ at: string; detail: string | null }>("SELECT at, detail FROM memory_health_events WHERE owner_id = ? AND kind = 'doctor' ORDER BY at DESC LIMIT 1", ownerId)).catch(() => undefined);
  // The doctor's counts per kind (doctor.ts); any issue means something to tidy (the owner confirms fixes).
  const found = doctor?.detail ? JSON.parse(doctor.detail) as Record<string, number> : null;
  const issues = found ? Object.values(found).reduce((a, b) => a + Number(b || 0), 0) : 0;
  rows.push({ id: 'background', state: issues > 0 ? 'needs_you' : 'ok', word: issues > 0 ? `${issues} to tidy` : 'Idle', detail: { doctorAt: doctor?.at ?? null, doctor: found } });

  // MODELS-01-INSTALL: the memory helper (runtime + embedding model), while GIRRU_MEMORY_HELPER is on.
  const { memoryHelperEnabled } = await import('../services/memory-helper-switch.js');
  if (memoryHelperEnabled()) {
    const { memoryHelperRow } = await import('./helper.js');
    rows.push(memoryHelperRow());
  }

  return { checkedAt: now.toISOString(), rows };
}

/** The support file: versions, counts, ids and timings; never memory text, names or keys. */
export async function supportBundle(ownerId: string, now: Date = new Date()): Promise<Record<string, unknown>> {
  const health = await memoryHealth(ownerId, now);
  const events = await sql().read(all<{ kind: string; ref: string | null; at: string }>(
    "SELECT kind, ref, at FROM memory_health_events WHERE owner_id = ? AND kind <> 'notice' ORDER BY at DESC LIMIT 200", ownerId)).catch(() => []);
  const drawers = await sql().read(all<{ kind: string; n: number }>(
    "SELECT COALESCE(drawer_kind, 'owner') AS kind, COUNT(*) AS n FROM memories WHERE user_id = ? GROUP BY 1 ORDER BY 1", ownerId)).catch(() => []);
  const { dbDriver } = await import('../db/pg/config.js');
  const migration = await sql().read(one<{ id: string }>('SELECT MAX(id) AS id FROM migrations')).catch(() => undefined);
  return {
    kind: 'girru-support-bundle', version: 1, createdAt: now.toISOString(),
    app: { version: process.env.GIRRU_APP_VERSION ?? null, node: process.version, platform: process.platform, arch: process.arch, osRelease: os.release() },
    database: { driver: dbDriver(), migration: migration?.id ?? null },
    switches: Object.fromEntries(Object.keys(process.env).filter((k) => /^GIRRU_STORE_[A-Z0-9]+$/.test(k)).sort().map((k) => [k, process.env[k] === '1'])),
    memory: { byKind: Object.fromEntries(drawers.map((d) => [d.kind, Number(d.n)])) },
    health,
    events: events.map((e) => ({ kind: e.kind, ref: e.ref, at: e.at })),
  };
}
