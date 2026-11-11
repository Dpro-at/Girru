/**
 * One non-streaming Ollama /api/chat call with tools (MCP-01 small agent).
 *
 * Used by the durable task-run executor for the small local agent. Talks only
 * to OLLAMA_URL (loopback by default, see ollama.ts). Tools are passed in the
 * Ollama/OpenAI "function" format; tool calls come back with their arguments
 * as an object.
 */

import { OLLAMA_URL, ollamaThinkOption } from './ollama.js';

export interface AnthropicStyleTool {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, any> } }>;
  tool_name?: string;
}

export interface OllamaToolChatResult {
  content: string;
  toolCalls: Array<{ id: string; tool: string; arguments: Record<string, any> }>;
  /** The assistant message to append to the conversation. */
  assistant: OllamaMessage;
  model: string;
  /** Token counts reported by Ollama (R2; local models cost 0). */
  usage?: { inputTokens: number; outputTokens: number };
}

export function toOllamaTools(tools: AnthropicStyleTool[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function parseArgs(raw: unknown): Record<string, any> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, any>;
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch { /* not JSON */ }
  }
  return {};
}

export async function ollamaToolChat(opts: {
  model: string;
  systemPrompt?: string;
  messages: OllamaMessage[];
  tools?: AnthropicStyleTool[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** CHAT-BUILD-01: the caller's stop (a stopped chat reaches its delegated agents). */
  signal?: AbortSignal;
  /** STORE-MAP-01 P2b: the model's own window (num_ctx); unset = Ollama's default, as before. */
  numCtx?: number;
  /** GENVR-WORLD-01: false asks a thinking model for a direct answer (unset = the server's OLLAMA_THINK default). */
  think?: boolean;
}): Promise<OllamaToolChatResult> {
  const messages: OllamaMessage[] = opts.systemPrompt
    ? [{ role: 'system', content: opts.systemPrompt }, ...opts.messages]
    : [...opts.messages];
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      messages,
      stream: false,
      ...(opts.think === undefined ? ollamaThinkOption() : { think: opts.think }),
      ...(opts.tools && opts.tools.length > 0 ? { tools: toOllamaTools(opts.tools) } : {}),
      options: {
        ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}),
        ...(opts.numCtx ? { num_ctx: opts.numCtx } : {}),
      },
    }),
    signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 120_000)]) : AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  if (!res.ok) {
    throw new Error(`Ollama request failed (${res.status})`);
  }
  const data: any = await res.json();
  const msg = data?.message ?? {};
  const content = typeof msg.content === 'string' ? msg.content : '';
  const rawCalls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const toolCalls = rawCalls
    .filter((c) => c && c.function && typeof c.function.name === 'string')
    .map((c, i) => ({ id: `call-${i}`, tool: String(c.function.name), arguments: parseArgs(c.function.arguments) }));
  const assistant: OllamaMessage = { role: 'assistant', content };
  if (toolCalls.length > 0) {
    assistant.tool_calls = toolCalls.map((c) => ({ function: { name: c.tool, arguments: c.arguments } }));
  }
  const usage = Number.isFinite(data?.prompt_eval_count) && Number.isFinite(data?.eval_count)
    ? { inputTokens: Number(data.prompt_eval_count), outputTokens: Number(data.eval_count) }
    : undefined;
  return { content, toolCalls, assistant, model: typeof data?.model === 'string' ? data.model : opts.model, ...(usage ? { usage } : {}) };
}
