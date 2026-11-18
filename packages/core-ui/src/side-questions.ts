/**
 * AGENT-BTW-01: the `/btw` side-question channel — client logic.
 *
 * Framework-agnostic and transport-agnostic, so the chat composer and the
 * history drawer can use it without pulling in React or a specific HTTP
 * client. The parts that touch the network take a `fetch`-like function, so
 * the app passes its authenticated transport in and tests pass a stub.
 *
 * A side question is asked off an immutable snapshot of the current agent's
 * context; it never changes the main run. See the backend service for the
 * guarantees. This module only parses the command and folds the SSE frames
 * into a small cumulative view model.
 */

/** The result of looking at a composer line for a `/btw` command. */
export type BtwCommand =
  | { kind: 'btw'; question: string }
  | { kind: 'btw-empty' } // `/btw` with no question yet (show a hint, do not send)
  | { kind: 'none' };

/**
 * Recognise a `/btw <question>` line. Leading spaces are allowed; the command
 * is case-insensitive. `/btweet hello` is NOT a side question (word boundary).
 */
export function parseBtwCommand(line: string): BtwCommand {
  const text = (line ?? '').replace(/^\s+/, '');
  const m = /^\/btw(\b|$)([\s\S]*)$/i.exec(text);
  if (!m) return { kind: 'none' };
  const question = (m[2] ?? '').trim();
  return question ? { kind: 'btw', question } : { kind: 'btw-empty' };
}

/** A parsed SSE frame from POST /api/chat/btw. */
export interface SideFrame {
  type?: 'started' | 'delta' | 'done' | 'cancelled' | 'interrupted' | 'error';
  content?: string;
  requestId?: string;
  provider?: string;
  model?: string;
  code?: string;
  error?: string;
}

export type SidePhase = 'idle' | 'running' | 'done' | 'cancelled' | 'error';

/** The cumulative view model for one in-flight / finished side question. */
export interface SideView {
  phase: SidePhase;
  answer: string;
  requestId?: string;
  provider?: string;
  model?: string;
  error?: string;
}

export const initialSideView: SideView = Object.freeze({ phase: 'idle', answer: '' });

/**
 * Fold one SSE frame into the view model. `delta` frames carry only the new
 * tail of the answer (the backend sends tails to keep frames small), so they
 * are appended.
 */
export function applySideFrame(view: SideView, frame: SideFrame): SideView {
  switch (frame.type) {
    case 'started':
      return { ...view, phase: 'running', requestId: frame.requestId ?? view.requestId };
    case 'delta':
      return { ...view, phase: 'running', answer: view.answer + (frame.content ?? '') };
    case 'done':
      return { ...view, phase: 'done', requestId: frame.requestId ?? view.requestId, provider: frame.provider, model: frame.model };
    case 'cancelled':
      return { ...view, phase: 'cancelled', requestId: frame.requestId ?? view.requestId };
    case 'interrupted':
      return { ...view, phase: 'error', error: 'interrupted' };
    case 'error':
      return { ...view, phase: 'error', error: frame.error ?? 'Side question failed' };
    default:
      return view;
  }
}

/** Split a raw SSE buffer into complete `data:` frame objects, returning the leftover. */
export function drainSseFrames(buffer: string): { frames: SideFrame[]; rest: string } {
  const frames: SideFrame[] = [];
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  for (const part of parts) {
    const line = part.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue; // heartbeats (": ping") and blanks are skipped
    try { frames.push(JSON.parse(line.slice(5).trim()) as SideFrame); } catch { /* ignore a malformed frame */ }
  }
  return { frames, rest };
}

type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; body: unknown }>;

export interface SideHistoryItem {
  id: string; question: string; answer: string; status: string;
  provider: string; model: string; error: string | null; createdAt: string;
}
export interface SideHistory {
  parentSessionId: string; hasSnapshot: boolean; summary: string; requests: SideHistoryItem[];
}

/**
 * Stream a side question. `transport` must perform a POST to /api/chat/btw with
 * the app's auth and call `onChunk` with each decoded SSE text chunk. This
 * keeps auth and the concrete streaming reader in the app; the reducer above
 * turns chunks into a view model.
 */
export async function streamSideQuestion(
  transport: (path: string, body: unknown, onChunk: (text: string) => void, signal?: AbortSignal) => Promise<void>,
  parentSessionId: string,
  question: string,
  onView: (view: SideView) => void,
  signal?: AbortSignal,
): Promise<SideView> {
  let view: SideView = { ...initialSideView, phase: 'running' };
  onView(view);
  let buffer = '';
  await transport('/api/chat/btw', { parentSessionId, question }, (text) => {
    buffer += text;
    const { frames, rest } = drainSseFrames(buffer);
    buffer = rest;
    for (const frame of frames) { view = applySideFrame(view, frame); onView(view); }
  }, signal);
  return view;
}

export async function loadSideHistory(call: FetchLike, parentSessionId: string): Promise<SideHistory | null> {
  const r = await call(`/api/chat/btw?parentSessionId=${encodeURIComponent(parentSessionId)}`, { method: 'GET' });
  return r.ok && r.body && typeof r.body === 'object' ? (r.body as SideHistory) : null;
}

export async function stopSideQuestion(call: FetchLike, parentSessionId: string): Promise<boolean> {
  const r = await call('/api/chat/btw/stop', { method: 'POST', body: { parentSessionId } });
  return r.ok;
}

export async function clearSideQuestions(call: FetchLike, parentSessionId: string): Promise<boolean> {
  const r = await call('/api/chat/btw/clear', { method: 'POST', body: { parentSessionId } });
  return r.ok;
}
