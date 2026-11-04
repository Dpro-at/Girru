/**
 * STORE-MAP-01 P8 (D27): a run's working notes.
 *
 * While a chat reply, a board task run or a delegated part runs, its agent may
 * jot short notes (`run_note`). They stay with the run (run_notes), never
 * become memory by themselves, are read only for the owner, and are cleared 14
 * days after the run's last note (the handoff sweep does it).
 *
 * At the run's end they are distilled WITHOUT a model call, by their first word:
 *   "Done: …"  "Left: …"  "Next: …"  "Blocked: …"  "File: …"   -> the run's handoff,
 *                                     only when the agent wrote none in this run
 *   "Lesson: …"                       -> a lesson suggestion the owner reviews
 *                                     (Needs you, "From a run's working notes")
 * Any other line stays a note. Every note is passed through the import
 * redactor first, so a key or password never lands here.
 */

import { randomUUID } from 'node:crypto';
import { q } from '../../repositories/sql-steps.js';
import { redactImportText } from '../import/redact.js';
import { learn } from '../learning.js';
import type { DrawerRef } from '../drawers.js';
import { MAX_FILES, MAX_ITEMS, MAX_ITEM_CHARS, saveHandoff, type HandoffBody, type HandoffLinks, type HandoffScope } from './store.js';

export const RUN_KINDS = ['chat', 'task', 'delegation'] as const;
export type RunKind = (typeof RUN_KINDS)[number];
/** Notes per run and characters per note. */
export const MAX_RUN_NOTES = 100;
export const MAX_NOTE_CHARS = 500;
/** D27: a run's notes are cleared this long after its last note. */
export const RUN_NOTES_DAYS = 14;
const DAY_MS = 86_400_000;
/** Lessons suggested from one run at most. */
const MAX_LESSONS = 5;

export class RunNoteError extends Error {}

export interface RunRef { ownerId: string; runKind: RunKind; runId: string }

const sqlTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const isoOf = (at: string) => (/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? at : `${at.replace(' ', 'T')}Z`);

