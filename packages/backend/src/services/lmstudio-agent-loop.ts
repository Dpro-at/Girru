/**
 * Agent loop for LM Studio (CHAT-PRO-02 G): the same turn as the Ollama loop
 * (services/ollama-agent-loop.ts) over LM Studio's OpenAI-compatible API.
 *
 * One call per step to `<url>/chat/completions` with `stream: true`; the
 * server-sent `data:` lines carry deltas: `content` (answer text),
 * `reasoning_content` / `reasoning` (thinking) and `tool_calls` (pieces of
 * each call, joined by their `index`; arguments arrive as JSON text). The
 * client gets the same typed frames as the Ollama loop, so the chat shows an
 * LM Studio turn exactly like a local Ollama one.
 *
 * Tool security stays in the tools registry; this loop only calls `execute`.
 * A refused or unreachable server throws ModelUnavailable (no upstream text).
 */

import { stallGuard, type StallGuard } from './model-stall.js';
import { currentChatRun } from './chat-run-context.js';
import {
  LOCAL_MAX_STEPS, TOOL_INPUT_CHARS, TOOL_OUTPUT_CHARS, TOOL_OUTPUT_MODEL_CHARS,
  ModelUnavailable, runStepCalls, stepTools, toOllamaTools,
  type ApiTool, type LoopFrame,
} from './ollama-agent-loop.js';
import type { ToolResult } from '../tools/types.js';
import { planCalls } from '../tools/on-demand.js';

export interface CompatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface LmStudioLoopOptions {
  /** OpenAI-compatible base, e.g. http://127.0.0.1:1234/v1 */
  url: string;
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string; images?: { type: string; data: string }[] }[];
  tools: ApiTool[];
  execute: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  write: (frame: LoopFrame) => void;
  signal: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  maxSteps?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** CHAT-BUILD-01: how long the model may send nothing (first piece / between pieces). */
  stallMs?: { first?: number; idle?: number };
  /** STORE-MAP-01 P2b (tools on demand): the tools to send, asked again before every step. */
  toolSet?: { definitions(): ApiTool[] };
  /** STORE-MAP-01 P2b (weak tool calling): at most this many calls of one reply run, one after another. */
  callCap?: number;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… ${s.length - n} more characters` : s);

class Aborted extends Error {}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { input: v };
  } catch {
    return { input: raw };
  }
}

/** Run one turn; resolves like runOllamaAgentLoop. */
export async function runLmStudioAgentLoop(o: LmStudioLoopOptions): Promise<{ steps: number; answer: string; aborted: boolean }> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const maxSteps = o.maxSteps ?? LOCAL_MAX_STEPS;
  // CHAT-GAPS-01: a message with images becomes text plus data-URL image parts (OpenAI-compatible).
  const messages: CompatMessage[] = o.messages.map((m) => ({ role: m.role, content: m.images?.length ? [{ type: 'text' as const, text: m.content }, ...m.images.map((i) => ({ type: 'image_url' as const, image_url: { url: `data:${i.type};base64,${i.data}` } }))] : m.content }));
  const tools = o.tools.length ? toOllamaTools(o.tools) : undefined;
  let step = 0;
  let answer = '';
  let callSeq = 0;
  try {
    while (true) {
      if (o.signal.aborted) throw new Aborted();
      step++;
      // CHAT-BUILD-01 stage 5 (Steer now): the owner's messages sent while it works go in before this step.
      for (const text of currentChatRun()?.takeSteers?.() ?? []) messages.push({ role: 'user', content: text });
      const { content, calls: asked } = await streamOne();
      if (!asked.length) { answer = content; break; }
      const calls = o.callCap ? planCalls(asked, o.callCap).run : asked;
      messages.push({ role: 'assistant', content, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) });
      o.write({ type: 'tool_start', step, tools: calls.map((c) => ({ id: c.id, name: c.name, input: clip(JSON.stringify(c.args), TOOL_INPUT_CHARS) })) });
      const { results, skippedNote } = await runStepCalls(asked, o.execute, now, o.callCap);
      if (o.signal.aborted) throw new Aborted();
      o.write({ type: 'tool_result', step, results: results.map((r) => ({ id: r.id, name: r.name, output: clip(r.text, TOOL_OUTPUT_CHARS), isError: r.isError, ms: r.ms })) });
      for (const [i, r] of results.entries()) messages.push({ role: 'tool', tool_call_id: r.id, content: clip(r.text, TOOL_OUTPUT_MODEL_CHARS) + (skippedNote && i === results.length - 1 ? `\n\n${skippedNote}` : '') });
      if (step >= maxSteps) {
        const note = `\n\nI used ${maxSteps} steps on this task. Tell me to continue and I will pick up from here.`;
        o.write({ type: 'text', content: note });
        answer = note.trim();
        break;
      }
    }
  } catch (err) {
    if (err instanceof Aborted || o.signal.aborted) return { steps: step, answer, aborted: true };
    throw err;
  }
  o.write({ type: 'done', done: true, steps: step });
  return { steps: step, answer, aborted: false };

  /** One streamed model call; returns its text and the finished tool calls. */
  async function streamOne() {
    const guard = stallGuard(o.signal, o.stallMs);
    try { return await readOne(guard); }
    catch (err) {
      if (guard.stalled && !o.signal.aborted) { o.write({ type: 'notice', code: 'local_model_slow' }); throw new ModelUnavailable(504); }
      throw err;
    } finally { guard.done(); }
  }

  async function readOne(guard: StallGuard) {
    let res: Response;
    try {
      res = await fetchImpl(`${o.url}/chat/completions`, {
        method: 'POST',
        signal: guard.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: o.model, messages, stream: true,
          ...(o.toolSet ? ((t) => (t ? { tools: t } : {}))(stepTools(o.toolSet)) : tools ? { tools } : {}),
          ...(o.temperature === undefined ? {} : { temperature: o.temperature }),
          ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
        }),
      });
    } catch (err) {
      if (o.signal.aborted) throw new Aborted();
      throw new ModelUnavailable(0);
    }
    if (!res.ok || !res.body) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      throw new ModelUnavailable(res.status);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    // Tool calls arrive in pieces, keyed by their index in the message.
    const pending = new Map<number, { name: string; args: string }>();
    const line = (raw: string) => {
      const t = raw.trim();
      if (!t.startsWith('data:')) return;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let json: any;
      try { json = JSON.parse(payload); } catch { return; }
      if (json.error) throw new ModelUnavailable(500);
      const d = json.choices?.[0]?.delta ?? {};
      const thinking = typeof d.reasoning_content === 'string' ? d.reasoning_content : typeof d.reasoning === 'string' ? d.reasoning : '';
      if (thinking) o.write({ type: 'reasoning', content: thinking });
      if (typeof d.content === 'string' && d.content) { content += d.content; o.write({ type: 'text', content: d.content }); }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const index = Number.isInteger(tc?.index) ? tc.index : pending.size;
          const cur = pending.get(index) ?? { name: '', args: '' };
          if (typeof tc?.function?.name === 'string') cur.name += tc.function.name;
          if (typeof tc?.function?.arguments === 'string') cur.args += tc.function.arguments;
          pending.set(index, cur);
        }
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      guard.tick();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach(line);
    }
    line(buffer + decoder.decode());
    const calls = [...pending.entries()].sort((a, b) => a[0] - b[0])
      .filter(([, c]) => c.name)
      .map(([, c]) => ({ id: `call-${++callSeq}`, name: c.name, args: parseArgs(c.args) }));
    return { content, calls };
  }
}
