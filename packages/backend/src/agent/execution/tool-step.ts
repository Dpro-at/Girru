/** Provider-independent tool-step execution. The injected executor retains authorization. */
import type { ToolResult } from '../../tools/types.js';
import { planCalls, SKIPPED_NOTE } from '../../tools/on-demand.js';

export async function runStepCalls<C extends { id: string; name: string; args: Record<string, unknown> }>(
  calls: readonly C[], execute: (name: string, args: Record<string, unknown>) => Promise<ToolResult>, now: () => number, cap?: number,
): Promise<{ run: C[]; results: (C & { text: string; isError: boolean; ms: number })[]; skippedNote: string | null }> {
  const one = async (c: C) => {
    const started = now();
    let out: { text: string; isError: boolean };
    try { out = toolResultText(await execute(c.name, c.args)); }
    catch (err) { out = { text: `Error: ${err instanceof Error ? err.message : 'tool failed'}`, isError: true }; }
    return { ...c, ...out, ms: Math.max(0, now() - started) };
  };
  if (!cap) return { run: [...calls], results: await Promise.all(calls.map(one)), skippedNote: null };
  const plan = planCalls(calls, cap);
  const results: (C & { text: string; isError: boolean; ms: number })[] = [];
  for (const c of plan.run) results.push(await one(c));
  return { run: plan.run, results, skippedNote: plan.skipped.length ? SKIPPED_NOTE(plan.skipped.length) : null };
}

/** Text of a tool result for the client and the model; images become a short note. */
export function toolResultText(result: ToolResult): { text: string; isError: boolean } {
  const parts = (result.content ?? []).map((b) => (b.type === 'text' ? b.text ?? '' : '[image]'));
  const text = parts.join('\n').trim() || (result.error ? `Error: ${result.error}` : '(no output)');
  return { text, isError: !!result.error || /^Error:/.test(text) };
}
