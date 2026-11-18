import { assertNoDefaultMemoryAccess } from '../encryption/execution-context.js';
/**
 * Lessons store (MEM-RSI-01): the evidence-gated lesson tables, their
 * admission rule, idempotent evidence and the reversible support count that
 * retires and restores a lesson.
 *
 * Plain SQLite / PostgreSQL tables (migration 206), per user, like memory
 * itself. Nothing here calls a model or the network; it is deterministic.
 *
 * Invariants kept in one transaction on every change:
 *   - a lesson row never exists without at least one evidence row (admission);
 *   - support = number of its CONFIRMED evidence rows;
 *   - status = 'active' while support > 0, else 'retired' (the row and its
 *     reversed evidence stay, so a later confirmation restores it);
 *   - when a lesson's last evidence row is removed, the lesson row is deleted.
 */

import { v4 as uuidv4 } from 'uuid';
import { all, dialect, one, run, sql, tableExists, type Step } from '../../repositories/sql-steps.js';
import { nowIsoText } from '../../db/pg/dialect.js';
import {
  cleanAction,
  isReasonCode,
  normalizeCue,
  type Disposition,
  type Lesson,
  type LessonDraft,
  type Polarity,
  type ReasonCode,
  type RsiMode,
} from './types.js';

let tablesReady: boolean | null = null;

/** True when migration 206 ran (older test databases may lack it). */
export async function rsiTablesExist(): Promise<boolean> {
  if (tablesReady === null) tablesReady = await sql().read(tableExists('rsi_lessons'));
  return tablesReady;
}

/** Test-only: forget the cached table check (a fresh throwaway DB per test). */
export function resetRsiTableCache(): void {
  tablesReady = null;
}

interface LessonRow {
  id: string; user_id: string; cue: string; action: string; polarity: Polarity;
  reason_code: string | null;
  support: number; status: 'active' | 'retired'; created_at: string; updated_at: string;
}

