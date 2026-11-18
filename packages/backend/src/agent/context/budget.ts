/**
 * STORE-MAP-01 P2 (SUB3): token budgets for prompt parts, counted with the
 * same estimate as the rest of the chat budget (memory/context/budget.ts).
 */
import { estimateTokens } from '../../memory/context/budget.js';

/** Memory sent with a coding-app reply (pinned facts, handoff, memory pack). */
export const CODING_APP_MEMORY_TOKENS = 1_500;

/** `text` cut in the middle to at most `tokens` (estimated); whole when it fits. */
export function capTokens(text: string, tokens: number): string {
  if (estimateTokens(text) <= tokens) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const half = Math.floor(mid / 2);
    if (estimateTokens(`${text.slice(0, half)}\n[… shortened …]\n${text.slice(text.length - half)}`) <= tokens) lo = mid; else hi = mid - 1;
  }
  const half = Math.floor(lo / 2);
  return `${text.slice(0, half)}\n[… shortened …]\n${text.slice(text.length - half)}`;
}
