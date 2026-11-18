/**
 * AGENT-BTW-01: the independent SideQuestion service.
 *
 * Answers a `/btw` question off an immutable context snapshot with a single
 * provider request. It is independent by construction:
 *  - It creates no agent session and executes no tools.
 *  - It never writes the main chat transcript, run tables or budget; it writes
 *    only its own side-question tables and (for a paid call) the shared
 *    interactive-usage ledger, exactly like owner chat.
 *  - It keeps its own history (recent Q&A verbatim + a rolling summary) under
 *    its own context budget, computed from the snapshot's model window.
 *  - It has its own cancellation context and a 120 s timeout, allows one
 *    running request per parent session, and a small global cap.
 *
 * SSE streaming, stop and clear are driven from the route; this module exposes
 * the run with an `onDelta` callback that reports the cumulative answer.
 */

import { modelCall } from '../../llm/model-call.js';
import { OLLAMA_URL, DEFAULT_OLLAMA_MODEL, ollamaThinkOption } from '../../llm/ollama.js';
import { providerIsLocal } from '../../memory/stays-local.js';
import { localModelOnly } from '../../agent/execution/chat-turn.js';
import { getSnapshot } from './snapshot.js';
import { assemblePrompt, sideBudget, type ProviderMessage } from './budget.js';
import { decideSideRouting } from './policy.js';
import {
  ensureSession, foldOlderIntoSummary, finishRequest, hasRunning, insertRunning,
  recentQa, resetHistory, runningCount, setAnswer, setHistoryLocality,
} from './store.js';

export const SIDE_QUESTION_TIMEOUT_MS = 120_000;
export const GLOBAL_RUNNING_CAP = 4;
export const MAX_QUESTION_CHARS = 4000;

export class SideQuestionError extends Error {
  constructor(message: string, readonly code: string, readonly status = 400) { super(message); }
}

/** A provider the side service drives. Must honour `signal` and report the cumulative answer. */
export interface SideProvider {
  run(
    input: { system: string; messages: ProviderMessage[]; provider: string; model: string; apiKey?: string; temperature?: number; maxOutputTokens: number; signal: AbortSignal },
    onDelta: (cumulative: string) => void,
  ): Promise<{ text: string; provider: string; model: string }>;
}

/**
 * The default provider. A local Ollama model streams token by token; a paid
 * Claude model is a single (non-streaming) call through the shared choke point
 * `modelCall` (interactive, so it never touches the main run's budget). Any
 * other provider falls back to the local model.
 */
export const defaultSideProvider: SideProvider = {
  async run(input, onDelta) {
    if (input.provider === 'claude' && input.apiKey) {
      const r = await modelCall({ interactive: true }, {
        purpose: 'side_question',
        prompt: '',
        messages: input.messages,
        system: input.system,
        paid: { provider: 'claude', model: input.model, apiKey: input.apiKey },
        maxOutputTokens: input.maxOutputTokens,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        timeoutMs: SIDE_QUESTION_TIMEOUT_MS,
      });
      if (!r.ok) throw new SideQuestionError(r.error || 'provider error', 'provider_error', 502);
      onDelta(r.text);
      return { text: r.text, provider: r.provider, model: r.model };
    }
    // Local Ollama streaming (no paid provider, no budget gate).
    const model = input.provider === 'ollama' && input.model && !/^(claude-|lmstudio:|openai-local:)/.test(input.model)
      ? input.model : DEFAULT_OLLAMA_MODEL;
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: input.system }, ...input.messages],
        stream: true,
        ...ollamaThinkOption(),
        ...(input.temperature !== undefined ? { options: { temperature: input.temperature } } : {}),
      }),
      signal: input.signal,
    });
    if (!res.ok || !res.body) throw new SideQuestionError(`local model HTTP ${res.status}`, 'provider_error', 502);
    let text = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const chunk = JSON.parse(trimmed) as { message?: { content?: string }; done?: boolean };
          const delta = chunk.message?.content;
          if (delta) { text += delta; onDelta(text); }
        } catch { /* a partial line; the next read completes it */ }
      }
    }
    return { text, provider: 'ollama', model };
  },
};

/** One running request per parent session, keyed by side-session id, so stop can cancel it. */
const running = new Map<string, AbortController>();

export function isRunning(sideSessionId: string): boolean {
  return running.has(sideSessionId);
}

/** Stop a running request for an owner's parent session. Returns true if one was cancelled. */
export async function stopSideQuestion(ownerId: string, parentSessionId: string): Promise<boolean> {
  const session = await ensureSession(ownerId, parentSessionId);
  const controller = running.get(session.id);
  if (!controller) return false;
  controller.abort(new SideQuestionError('stopped by user', 'cancelled', 499));
  return true;
}

export interface AskInput {
  ownerId: string;
  parentSessionId: string;
  question: string;
  /** Injected for tests; defaults to the real provider. */
  provider?: SideProvider;
  /** Throttle for answer persistence (ms); 0 persists every delta (tests). */
  persistEveryMs?: number;
}

export interface AskEvents {
  onDelta?: (cumulative: string) => void;
  onStatus?: (status: string) => void;
}

export interface AskResult {
  requestId: string;
  status: 'done' | 'cancelled' | 'error';
  answer: string;
  provider: string;
  model: string;
}

