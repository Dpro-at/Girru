/** Provider-independent tool-step execution. The injected executor retains authorization. */
import type { ToolResult } from '../../tools/types.js';
import { planCalls, SKIPPED_NOTE } from '../../tools/on-demand.js';
import { wrapUntrusted, makeNonce } from '../security/data-envelope.js';

/**
 * SEC-ENVELOPE-01: frame a tool result's text as untrusted data before it
 * reaches the model. Tool output is the single boundary through which every
 * untrusted source enters the conversation — fetched web pages (browser tools),
 * imported memory and documents (memory tools), and another agent's reply
 * (multi-agent tools) all come back as tool results. On by default; a no-op
 * when the envelope is turned off. Our own trailing notes stay outside the frame.
 */
export function frameToolResultForModel(text: string, toolName?: string): string {
  return wrapUntrusted(text, { source: toolName });
}

/**
 * SEC-ENVELOPE-01: frame the text blocks of a provider tool_result (Claude's
 * agentic loop keeps image blocks, so the content is an array of blocks). Every
 * text block of one tool result shares a single per-message nonce; non-text
 * blocks (images) pass through untouched. A no-op when the envelope is off.
 */
export function frameResultBlocksForModel<B extends { type?: string; text?: string }>(
  blocks: readonly B[], toolName?: string,
): B[] {
  const nonce = makeNonce();
  return blocks.map((b) =>
    b && b.type === 'text' ? { ...b, text: wrapUntrusted(b.text ?? '', { source: toolName, nonce }) } : b,
  );
}

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
