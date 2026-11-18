// STORE-MAP-01 P8 (boards P8a–P8c): the task number T-n is the link hub of a board
// task. One read gives its task notes place, its handoffs (newest first), its chats and
// its task file; the owner edits a handoff's blockers (files touched stay read only).
// A run's working notes are read only and stay with the run (cleared after 14 days).
// Every route answers 404 while the backend's P8 switch is off; the page then keeps
// today's parts ("not available yet" where a P8 part was asked for).
import { Store, codeOf, ago } from './memory-store';
import type { Requester } from './memory-store';
import { handoffPath, runNotesPath, taskLinksPath, MAX_BLOCKERS, MAX_LINE, RUN_NOTES_DAYS } from './task-links-contract.js';
import type { RunNoteKind, RunNotes, TaskHandoff, TaskLinks } from './task-links-contract.js';

export type LinksState = Readonly<{
  phase: 'idle' | 'loading' | 'ready' | 'missing' | 'error';
  links: TaskLinks | null; busy: boolean; notice?: string; saved?: string;
}>;

/** One line per blocker as the owner types them (empty lines dropped, at most 8 of 300 characters). */
export const blockerLines = (text: string) => text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, MAX_BLOCKERS).map(l => l.slice(0, MAX_LINE));

/** "Omar through Codex"; Girru's own model shows only the agent (board P8a3). */
export function whoWords(h: Pick<TaskHandoff, 'agentName' | 'app'>): string {
  const app = h.app?.trim();
  return app && app.toLowerCase() !== 'girru' && app.toLowerCase() !== h.agentName.toLowerCase() ? `${h.agentName} through ${app}` : h.agentName;
}
/** D26: "Sara handed this to Omar" for a handoff between agents mid-task, else null. */
export function handedWords(h: Pick<TaskHandoff, 'fromAgentId' | 'fromAgentName' | 'agentId' | 'agentName'>): string | null {
  if (!h.fromAgentId || h.fromAgentId === h.agentId) return null;
  return `${h.fromAgentName ?? 'An agent'} handed this to ${h.agentName}`;
}
/** The first line worth showing of an older handoff: "Next: …", "Left: …" or "Done: …". */
export function handoffLine(h: Pick<TaskHandoff, 'done' | 'left' | 'next' | 'blockers'>): string {
  if (h.next.length) return `Next: ${h.next[0]}`;
  if (h.left.length) return `Left: ${h.left[0]}`;
  if (h.blockers.length) return `Blocked: ${h.blockers[0]}`;
  return h.done.length ? `Done: ${h.done[0]}` : '';
}
/** "3 · newest 10 min ago" (the Handoffs row of the Linked group). */
export function countLine(n: number, newest: string | undefined, now = Date.now()): string {
  if (!n) return 'None yet';
  const a = newest ? ago(newest, now) : '';
  return `${n}${a ? ` · newest ${a === 'now' ? 'just now' : /^\d/.test(a) ? `${a} ago` : a}` : ''}`;
}
/** The narrow window folds the group to one line: "T-12 · 3 handoffs · 3 chats". */
export function linksLine(l: TaskLinks): string {
  const n = (k: number, one: string) => `${k} ${k === 1 ? one : `${one}s`}`;
  return [l.taskNo, n(l.handoffs.length, 'handoff'), n(l.chats.length, 'chat')].filter(Boolean).join(' · ');
}
/** Plain-text copy of the links (the group's Copy tool). */
export function linksText(l: TaskLinks, title: string): string {
  return [`${l.taskNo ? `${l.taskNo} ` : ''}${title}`,
    l.notesPlace ? `Task notes: ${l.notesPlace.count}` : '',
    l.handoffs[0] ? `Latest handoff: ${whoWords(l.handoffs[0])}${l.handoffs[0].blockers.length ? ` · Blocked: ${l.handoffs[0].blockers.join('; ')}` : ''}` : '',
    ...l.chats.map(c => `Chat: ${c.title || 'Untitled chat'}`),
    l.taskFile ? `Task file: ${l.taskFile.path}${l.taskFile.line ? `:${l.taskFile.line}` : ''}` : ''].filter(Boolean).join('\n');
}

export class TaskLinksController extends Store<LinksState> {
  #ticket = 0;
  #at: { boardId: string; cardId: string } | null = null;
  constructor(client: Requester) { super({ phase: 'idle', links: null, busy: false }, client); }