function toLesson(r: LessonRow): Lesson {
  return {
    id: r.id, userId: r.user_id, cue: r.cue, action: r.action, polarity: r.polarity,
    reasonCode: isReasonCode(r.reason_code) ? r.reason_code : '',
    support: Number(r.support) || 0, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/**
 * Recompute one lesson's support and status from its evidence, in the current
 * transaction. Deletes the lesson when it has no evidence left at all (the
 * admission rule), retires it when no evidence confirms it, restores it
 * otherwise.
 */
function* recomputeLessonStep(userId: string, lessonId: string): Step<{ support: number; status: 'active' | 'retired' | 'deleted' }> {
  const d = yield* dialect();
  const total = (yield* one<{ n: number }>('SELECT COUNT(*) AS n FROM rsi_lesson_evidence WHERE lesson_id = ? AND user_id = ?', lessonId, userId))?.n ?? 0;
  if (Number(total) === 0) {
    yield* run('DELETE FROM rsi_lessons WHERE id = ? AND user_id = ?', lessonId, userId);
    return { support: 0, status: 'deleted' };
  }
  const support = (yield* one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM rsi_lesson_evidence WHERE lesson_id = ? AND user_id = ? AND disposition = 'confirmed'", lessonId, userId))?.n ?? 0;
  const status = Number(support) > 0 ? 'active' : 'retired';
  yield* run(`UPDATE rsi_lessons SET support = ?, status = ?, updated_at = ${nowIsoText(d)} WHERE id = ? AND user_id = ?`,
    Number(support), status, lessonId, userId);
  return { support: Number(support), status };
}

export interface RecordResult {
  lessonId: string;
  /** False when the (lesson, source) evidence row already held this disposition. */
  changed: boolean;
  support: number;
  status: 'active' | 'retired' | 'deleted';
}

/**
 * Record one piece of evidence for the lesson a draft describes, creating the
 * lesson if needed (admission: the lesson and its first evidence row are born
 * together). Idempotent per (lesson, source_kind, source_id): a second call
 * for the same source updates that one row's disposition instead of adding a
 * new one, so re-running extraction can never inflate support.
 */
export async function recordEvidence(userId: string, draft: LessonDraft): Promise<RecordResult | null> {
  assertNoDefaultMemoryAccess();
  if (!(await rsiTablesExist())) return null;
  const cue = normalizeCue(draft.cue);
  const action = cleanAction(draft.action);
  const sourceId = String(draft.sourceId || '');
  const sourceKind = String(draft.sourceKind || '');
  // Admission rule, enforced before anything is written: no cue, action or
  // source means no lesson.
  if (!cue || !action || !sourceId || !sourceKind) return null;
  return sql().tx(function* () {
    const d = yield* dialect();
    let lesson = yield* one<{ id: string }>(
      'SELECT id FROM rsi_lessons WHERE user_id = ? AND cue = ? AND action = ? AND polarity = ?',
      userId, cue, action, draft.polarity);
    if (!lesson) {
      const id = uuidv4();
      const reasonCode: ReasonCode | null = isReasonCode(draft.reasonCode) ? draft.reasonCode : null;
      yield* run('INSERT INTO rsi_lessons (id, user_id, cue, action, polarity, reason_code, support, status) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
        id, userId, cue, action, draft.polarity, reasonCode, draft.disposition === 'confirmed' ? 'active' : 'retired');
      lesson = { id };
    }
    const existing = yield* one<{ id: string; disposition: Disposition }>(
      'SELECT id, disposition FROM rsi_lesson_evidence WHERE lesson_id = ? AND source_kind = ? AND source_id = ?',
      lesson.id, sourceKind, sourceId);
    let changed: boolean;
    if (!existing) {
      yield* run('INSERT INTO rsi_lesson_evidence (id, lesson_id, user_id, source_kind, source_id, disposition) VALUES (?, ?, ?, ?, ?, ?)',
        uuidv4(), lesson.id, userId, sourceKind, sourceId, draft.disposition);
      changed = true;
    } else if (existing.disposition !== draft.disposition) {
      yield* run(`UPDATE rsi_lesson_evidence SET disposition = ?, updated_at = ${nowIsoText(d)} WHERE id = ? AND user_id = ?`,
        draft.disposition, existing.id, userId);
      changed = true;
    } else {
      changed = false;
    }
    const r = yield* recomputeLessonStep(userId, lesson.id);
    return { lessonId: lesson.id, changed, support: r.support, status: r.status };
  });
}

/**
 * Flip the disposition of every evidence row a source contributed (e.g. a
 * finding confirmed earlier turns out to be a false positive). Each affected
 * lesson is recomputed, so it retires when its support reaches zero and is
 * restored when it climbs back. Returns the lessons touched.
 */
export async function setSourceDisposition(userId: string, sourceKind: string, sourceId: string, disposition: Disposition): Promise<string[]> {
  assertNoDefaultMemoryAccess();
  if (!(await rsiTablesExist())) return [];
  return sql().tx(function* () {
    const d = yield* dialect();
    const rows = yield* all<{ lesson_id: string }>(
      'SELECT DISTINCT lesson_id FROM rsi_lesson_evidence WHERE user_id = ? AND source_kind = ? AND source_id = ?',
      userId, sourceKind, sourceId);
    if (!rows.length) return [];
    yield* run(`UPDATE rsi_lesson_evidence SET disposition = ?, updated_at = ${nowIsoText(d)}
       WHERE user_id = ? AND source_kind = ? AND source_id = ?`, disposition, userId, sourceKind, sourceId);
    for (const r of rows) yield* recomputeLessonStep(userId, r.lesson_id);
    return rows.map((r) => r.lesson_id);
  });
}

/**
 * Remove every evidence row a source contributed and recompute each lesson it
 * touched; a lesson left with no evidence at all is deleted (admission rule).
 */
export async function forgetSource(userId: string, sourceKind: string, sourceId: string): Promise<string[]> {
  assertNoDefaultMemoryAccess();
  if (!(await rsiTablesExist())) return [];
  return sql().tx(function* () {
    const rows = yield* all<{ lesson_id: string }>(
      'SELECT DISTINCT lesson_id FROM rsi_lesson_evidence WHERE user_id = ? AND source_kind = ? AND source_id = ?',
      userId, sourceKind, sourceId);
    if (!rows.length) return [];
    yield* run('DELETE FROM rsi_lesson_evidence WHERE user_id = ? AND source_kind = ? AND source_id = ?', userId, sourceKind, sourceId);
    for (const r of rows) yield* recomputeLessonStep(userId, r.lesson_id);
    return rows.map((r) => r.lesson_id);
  });
}

/** One lesson by id, or null (owner-scoped). */
export async function getLesson(userId: string, lessonId: string): Promise<Lesson | null> {
  if (!(await rsiTablesExist())) return null;
  const row = await sql().read(one<LessonRow>('SELECT * FROM rsi_lessons WHERE id = ? AND user_id = ?', lessonId, userId));
  return row ? toLesson(row) : null;
}

export interface ListLessonsOptions {
  status?: 'active' | 'retired' | 'all';
  polarity?: Polarity;
  limit?: number;
}

/** The user's lessons, newest first. Active only unless asked otherwise. */
export async function listLessons(userId: string, opts: ListLessonsOptions = {}): Promise<Lesson[]> {
  if (!(await rsiTablesExist())) return [];
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const clauses = ['user_id = ?'];
  const params: (string | number)[] = [userId];
  if (opts.status && opts.status !== 'all') { clauses.push('status = ?'); params.push(opts.status); }
  else if (!opts.status) { clauses.push("status = 'active'"); }
  if (opts.polarity) { clauses.push('polarity = ?'); params.push(opts.polarity); }
  const rows = await sql().read(all<LessonRow>(
    `SELECT * FROM rsi_lessons WHERE ${clauses.join(' AND ')} ORDER BY support DESC, updated_at DESC, id LIMIT ?`,
    ...params, limit));
  return rows.map(toLesson);
}

export interface EvidenceRow {
  id: string; sourceKind: string; sourceId: string; disposition: Disposition; createdAt: string; updatedAt: string;
}

/** The evidence rows of one lesson (owner-scoped). */
export async function listEvidence(userId: string, lessonId: string): Promise<EvidenceRow[]> {
  if (!(await rsiTablesExist())) return [];
  const rows = await sql().read(all<{ id: string; source_kind: string; source_id: string; disposition: Disposition; created_at: string; updated_at: string }>(
    'SELECT id, source_kind, source_id, disposition, created_at, updated_at FROM rsi_lesson_evidence WHERE lesson_id = ? AND user_id = ? ORDER BY created_at, id',
    lessonId, userId));
  return rows.map((r) => ({ id: r.id, sourceKind: r.source_kind, sourceId: r.source_id, disposition: r.disposition, createdAt: r.created_at, updatedAt: r.updated_at }));
}

/** Record that a lesson was selected for a prompt (shadow or inject mode). */
export async function logUsage(userId: string, lessonId: string, mode: Exclude<RsiMode, 'off'>, context: string): Promise<void> {
  if (!(await rsiTablesExist())) return;
  await sql().read(run('INSERT INTO rsi_lesson_usage (id, lesson_id, user_id, mode, context) VALUES (?, ?, ?, ?, ?)',
    uuidv4(), lessonId, userId, mode, context.slice(0, MAX_USAGE_CONTEXT)));
}

const MAX_USAGE_CONTEXT = 300;

/** How many times a lesson was selected (for the owner's read view). */
export async function usageCount(userId: string, lessonId: string): Promise<number> {
  if (!(await rsiTablesExist())) return 0;
  const row = await sql().read(one<{ n: number }>('SELECT COUNT(*) AS n FROM rsi_lesson_usage WHERE lesson_id = ? AND user_id = ?', lessonId, userId));
  return Number(row?.n) || 0;
}
