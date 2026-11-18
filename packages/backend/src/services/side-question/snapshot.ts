/**
 * AGENT-BTW-01: immutable context snapshot for the side-question channel.
 *
 * While a main agent (a chat or a running task) assembles a request, the chat
 * turn publishes a deep, frozen, structured copy of that request here, keyed by
 * the parent session id. A `/btw` question is then answered off this snapshot
 * without ever touching the main run's loop, transcript, tools or budget.
 *
 * Rules kept here:
 *  - The snapshot is an immutable deep copy: callers cannot mutate what they
 *    publish afterwards, and readers cannot mutate what they read.
 *  - A snapshot is published only at a safe boundary (request start / reply
 *    complete) when the context is whole — never a half-generated reply, and
 *    tool calls stay paired with their results.
 *  - The snapshot lives only in memory (per owner). It is never written to a
 *    database, so no prompt text or API key is persisted. On restart it is
 *    simply gone, and a new `/btw` waits for the main agent's next request.
 */

/** A message in a captured context. `content` is plain text (vision parts are flattened upstream). */
export interface SnapshotMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  /**
   * Pairing marker so a budget cut never splits a tool call from its result:
   * the assistant message that made a tool call and the following tool result
   * share the same `pairId`. Plain chat turns leave it undefined.
   */
  readonly pairId?: string;
}

export interface ContextSnapshot {
  readonly ownerId: string;
  readonly parentSessionId: string;
  /** When this context was captured (ms epoch). */
  readonly capturedAt: number;
  /** Which safe boundary produced it, for diagnostics only. */
  readonly boundary: 'request_start' | 'reply_complete';
  readonly systemPrompt: string;
  readonly messages: ReadonlyArray<SnapshotMessage>;
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number;
  /** The model's context window in tokens, when the main turn knew it. */
  readonly window?: number;
  /**
   * The paid-provider API key for this context, if any. In-memory only, never
   * persisted or logged. Used by the side service to reach the same model.
   */
  readonly apiKey?: string;
}

export interface CaptureInput {
  ownerId: string;
  parentSessionId: string;
  boundary?: 'request_start' | 'reply_complete';
  systemPrompt: string;
  messages: ReadonlyArray<{ role: string; content: unknown; pairId?: string }>;
  provider: string;
  model: string;
  temperature?: number;
  window?: number;
  apiKey?: string;
}

/** owner id -> (parent session id -> snapshot). Keeps one owner's contexts apart from another's. */
const store = new Map<string, Map<string, ContextSnapshot>>();

/** Hard cap on messages kept in a snapshot, so one huge context cannot pin memory. */
const MAX_SNAPSHOT_MESSAGES = 400;

function toText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p === 'object' && (p as any).type === 'text' && typeof (p as any).text === 'string')
      .map((p) => (p as any).text as string)
      .join('\n');
  }
  return '';
}

function coerceRole(role: string): SnapshotMessage['role'] {
  return role === 'system' || role === 'assistant' || role === 'tool' ? role : 'user';
}

/**
 * Publish an immutable copy of a main agent's request context for a parent
 * session. The returned snapshot (and everything reachable from it) is frozen,
 * so later mutation of the caller's arrays never leaks in.
 */
export function captureMainContext(input: CaptureInput): ContextSnapshot {
  const trimmed = input.messages.slice(-MAX_SNAPSHOT_MESSAGES);
  const messages: SnapshotMessage[] = trimmed.map((m) =>
    Object.freeze({
      role: coerceRole(String(m.role)),
      content: toText(m.content),
      ...(m.pairId ? { pairId: String(m.pairId) } : {}),
    } as SnapshotMessage),
  );
  const snapshot: ContextSnapshot = Object.freeze({
    ownerId: input.ownerId,
    parentSessionId: input.parentSessionId,
    capturedAt: Date.now(),
    boundary: input.boundary ?? 'request_start',
    systemPrompt: String(input.systemPrompt ?? ''),
    messages: Object.freeze(messages) as ReadonlyArray<SnapshotMessage>,
    provider: String(input.provider ?? ''),
    model: String(input.model ?? ''),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.window !== undefined ? { window: input.window } : {}),
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
  });
  let perOwner = store.get(input.ownerId);
  if (!perOwner) { perOwner = new Map(); store.set(input.ownerId, perOwner); }
  perOwner.set(input.parentSessionId, snapshot);
  return snapshot;
}

/** The latest captured context for an owner's parent session, or null if none. */
export function getSnapshot(ownerId: string, parentSessionId: string): ContextSnapshot | null {
  return store.get(ownerId)?.get(parentSessionId) ?? null;
}

/** Forget a parent session's snapshot (on clear, or when the session ends). */
export function clearSnapshot(ownerId: string, parentSessionId: string): void {
  store.get(ownerId)?.delete(parentSessionId);
}

/** Test/cleanup helper: forget every snapshot. */
export function clearAllSnapshots(): void {
  store.clear();
}