/**
 * Run one side question off the current snapshot for the parent session.
 * Enforces the caps, streams the cumulative answer through `events.onDelta`,
 * and persists the (possibly partial) answer so a crash leaves it recoverable.
 */
export async function askSideQuestion(input: AskInput, events: AskEvents = {}): Promise<AskResult> {
  const question = (input.question ?? '').trim();
  if (!question) throw new SideQuestionError('A question is required', 'empty_question', 400);
  if (question.length > MAX_QUESTION_CHARS) throw new SideQuestionError('Question is too long', 'question_too_long', 400);

  const snapshot = getSnapshot(input.ownerId, input.parentSessionId);
  if (!snapshot) throw new SideQuestionError('No agent context is available for this session yet', 'no_snapshot', 409);

  const session = await ensureSession(input.ownerId, input.parentSessionId);
  if (running.has(session.id) || await hasRunning(session.id)) {
    throw new SideQuestionError('A side question is already running for this session', 'session_busy', 409);
  }
  if (running.size >= GLOBAL_RUNNING_CAP || await runningCount() >= GLOBAL_RUNNING_CAP) {
    throw new SideQuestionError('Too many side questions are running; try again shortly', 'global_cap', 429);
  }

  // P9 privacy: route the same way the main turn would, and never let
  // local-sourced history ride a cloud request. `providerIsLocal` /
  // `localModelOnly` are the main turn's own signals (not a new policy).
  const decision = decideSideRouting({
    localOnly: localModelOnly(),
    snapshotProviderLocal: providerIsLocal(snapshot.provider, snapshot.model),
    hasApiKey: !!snapshot.apiKey,
    historyExists: session.history_local !== null,
    historyLocal: session.history_local === null ? null : session.history_local === 1,
  });
  // Effective provider for this request: a local-only stage forces the local
  // model and drops the API key; a cloud request never carries the key of a
  // local snapshot (there is none) and vice versa.
  const effProvider = decision.forceLocalProvider ? 'ollama' : snapshot.provider;
  const effModel = decision.forceLocalProvider ? DEFAULT_OLLAMA_MODEL : snapshot.model;
  const effApiKey = decision.useApiKey ? snapshot.apiKey : undefined;

  // Drop cross-locality history so it cannot leak into this request.
  let summary = session.summary;
  let recent = await recentQa(session.id);
  if (decision.dropHistory) { await resetHistory(session.id); summary = ''; recent = []; }

  const budget = sideBudget({ window: snapshot.window });
  const assembled = assemblePrompt({
    systemPrompt: snapshot.systemPrompt,
    context: snapshot.messages,
    summary,
    recent,
    question,
    budget,
  });

  const requestId = await insertRunning({
    sideSessionId: session.id, ownerId: input.ownerId, question,
    provider: effProvider, model: effModel, sourceLocal: decision.providerLocal,
  });
  await setHistoryLocality(session.id, decision.providerLocal);

  const controller = new AbortController();
  running.set(session.id, controller);
  const timeout = setTimeout(() => controller.abort(new SideQuestionError('timed out', 'timeout', 504)), SIDE_QUESTION_TIMEOUT_MS);
  if (typeof (timeout as any).unref === 'function') (timeout as any).unref();

  const provider = input.provider ?? defaultSideProvider;
  const persistEveryMs = input.persistEveryMs ?? 400;
  let answer = '';
  let lastPersist = 0;
  const onDelta = (cumulative: string) => {
    answer = cumulative;
    events.onDelta?.(cumulative);
    const now = Date.now();
    if (now - lastPersist >= persistEveryMs) { lastPersist = now; void setAnswer(requestId, answer).catch(() => {}); }
  };

  events.onStatus?.('running');
  try {
    const result = await provider.run({
      system: assembled.system,
      messages: assembled.messages,
      provider: effProvider,
      model: effModel,
      ...(effApiKey ? { apiKey: effApiKey } : {}),
      ...(snapshot.temperature !== undefined ? { temperature: snapshot.temperature } : {}),
      maxOutputTokens: budget.outputCap,
      signal: controller.signal,
    }, onDelta);
    answer = result.text || answer;
    await finishRequest(requestId, 'done', { answer });
    await foldOlderIntoSummary({ ...session, summary, summarized_through: decision.dropHistory ? 0 : session.summarized_through, history_local: decision.providerLocal ? 1 : 0 });
    events.onStatus?.('done');
    return { requestId, status: 'done', answer, provider: result.provider, model: result.model };
  } catch (err) {
    const aborted = controller.signal.aborted;
    const cause = (controller.signal as any).reason;
    const cancelled = aborted && cause instanceof SideQuestionError && cause.code === 'cancelled';
    const status: 'cancelled' | 'error' = cancelled ? 'cancelled' : 'error';
    const message = err instanceof Error ? err.message : 'side question failed';
    await finishRequest(requestId, status, { answer, error: cancelled ? 'stopped by user' : message });
    events.onStatus?.(status);
    if (!aborted && !(err instanceof SideQuestionError)) {
      // A real provider failure propagates to the route for a typed SSE error.
      return { requestId, status: 'error', answer, provider: effProvider, model: effModel };
    }
    return { requestId, status, answer, provider: effProvider, model: effModel };
  } finally {
    clearTimeout(timeout);
    running.delete(session.id);
  }
}
