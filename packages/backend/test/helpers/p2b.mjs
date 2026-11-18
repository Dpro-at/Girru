import { switchValueOn } from './switches.mjs';
// STORE-MAP-01 P2b: helpers so older tests read the same with GIRRU_STORE_P2B off and on.
// With P2b on, a local model turn sends the memory verbs and tool_load in full and lists the other
// tools by name in the system text ("## Tool index"); a tool is offered when it is in either place.
// A stub model server that does not answer /api/show gives the safe 8k window.
export const p2bOn = () => switchValueOn(String(process.env.GIRRU_STORE_P2B ?? '').trim());

/** Tool names listed in a system text's tool index. */
export function indexNames(system) {
  const m = /## Tool index\n[^\n]*\n((?:- [^\n]*(?:\n|$))*)/.exec(String(system ?? ''));
  if (!m) return [];
  const also = /^- Also: (.*)$/m.exec(m[1]);
  return [...[...m[1].matchAll(/^- (?!Also: )([^:\n]+):/gm)].map((x) => x[1]), ...(also ? also[1].split(', ') : [])];
}

/** Every tool offered by one model request body (tools sent in full + the tool index). */
export function offeredNames(body) {
  const sent = (body?.tools ?? []).map((t) => t.function?.name ?? t.name);
  const system = (body?.messages ?? []).filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  return [...new Set([...sent, ...indexNames(system)])];
}

/** num_ctx a local turn sends when the stub server reports no window. */
export const expectedNumCtx = (fixed = 32768) => (p2bOn() ? 8192 : fixed);
/** num_predict a local turn sends: the agent's limit, within the 8k window's reply room under P2b. */
export const expectedNumPredict = (limit) => (p2bOn() ? Math.min(limit, 1638) : limit);