/** One note at the end of the run's list; returns its number. */
export async function appendRunNote(ref: RunRef & { agentId: string; cardId?: string | null }, raw: unknown): Promise<number> {
  if (typeof raw !== 'string') throw new RunNoteError('text must be a short note');
  const text = redactImportText(raw.replace(/\s+/g, ' ').trim()).text.slice(0, MAX_NOTE_CHARS).trim();
  if (!text) throw new RunNoteError('the note is empty');
  for (let attempt = 0; attempt < 3; attempt++) {
    const top = await q.one<{ n: number | null; c: number }>('SELECT MAX(seq) AS n, COUNT(*) AS c FROM run_notes WHERE run_kind = ? AND run_id = ? AND owner_id = ?', ref.runKind, ref.runId, ref.ownerId);
    if (Number(top?.c ?? 0) >= MAX_RUN_NOTES) throw new RunNoteError(`this run already has ${MAX_RUN_NOTES} notes`);
    const seq = Number(top?.n ?? 0) + 1;
    const ins = await q.run('INSERT INTO run_notes (id, owner_id, run_id, run_kind, agent_id, card_id, seq, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      randomUUID(), ref.ownerId, ref.runId, ref.runKind, ref.agentId, ref.cardId ?? null, seq, text);
    if (ins.changes) return seq;
  }
  throw new RunNoteError('the note could not be added; try again');
}

/** The run's notes in order and when they are cleared (read only, the owner's own). */
export async function listRunNotes(ref: RunRef): Promise<{ notes: Array<{ seq: number; text: string; at: string }>; clearsAt: string }> {
  const rows = await q.all<{ seq: number; text: string; created_at: string }>('SELECT seq, text, created_at FROM run_notes WHERE owner_id = ? AND run_kind = ? AND run_id = ? ORDER BY seq', ref.ownerId, ref.runKind, ref.runId);
  const last = rows.length ? Math.max(...rows.map((r) => Date.parse(isoOf(r.created_at)) || 0)) : Date.now();
  return { notes: rows.map((r) => ({ seq: Number(r.seq), text: r.text, at: isoOf(r.created_at) })), clearsAt: new Date(last + RUN_NOTES_DAYS * DAY_MS).toISOString() };
}

/** D27: removes the notes of every run whose last note is older than 14 days. Returns how many notes went. */
export async function clearOldRunNotes(now = Date.now()): Promise<number> {
  const before = sqlTime(now - RUN_NOTES_DAYS * DAY_MS);
  const res = await q.run(`DELETE FROM run_notes WHERE (run_kind, run_id) IN (
    SELECT run_kind, run_id FROM run_notes GROUP BY run_kind, run_id HAVING MAX(created_at) < ?)`, before);
  return res.changes;
}

const PARTS: Array<[RegExp, keyof HandoffBody | 'lesson']> = [
  [/^done\s*:\s*/i, 'done'], [/^left\s*:\s*/i, 'left'], [/^next\s*:\s*/i, 'next'], [/^blocked\s*:\s*/i, 'blockers'],
  [/^(?:file|files)\s*:\s*/i, 'files'], [/^question\s*:\s*/i, 'questions'], [/^lesson\s*:\s*/i, 'lesson'],
];

/** Rule-based: the notes' marked lines as handoff parts and lessons (no model). */
export function distillNotes(texts: string[]): { body: HandoffBody; lessons: string[] } {
  const body: HandoffBody = { done: [], left: [], next: [], questions: [], blockers: [], files: [] };
  const lessons: string[] = [];
  for (const t of texts) {
    for (const [re, part] of PARTS) {
      if (!re.test(t)) continue;
      const rest = t.replace(re, '').trim().slice(0, MAX_ITEM_CHARS);
      if (!rest) break;
      if (part === 'lesson') { if (lessons.length < MAX_LESSONS && !lessons.includes(rest)) lessons.push(rest); }
      else if (part === 'files') { for (const f of rest.split(/\s*,\s*/).filter(Boolean)) if (body.files!.length < MAX_FILES && !body.files!.includes(f)) body.files!.push(f); }
      else { const list = body[part]!; if (list.length < MAX_ITEMS && !list.includes(rest)) list.push(rest); }
      break;
    }
  }
  return { body, lessons };
}

/**
 * At the run's end: the notes become the run's handoff (only when the agent
 * wrote none in this run and the notes mark at least one part) and lesson
 * suggestions for the owner. Returns what was made.
 */
export async function distillRun(ref: RunRef, target: { scope: HandoffScope | undefined; links?: HandoffLinks; drawer?: DrawerRef | null; agentId: string }): Promise<{ handoffId: string | null; lessons: number }> {
  const rows = await q.all<{ text: string }>('SELECT text FROM run_notes WHERE owner_id = ? AND run_kind = ? AND run_id = ? ORDER BY seq', ref.ownerId, ref.runKind, ref.runId);
  if (!rows.length) return { handoffId: null, lessons: 0 };
  const { body, lessons } = distillNotes(rows.map((r) => r.text));
  let handoffId: string | null = null;
  const marked = body.done.length + body.left.length + body.next.length + body.questions.length + body.blockers!.length > 0;
  if (marked && target.scope) {
    const wrote = await q.one('SELECT 1 AS x FROM agent_handoffs WHERE owner_id = ? AND agent_id = ? AND run_id = ? LIMIT 1', ref.ownerId, target.scope.agentId, ref.runId);
    if (!wrote) handoffId = (await saveHandoff(target.scope, body, 'agent', ref.runId, target.links ?? {})).id;
  }
  let suggested = 0;
  if (lessons.length) {
    const r = await learn({ userId: ref.ownerId, actor: `agent:${target.agentId}`, agentId: target.agentId, review: true, reviewReason: 'run-notes',
      candidates: lessons.map((content) => ({ content, type: 'insight', importance: 5, origin: 'agent' as const, ...(target.drawer ? { drawer: target.drawer } : {}) })) });
    suggested = r.proposed.length;
  }
  return { handoffId, lessons: suggested };
}
