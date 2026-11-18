/** Exact queue consumption must run in the same transaction as durable admission. */
import { one, run, type Step } from './sql-steps.js';
export class QueuedTurnChangedError extends Error {}
export function* consumeQueuedStep(userId: string, sessionId: string, queuedKey: string, message: string): Step<void> {
  const session = yield* one<{ queued: string | null }>('SELECT queued FROM chat_sessions WHERE id=? AND user_id=?', sessionId, userId);
  let queue: { key: string; text: string }[] = [];
  try { queue = JSON.parse(session?.queued ?? '[]'); } catch { /* refuse invalid state below */ }
  if (!Array.isArray(queue) || !queue.some(item => item?.key === queuedKey && item.text === message)) throw new QueuedTurnChangedError('queued_turn_changed');
  const rest = queue.filter(item => item.key !== queuedKey);
  const consumed = yield* run('UPDATE chat_sessions SET queued=? WHERE id=? AND user_id=? AND queued=?', rest.length ? JSON.stringify(rest) : null, sessionId, userId, session!.queued);
  if (consumed.changes !== 1) throw new QueuedTurnChangedError('queued_turn_changed');
}
