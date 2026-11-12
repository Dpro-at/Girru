/**
 * Ask an agent, inside the shared editor (MEM-READ-01 MR5).
 *
 * The owner gives one line; the chosen agent answers with its own model
 * (subscription CLI, local Ollama or the Claude API, like a team hand-off)
 * with no tools, no memory and nothing saved. The editor shows the proposal
 * as changes the owner accepts or discards; only the owner's Save writes.
 *
 * Hidden keys never leave: the text already carries references, and any key
 * still in clear is swapped for a placeholder before the call and put back
 * after. A key the agent writes in clear becomes a hidden key (lock chip).
 * A place the owner keeps on this computer is never sent to a model off it.
 */

import { one, sql } from '../repositories/sql-steps.js';
import { redactImportText } from './import/redact.js';
import { hideKeysInText } from './hidden-keys.js';
import { parseDrawerId, type DrawerRef } from './drawers.js';

export class AskAgentError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }

export const MAX_REQUEST = 500;
export const MAX_TEXT = 50_000;
const CALL_MS = 120_000;

export function askPrompt(request: string, text: string): string {
  return [
    'You edit one Markdown document for the owner. Change only what the request asks; keep everything else exactly as it is.',
    'Keep every placeholder like [SECRET:…], [REDACTED:…] or [KEEP:n] exactly as written: they stand for hidden keys you must never see or rebuild.',
    'Answer with the whole new document between <document> and </document>, then one short line starting with "Note:" that says what you changed.',
    '',
    `Request: ${request}`,
    '',
    '<document>',
    text,
    '</document>',
  ].join('\n');
}

/** The new document and the note from a model's answer; null when it did not follow the shape. */
export function parseAnswer(answer: string): { text: string; note: string } | null {
  const m = /<document>\n?([\s\S]*?)\n?<\/document>/.exec(answer);
  if (!m) return null;
  const note = /(?:^|\n)\s*Note:\s*(.+)/.exec(answer.slice(m.index + m[0].length))?.[1]?.trim() ?? '';
  return { text: m[1], note: note.slice(0, 300) };
}

type Target = { id: string; name: string; model: string | null; provider: string | null; temperature: number | null; max_tokens: number | null };

/** One quick, tool-free answer with the agent's own model. `call` is replaceable for tests. */
export async function agentAnswer(target: Target, prompt: string, signal: AbortSignal): Promise<string> {
  const { subscriptionModel, runSubscription, chatWorkspace } = await import('../services/subscription-chat.js');
  const model = target.model || process.env.DEFAULT_MODEL || '';
  if (subscriptionModel(model)) return runSubscription(model, await chatWorkspace(`ask-agent-${target.id}`.replace(/[^A-Za-z0-9_.:-]/g, '-')), prompt, signal, { appToolsOnly: true, agentId: null });
  if (target.provider === 'ollama' || target.provider === 'local' || !target.provider) {
    const { ollamaToolChat } = await import('../llm/ollama-tool-chat.js');
    const { resolveLocalModel } = await import('../llm/local-models.js');
    const result = await ollamaToolChat({ model: await resolveLocalModel(model), messages: [{ role: 'user', content: prompt }], tools: [], temperature: target.temperature ?? 0.2, maxTokens: Math.min(target.max_tokens || 4096, 8192), timeoutMs: CALL_MS, signal });
    return result.content;
  }
  if (target.provider === 'claude') {
    const { resolveProviderApiKey } = await import('../credentials/authority.js');
    const { modelCall } = await import('../llm/model-call.js');
    const apiKey = await resolveProviderApiKey('claude', { agentId: target.id, noGlobal: true });
    if (!apiKey) throw new AskAgentError(409, 'model_unavailable', 'This agent has no model it can use now.');
    const result = await modelCall({ actor: target.id, interactive: true }, { purpose: 'task_run', prompt, maxOutputTokens: Math.min(target.max_tokens || 4096, 8192), timeoutMs: CALL_MS, noLocal: true, paid: { provider: 'claude', model, apiKey } });
    if (!result.ok || result.provider !== 'claude') throw new AskAgentError(502, 'model_unavailable', 'The agent could not answer. Try again.');
    return result.text;
  }
  throw new AskAgentError(409, 'model_unavailable', 'This agent’s model cannot edit documents here yet.');
}

export interface AskInput { agentId: unknown; request: unknown; text: unknown; drawer?: unknown }

export async function askAgentToEdit(ownerId: string, input: AskInput, deps: { answer?: typeof agentAnswer; signal?: AbortSignal } = {}): Promise<{ text: string; note: string; agentId: string }> {
  if (typeof input.agentId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.agentId)) throw new AskAgentError(400, 'invalid_agent', 'Choose an agent');
  if (typeof input.request !== 'string' || !input.request.trim() || input.request.length > MAX_REQUEST) throw new AskAgentError(400, 'invalid_request', `Say what should change in up to ${MAX_REQUEST} characters`);
  if (typeof input.text !== 'string' || input.text.length > MAX_TEXT) throw new AskAgentError(400, 'invalid_text', 'The document is too long');
  const target = await sql().read(one<Target>('SELECT id, name, model, provider, temperature, max_tokens FROM agents_config WHERE id = ?', input.agentId));
  if (!target) throw new AskAgentError(404, 'not_found', 'Agent not found');

  // A place kept on this computer never goes to a model off it.
  if (typeof input.drawer === 'string' && input.drawer) {
    let drawer: DrawerRef | null = null; try { drawer = parseDrawerId(input.drawer); } catch { drawer = null; }
    if (drawer) {
      const { cloudSafeDrawers, providerIsLocal } = await import('./stays-local.js');
      const { subscriptionModel } = await import('../services/subscription-chat.js');
      const local = !subscriptionModel(target.model ?? '') && providerIsLocal(target.provider, target.model);
      if (!local && (await cloudSafeDrawers(ownerId, [drawer])).withheld.length) throw new AskAgentError(409, 'stays_local', 'This place stays on this computer; ask an agent that uses a local model.');
    }
  }

  // Keys still in clear never leave: placeholders out, values back in.
  const kept: string[] = [];
  const safe = redactImportText(input.text, { onSecret: (_t, value) => `[KEEP:${kept.push(value) - 1}]` }).text;
  const signal = deps.signal ?? AbortSignal.timeout(CALL_MS + 10_000);
  const answer = await (deps.answer ?? agentAnswer)(target, askPrompt(input.request.trim(), safe), signal).catch((e) => {
    if (e instanceof AskAgentError) throw e;
    throw new AskAgentError(502, 'model_unavailable', 'The agent could not answer. Try again.');
  });
  const parsed = parseAnswer(String(answer ?? ''));
  if (!parsed) throw new AskAgentError(502, 'bad_answer', 'The agent did not answer with a document. Ask again.');
  let text = parsed.text.replace(/\[KEEP:(\d+)\]/g, (m, i) => kept[Number(i)] ?? m);
  // A key the agent writes in clear is hidden at once (it shows as a lock chip).
  text = (await hideKeysInText(ownerId, text, 'memory').catch(() => ({ text: redactImportText(text).text }))).text;
  return { text: text.slice(0, MAX_TEXT), note: redactImportText(parsed.note).text, agentId: target.id };
}
