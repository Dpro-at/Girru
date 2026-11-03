/**
 * Retention rules (CORE-07; MEMORY_VISION "Forgetting rules v1").
 *
 *  1. Important things are never forgotten by retention: the owner, project
 *     and people drawers are never touched.
 *  2. Task drawers: once a task has ended and `taskTtlDays` (default 90) have
 *     passed, its details are replaced by ONE short summary memory in the
 *     experience drawer and the originals are forgotten (memory/forget.ts).
 *     A task has ended when its orchestrator task is completed/failed/
 *     cancelled (completed_at), or, with no such task, at its last activity.
 *     A task that is still pending/running is kept.
 *  3. Experience drawer: items older than `experienceAfterDays` (default 180)
 *     with importance below 8 are consolidated into one summary per type
 *     (at least `experienceMinGroup`, default 3, items); originals forgotten.
 *     Earlier retention summaries are not consolidated again.
 *
 * Explicit, never silent: retention is off until the owner turns it on
 * (PUT /api/memory/retention); the scheduled job does nothing while it is
 * off; every run (job or manual, dry run or not) is stored with counts and
 * audited. A dry run reports what would happen and changes nothing.
 */

import { all, dialect, one, run, sql, tableExists, type Step } from '../repositories/sql-steps.js';
import { nowIsoText } from '../db/pg/dialect.js';
import { orderedId } from '../repositories/ordered-id.js';
import { getMemoryStorage } from './storage.js';
import { DRAWER_KEY_SQL, DRAWER_KIND_SQL, normalizeDrawer, type DrawerRef } from './drawers.js';
import { forgetMemory } from './forget.js';
import { newMemory, saveVersioned } from './learning.js';
import { importanceOf } from './versions.js';
import type { Memory } from './types.js';
import { orchestratorTablesFor } from '../multi-agent/orchestrator.js';
import { storeP9Enabled } from '../services/store-p9.js';
import { PEOPLE_REPLACED_DAYS, stalePeopleFacts } from './person.js';

export interface RetentionConfig {
  enabled: boolean;
  taskTtlDays: number;
  experienceAfterDays: number;
  experienceMinGroup: number;
}

export const DEFAULT_RETENTION: RetentionConfig = { enabled: false, taskTtlDays: 90, experienceAfterDays: 180, experienceMinGroup: 3 };
const DAY = 24 * 60 * 60 * 1000;
const SUMMARY_LINES = 5;
const LINE = 140;

export class RetentionInputError extends Error {}

export function getRetentionConfig(userId: string): Promise<RetentionConfig> {
  return sql().read(retentionConfigStep(userId));
}

function* retentionConfigStep(userId: string): Step<RetentionConfig> {
  const row = yield* one('SELECT * FROM memory_retention_config WHERE user_id = ?', userId);
  if (!row) return { ...DEFAULT_RETENTION };
  return {
    enabled: row.enabled === 1,
    taskTtlDays: row.task_ttl_days,
    experienceAfterDays: row.experience_after_days,
    experienceMinGroup: row.experience_min_group,
  };
}

function intIn(v: unknown, min: number, max: number, name: string): number {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new RetentionInputError(`${name} must be a whole number ${min}-${max}`);
  return v as number;
}

/** Validate and store the owner's retention settings (partial update). */
export function setRetentionConfig(userId: string, input: Record<string, unknown>, actor: string): Promise<RetentionConfig> {
  // Read and write in one transaction: a partial update starts from the stored row.
  return sql().tx(() => setRetentionConfigStep(userId, input, actor));
}

