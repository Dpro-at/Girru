export type RunNoteKind = 'chat' | 'task' | 'delegation';
/** One handoff (D25): who wrote it through which app, when, from which chat, and its fields. */
export type TaskHandoff = {
  id: string; agentId: string; agentName: string; app: string | null;
  /** D26: the agent who handed the task over (a handoff between agents mid-task). */
  fromAgentId: string | null; fromAgentName: string | null; at: string;
  done: string[]; left: string[]; next: string[]; blockers: string[]; files: string[]; questions: string[];
  cardId: string | null; taskNo: string | null; conversationId: string | null; conversationTitle: string | null;
};
export type TaskLinks = {
  taskNo: string | null; notesPlace: { place: string; count: number } | null;
  /** Newest first. */
  handoffs: TaskHandoff[];
  chats: Array<{ id: string; title: string; at: string }>;
  taskFile: { path: '.girru/tasks.md' | '.girru/tasks-done.md'; line: number | null } | null;
  blocked: boolean;
};
export type RunNotes = { notes: Array<{ seq: number; text: string; at: string }>; clearsAt: string | null };
export const RUN_NOTE_KINDS: readonly RunNoteKind[];
export const MAX_BLOCKERS: 8;
export const MAX_LINE: 300;
export const RUN_NOTES_DAYS: 14;
export const TASK_FILE: '.girru/tasks.md';
export const DONE_FILE: '.girru/tasks-done.md';
export function taskLinksPath(boardId: string, cardId: string): string;
export function handoffPath(id: string): string;
export function runNotesPath(runId: string, kind: RunNoteKind): string;
export function taskLinksPathOf(path: string): { route: 'handoff'; id: string } | { route: 'run-notes'; id: string; kind: RunNoteKind } | null;
export function taskLinksRoute(path: string): boolean;
export function validBlockers(x: unknown): x is string[];
export function allowedTaskLinks(method: string, path: string, body?: unknown): boolean;
export function handoffOf(h: unknown): TaskHandoff | null;
export function taskLinksResponse(body: unknown): TaskLinks;
export function taskLinksPathResponse(path: string, status: number, body: unknown): unknown;
