/**
 * AGENT-BTW-01: persistence for the side-question channel.
 *
 * Only the side-question history is stored here (sessions + requests). The
 * context snapshot itself is in memory (services/side-question/snapshot.ts) and
 * is never written to the database. Nothing here reads or writes the main chat
 * transcript, run tables or budget.
 */

import { randomUUID } from 'node:crypto';
import { all, one, run, sql } from '../../repositories/sql-steps.js';
import type { SideQa } from './budget.js';

export type SideRequestStatus = 'running' | 'done' | 'interrupted' | 'cancelled' | 'error';

export interface SideRequestRow {
  id: string;
  side_session_id: string;
  owner_id: string;
  question: string;
  answer: string;
  status: SideRequestStatus;
  provider: string;
  model: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SideSessionRow {
  id: string;
  owner_id: string;
  parent_session_id: string;
  summary: string;
  summarized_through: number;
  /** Locality the stored history was produced under: 1 local, 0 cloud, null none. */
  history_local: number | null;
}

/** Verbatim window size: how many of the newest done Q&A are replayed in full. */
export const RECENT_WINDOW = 20;

/** Find or create the side-question session for an owner's parent session. */
export async function ensureSession(ownerId: string, parentSessionId: string): Promise<SideSessionRow> {
  return sql().tx(function* () {
    const existing = yield* one<SideSessionRow>(
      'SELECT id, owner_id, parent_session_id, summary, summarized_through, history_local FROM side_question_sessions WHERE owner_id = ? AND parent_session_id = ?',
      ownerId, parentSessionId,
    );
    if (existing) return existing;
    const id = randomUUID();
    yield* run(
      'INSERT INTO side_question_sessions (id, owner_id, parent_session_id) VALUES (?, ?, ?)',
      id, ownerId, parentSessionId,
    );
    return { id, owner_id: ownerId, parent_session_id: parentSessionId, summary: '', summarized_through: 0, history_local: null };
  });
}

/** Record the locality the stored history is now being produced under. */
export async function setHistoryLocality(sideSessionId: string, local: boolean): Promise<void> {
  await sql().read(run(
    'UPDATE side_question_sessions SET history_local = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    local ? 1 : 0, sideSessionId,
  ));
}

/**
 * Drop the side history when the provider locality changes, so local-sourced
 * Q&A/summary can never ride a cloud request. Keeps the session row.
 */
export async function resetHistory(sideSessionId: string): Promise<void> {
  await sql().tx(function* () {
    yield* run('DELETE FROM side_question_requests WHERE side_session_id = ?', sideSessionId);
    yield* run('UPDATE side_question_sessions SET summary = \'\', summarized_through = 0, history_local = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?', sideSessionId);
  });
}

/** Insert a new request in `running` state and return its id. */
export async function insertRunning(input: {
  sideSessionId: string; ownerId: string; question: string; provider: string; model: string; sourceLocal: boolean;
}): Promise<string> {
  const id = randomUUID();
  // `ord` is the next insertion index for this side session (one running
  // request per session is enforced, so this subquery cannot race itself).
  await sql().read(run(
    `INSERT INTO side_question_requests (id, side_session_id, owner_id, question, status, provider, model, source_local, ord)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?, (SELECT COALESCE(MAX(ord), 0) + 1 FROM side_question_requests WHERE side_session_id = ?))`,
    id, input.sideSessionId, input.ownerId, input.question, input.provider, input.model, input.sourceLocal ? 1 : 0, input.sideSessionId,
  ));
  return id;
}

/** Overwrite the cumulative (possibly partial) answer of a running request. */
export async function setAnswer(id: string, answer: string): Promise<void> {
  await sql().read(run(
    'UPDATE side_question_requests SET answer = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = \'running\'',
    answer, id,
  ));
}

/** Move a request to a terminal state, keeping whatever answer it has. */
export async function finishRequest(id: string, status: Exclude<SideRequestStatus, 'running'>, opts: { answer?: string; error?: string } = {}): Promise<void> {
  if (opts.answer !== undefined) {
    await sql().read(run(
      'UPDATE side_question_requests SET status = ?, answer = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      status, opts.answer, opts.error ?? null, id,
    ));
  } else {
    await sql().read(run(
      'UPDATE side_question_requests SET status = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      status, opts.error ?? null, id,
    ));
  }
}

export async function getRequest(id: string): Promise<SideRequestRow | undefined> {
  return sql().read(one<SideRequestRow>('SELECT * FROM side_question_requests WHERE id = ?', id));
}

/** All requests of a side session, oldest first. */
export async function listRequests(sideSessionId: string): Promise<SideRequestRow[]> {
  return sql().read(all<SideRequestRow>(
    'SELECT * FROM side_question_requests WHERE side_session_id = ? ORDER BY ord',
    sideSessionId,
  ));
}

/** The newest `RECENT_WINDOW` completed Q&A for replay, oldest first. */
export async function recentQa(sideSessionId: string): Promise<SideQa[]> {
  const rows = await sql().read(all<{ question: string; answer: string }>(
    'SELECT question, answer FROM side_question_requests WHERE side_session_id = ? AND status = \'done\' ORDER BY ord',
    sideSessionId,
  ));
  return rows.slice(-RECENT_WINDOW).map((r) => ({ question: r.question, answer: r.answer }));
}

/** Count of this owner's requests still marked `running` (for the concurrency caps). */
export async function runningCount(ownerId?: string): Promise<number> {
  const row = ownerId
    ? await sql().read(one<{ n: number }>('SELECT COUNT(*) AS n FROM side_question_requests WHERE status = \'running\' AND owner_id = ?', ownerId))
    : await sql().read(one<{ n: number }>('SELECT COUNT(*) AS n FROM side_question_requests WHERE status = \'running\''));
  return Number(row?.n ?? 0);
}

/** True if this side session already has a running request. */
export async function hasRunning(sideSessionId: string): Promise<boolean> {
  const row = await sql().read(one<{ n: number }>(
    'SELECT COUNT(*) AS n FROM side_question_requests WHERE side_session_id = ? AND status = \'running\'',
    sideSessionId,
  ));
  return Number(row?.n ?? 0) > 0;
}

/**
 * Fold the oldest done Q&A beyond the recent window into the rolling summary.
 * Own-code condensation (no model): appends a short `Q -> A` line per folded
 * item and advances `summarized_through`.
 */
export async function foldOlderIntoSummary(session: SideSessionRow): Promise<void> {
  const done = await sql().read(all<{ question: string; answer: string }>(
    'SELECT question, answer FROM side_question_requests WHERE side_session_id = ? AND status = \'done\' ORDER BY ord',
    session.id,
  ));
  const foldUpTo = Math.max(0, done.length - RECENT_WINDOW);
  if (foldUpTo <= session.summarized_through) return;
  const condense = (s: string, max: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max)}…` : t; };
  const added = done.slice(session.summarized_through, foldUpTo)
    .map((qa) => `- ${condense(qa.question, 120)} → ${condense(qa.answer, 200)}`)
    .join('\n');
  const summary = (session.summary ? `${session.summary}\n${added}` : added);
  await sql().read(run(
    'UPDATE side_question_sessions SET summary = ?, summarized_through = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    summary, foldUpTo, session.id,
  ));
}

/** Clear a side session's history: delete its requests and reset the summary. */
export async function clearSession(ownerId: string, parentSessionId: string): Promise<boolean> {
  return sql().tx(function* () {
    const session = yield* one<{ id: string }>(
      'SELECT id FROM side_question_sessions WHERE owner_id = ? AND parent_session_id = ?',
      ownerId, parentSessionId,
    );
    if (!session) return false;
    yield* run('DELETE FROM side_question_requests WHERE side_session_id = ?', session.id);
    yield* run('UPDATE side_question_sessions SET summary = \'\', summarized_through = 0, history_local = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?', session.id);
    return true;
  });
}

/**
 * On restart, a leftover `running` request cannot still be in flight: mark it
 * `interrupted`, keeping its partial answer. Returns how many were changed.
 */
export async function interruptLeftovers(): Promise<number> {
  const res = await sql().read(run(
    'UPDATE side_question_requests SET status = \'interrupted\', error = \'interrupted by restart\', updated_at = CURRENT_TIMESTAMP WHERE status = \'running\'',
  ));
  return res.changes;
}