  /** Reads the links of one task (404 = the P8 switch is off: "missing"). */
  async load(boardId: string, cardId: string) {
    const t = ++this.#ticket;
    const same = this.#at?.boardId === boardId && this.#at?.cardId === cardId;
    this.#at = { boardId, cardId };
    this.publish({ phase: same && this.getSnapshot().links ? this.getSnapshot().phase : 'loading', ...(same ? {} : { links: null }), notice: undefined });
    try {
      const r = await this.req('GET', taskLinksPath(boardId, cardId));
      if (t !== this.#ticket) return;
      if (r.status === 404) { this.publish({ phase: 'missing', links: null }); return; }
      if (r.status !== 200) { this.publish({ phase: 'error', notice: 'The links of this task could not be read.' }); return; }
      this.publish({ phase: 'ready', links: r.body as TaskLinks });
    } catch { if (t === this.#ticket) this.publish({ phase: 'error', notice: 'The links of this task could not be read (no connection).' }); }
  }
  refresh() { if (this.#at) void this.load(this.#at.boardId, this.#at.cardId); }

  /** D29: the owner edits a handoff's blockers; the card's Blocked mark follows the newest handoff. */
  async saveBlockers(handoffId: string, text: string): Promise<boolean> {
    const blockers = blockerLines(text);
    this.publish({ busy: true, notice: undefined, saved: undefined });
    try {
      const r = await this.req('PATCH', handoffPath(handoffId), { blockers });
      if (r.status !== 200) { this.publish({ busy: false, notice: r.status === 404 ? 'Editing blockers is not available yet.' : codeOf(r) === 'invalid_handoff' || codeOf(r) === 'invalid_request' ? 'Keep each blocker one short line (at most 8).' : 'The blockers were not saved.' }); return false; }
      const h = (r.body as { handoff: TaskHandoff }).handoff;
      const l = this.getSnapshot().links;
      if (l) { const handoffs = l.handoffs.map(x => (x.id === h.id ? h : x)); this.publish({ links: { ...l, handoffs, blocked: (handoffs[0]?.blockers.length ?? 0) > 0 } }); }
      this.publish({ busy: false, saved: blockers.length ? 'Blockers saved.' : 'Blockers cleared.' });
      return true;
    } catch { this.publish({ busy: false, notice: 'The blockers were not saved (no connection).' }); return false; }
  }
}

// ---------------------------------------------------------------------------
// A run's working notes (P8c, D27)
// ---------------------------------------------------------------------------

/** Which notes a run in Runs keeps, by its id: chat replies, agent tasks and hand-offs to another agent. */
export function runNotesRef(run: { id: string }): { id: string; kind: RunNoteKind } | null {
  const m = /^(chat|task|handoff):(.+)$/.exec(run.id);
  if (!m) return null;
  return { id: m[2], kind: m[1] === 'handoff' ? 'delegation' : m[1] as RunNoteKind };
}
/** "cleared in 14 days" (or fewer once the run has ended). */
export function clearsWords(clearsAt: string | null, now = Date.now()): string {
  const t = clearsAt ? Date.parse(clearsAt) : NaN;
  if (!Number.isFinite(t)) return `cleared ${RUN_NOTES_DAYS} days after the run ends`;
  const days = Math.max(0, Math.ceil((t - now) / 86_400_000));
  return days === 0 ? 'cleared today' : days === 1 ? 'cleared tomorrow' : `cleared in ${days} days`;
}
/** "12:02" for a note's time (the run's own day). */
export const noteTime = (at: string) => { const d = new Date(at.length === 19 ? `${at}Z` : at); return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 5); };

export type RunNotesState = { phase: 'loading' | 'ready' | 'missing' | 'error'; data: RunNotes | null };
/** Reads a run's working notes once (404 = not available yet). */
export async function readRunNotes(client: Requester, ref: { id: string; kind: RunNoteKind }): Promise<RunNotesState> {
  try {
    const r = await client.request({ method: 'GET', path: runNotesPath(ref.id, ref.kind) } as never);
    if (r.status === 200) return { phase: 'ready', data: r.body as RunNotes };
    return { phase: r.status === 404 ? 'missing' : 'error', data: null };
  } catch { return { phase: 'error', data: null }; }
}
