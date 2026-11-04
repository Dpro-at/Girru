/**
 * The memory helper and the chat model share the computer (STORE-MAP-01 P2b,
 * LAT; GIRRU_STORE_P2B).
 *
 * One local model server answers both the owner's replies and Girru's
 * background memory work (extraction, summaries, the memory worker,
 * re-embedding after the helper installs). Rules:
 *
 *  - A reply never waits for background work. While a local reply runs,
 *    background model calls wait in one queue, one at a time, and start when
 *    no reply is running (or after `maxWaitMs`, so nothing waits forever).
 *  - The chat model stays warm: a background call on the chat model sends the
 *    chat's keep_alive, so it never shortens the time the model (and its
 *    prompt cache) stays loaded; a call on another model (the memory worker)
 *    is unloaded soon after the queue is empty (`HELPER_KEEP_ALIVE`).
 *  - Embedding the question in a reply is not background work: it is fast and
 *    part of the reply (LAT rule 1), so it is never queued.
 *
 * Off (P2b off), `backgroundSlot` returns at once and nothing changes.
 */

import { storeP2bEnabled } from '../services/store-p2b.js';

/** How long a background job waits for replies to finish before it runs anyway. */
export const BACKGROUND_MAX_WAIT_MS = 120_000;
/** keep_alive for a model only background work uses: unloaded soon after the queue is empty. */
export const HELPER_KEEP_ALIVE = '2m';

let replies = 0;
let lastChatModel: string | null = null;
let idleWaiters: Array<() => void> = [];
let queue: Promise<void> = Promise.resolve();
let waiting = 0;
const stats = { queued: 0, waitedMs: 0, ranDuringReply: 0 };

/** A local reply starts; call the returned function when it ends (exactly once). */
export function beginLocalReply(model?: string): () => void {
  replies++;
  if (model) lastChatModel = model;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    replies = Math.max(0, replies - 1);
    if (replies === 0) { const w = idleWaiters; idleWaiters = []; for (const f of w) f(); }
  };
}

export const localRepliesRunning = (): number => replies;
/** The model the newest local reply used (kept warm by background calls on it). */
export const chatModelInUse = (): string | null => lastChatModel;

function idle(maxWaitMs: number): Promise<boolean> {
  if (replies === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => { idleWaiters = idleWaiters.filter((f) => f !== done); resolve(false); }, maxWaitMs);
    t.unref?.();
    const done = () => { clearTimeout(t); resolve(true); };
    idleWaiters.push(done);
  });
}

/**
 * Wait for a turn of the background queue: one background job at a time, and
 * only while no local reply runs. Returns a release function (call it when the
 * job's model call ended).
 */
export async function backgroundSlot(opts: { maxWaitMs?: number } = {}): Promise<() => void> {
  if (!storeP2bEnabled()) return () => {};
  const started = Date.now();
  stats.queued++;
  waiting++;
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const prev = queue;
  queue = prev.then(() => mine);
  await prev;
  const freed = await idle(opts.maxWaitMs ?? BACKGROUND_MAX_WAIT_MS);
  waiting--;
  stats.waitedMs += Date.now() - started;
  if (!freed) stats.ranDuringReply++;
  let done = false;
  return () => { if (!done) { done = true; release(); } };
}

/** Run `fn` in a background slot. */
export async function inBackgroundSlot<T>(fn: () => Promise<T>, opts: { maxWaitMs?: number } = {}): Promise<T> {
  const release = await backgroundSlot(opts);
  try { return await fn(); } finally { release(); }
}

/** keep_alive for a background call: the chat's own value on the chat model, a short one on any other. */
export function backgroundKeepAlive(model: string, chatModel: string, chatKeepAlive: string | number): string | number {
  return model === chatModel ? chatKeepAlive : HELPER_KEEP_ALIVE;
}

export function schedulerStats(): { replies: number; waiting: number; queued: number; waitedMs: number; ranDuringReply: number } {
  return { replies, waiting, ...stats };
}

/** Tests only. */
export function resetScheduler(): void {
  replies = 0; lastChatModel = null; idleWaiters = []; queue = Promise.resolve(); waiting = 0;
  stats.queued = 0; stats.waitedMs = 0; stats.ranDuringReply = 0;
}