function* setRetentionConfigStep(userId: string, input: Record<string, unknown>, actor: string): Step<RetentionConfig> {
  const d = yield* dialect();
  const cur = yield* retentionConfigStep(userId);
  const next: RetentionConfig = { ...cur };
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new RetentionInputError('enabled must be true or false');
    next.enabled = input.enabled;
  }
  if (input.taskTtlDays !== undefined) next.taskTtlDays = intIn(input.taskTtlDays, 1, 3650, 'taskTtlDays');
  if (input.experienceAfterDays !== undefined) next.experienceAfterDays = intIn(input.experienceAfterDays, 7, 3650, 'experienceAfterDays');
  if (input.experienceMinGroup !== undefined) next.experienceMinGroup = intIn(input.experienceMinGroup, 2, 1000, 'experienceMinGroup');
  yield* run(`
    INSERT INTO memory_retention_config (user_id, enabled, task_ttl_days, experience_after_days, experience_min_group, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ${nowIsoText(d)})
    ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, task_ttl_days = excluded.task_ttl_days,
      experience_after_days = excluded.experience_after_days, experience_min_group = excluded.experience_min_group,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `, userId, next.enabled ? 1 : 0, next.taskTtlDays, next.experienceAfterDays, next.experienceMinGroup, actor);
  return next;
}

function line(m: Memory): string {
  const one = m.content.replace(/\s+/g, ' ').trim();
  return `- ${one.length > LINE ? `${one.slice(0, LINE)}...` : one}`;
}

function summaryText(title: string, items: Memory[]): string {
  const first = items[0].createdAt.toISOString().slice(0, 10);
  const last = items[items.length - 1].createdAt.toISOString().slice(0, 10);
  const shown = [...items].sort((a, b) => importanceOf(b) - importanceOf(a)).slice(0, SUMMARY_LINES).map(line);
  const more = items.length > SUMMARY_LINES ? [`- ... and ${items.length - SUMMARY_LINES} more`] : [];
  return [`${title} (${items.length} items, ${first} to ${last}):`, ...shown, ...more].join('\n');
}

/**
 * When did this task end? null = still running / unknown and active.
 * The orchestrator's task table is read when it is in the main database:
 * on PostgreSQL that is `orchestrator_tasks` (B2.2d-15); on SQLite the
 * orchestrator keeps its own file (.data/multi-agent/orchestrator.db), so
 * `tasks` is usually absent there and the activity fallback decides.
 */
function* taskEnd(userId: string, key: string, items: Memory[]): Step<number | null> {
  const table = orchestratorTablesFor(yield* dialect()).tasks;
  if (yield* tableExists(table)) {
    const t = yield* one<{ status: string; completed_at: string | null }>(`SELECT status, completed_at FROM ${table} WHERE id = ?`, key);
    if (t) {
      if (!['completed', 'failed', 'cancelled'].includes(t.status)) return null;
      const at = t.completed_at ? Date.parse(t.completed_at) : NaN;
      if (Number.isFinite(at)) return at;
    }
  }
  const last = yield* one<{ at: string | null }>(`SELECT MAX(created_at) AS at FROM memory_versions WHERE user_id = ? AND drawer_kind = 'task' AND drawer_key = ?`, userId, key);
  const times = items.map((m) => m.createdAt.getTime());
  if (last?.at) times.push(Date.parse(last.at));
  return times.length ? Math.max(...times) : null;
}

export interface RetentionAction {
  kind: 'task-summary' | 'experience-consolidation';
  drawerId: string;
  /** How many originals are (or would be) forgotten. */
  items: number;
  summaryMemoryId?: string;
}

export interface RetentionResult {
  id: string;
  dryRun: boolean;
  skipped?: 'disabled';
  config: RetentionConfig;
  actions: RetentionAction[];
  forgotten: number;
  /** P9 (PRIV5): replaced facts about people forgotten (or, in a dry run, that would be). */
  people?: { forgotten: number; afterDays: number };
}

const ACTOR = 'retention';

/**
 * Run the retention rules for one user. `requireEnabled` (the scheduled job)
 * does nothing unless the owner turned retention on; a manual owner run works
 * either way. Counts only are stored; no memory text in the run record.
 */
export async function runRetention(userId: string, opts: { now?: Date; dryRun?: boolean; requireEnabled?: boolean; actor?: string } = {}): Promise<RetentionResult> {
  const config = await getRetentionConfig(userId);
  const now = (opts.now ?? new Date()).getTime();
  const dryRun = !!opts.dryRun;
  const actor = opts.actor ?? ACTOR;
  // Time-ordered id: runs listed newest first keep their order on ties of created_at.
  const result: RetentionResult = { id: orderedId(), dryRun, config, actions: [], forgotten: 0 };

  if (opts.requireEnabled && !config.enabled) {
    result.skipped = 'disabled';
  } else {
    const storage = getMemoryStorage();

    // 2. Ended tasks past their TTL.
    const tasks = await sql().read(all<{ key: string }>(`SELECT DISTINCT ${DRAWER_KEY_SQL} AS key FROM memories WHERE user_id = ? AND ${DRAWER_KIND_SQL} = 'task' ORDER BY 1`, userId));
    for (const { key } of tasks) {
      let drawer: DrawerRef;
      try { drawer = normalizeDrawer({ kind: 'task', key }); } catch { continue; }
      const items = await storage.getByDrawers(userId, [drawer]);
      if (items.length === 0) continue;
      const end = await sql().read(taskEnd(userId, key, items));
      if (end === null || end + config.taskTtlDays * DAY > now) continue;
      const action: RetentionAction = { kind: 'task-summary', drawerId: `task:${key}`, items: items.length };
      if (!dryRun) {
        const summary = newMemory(userId, { kind: 'experience' }, {
          type: 'insight', importance: 6, content: summaryText(`Summary of task ${key}`, items),
        }, { source: 'retention', retention: 'task-summary', task: key });
        await saveVersioned(summary, actor, 'retention:task-summary');
        action.summaryMemoryId = summary.id;
        for (const m of items) if (await forgetMemory(userId, m.id, actor)) result.forgotten++;
      }
      result.actions.push(action);
    }

    // 3. Old, not-important experience items -> one summary per type.
    const cutoff = now - config.experienceAfterDays * DAY;
    const old = (await storage.getByDrawers(userId, [{ kind: 'experience' }]))
      .filter((m) => m.createdAt.getTime() < cutoff && importanceOf(m) < 8 && (m.metadata as any)?.source !== 'retention');
    const byType = new Map<string, Memory[]>();
    for (const m of old) byType.set(m.type, [...(byType.get(m.type) || []), m]);
    for (const [type, items] of [...byType.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (items.length < config.experienceMinGroup) continue;
      const action: RetentionAction = { kind: 'experience-consolidation', drawerId: 'experience', items: items.length };
      if (!dryRun) {
        const summary = newMemory(userId, { kind: 'experience' }, {
          type, importance: 6, content: summaryText(`Consolidated ${type} experience`, items),
        }, { source: 'retention', retention: 'experience-consolidation', consolidated: items.length });
        await saveVersioned(summary, actor, 'retention:experience-consolidation');
        action.summaryMemoryId = summary.id;
        for (const m of items) if (await forgetMemory(userId, m.id, actor)) result.forgotten++;
      }
      result.actions.push(action);
    }

    // 4. STORE-MAP-01 P9 (PRIV5): a fact about a person that was replaced long ago is forgotten
    // (the current fact stays; the person's drawer is otherwise never touched).
    if (storeP9Enabled()) {
      const stale = await stalePeopleFacts(userId, new Date(now));
      result.people = { forgotten: stale.length, afterDays: PEOPLE_REPLACED_DAYS };
      if (!dryRun) {
        result.people.forgotten = 0;
        for (const f of stale) if (await forgetMemory(userId, f.id, actor)) { result.people.forgotten++; result.forgotten++; }
      }
    }
  }

  await sql().read(run('INSERT INTO memory_retention_runs (id, user_id, dry_run, actor, result) VALUES (?, ?, ?, ?, ?)',
    result.id, userId, dryRun ? 1 : 0, actor, JSON.stringify({ skipped: result.skipped ?? null, actions: result.actions, forgotten: result.forgotten, ...(result.people ? { people: result.people } : {}), config })));
  return result;
}

export async function listRetentionRuns(userId: string, limit = 20): Promise<any[]> {
  return (await sql().read(all('SELECT id, dry_run, actor, result, created_at FROM memory_retention_runs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    userId, Math.max(1, Math.min(200, limit)))))
    .map((r) => ({ id: r.id, dryRun: r.dry_run === 1, actor: r.actor, createdAt: r.created_at, ...JSON.parse(r.result) }));
}
