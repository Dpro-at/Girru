

import { FakeRaw } from '../../services/chat-runs.js';
import { vaultChatFrames } from '../../services/chat-secrets.js';

import { beginChatTurn, instrumentChatReply, parseIdempotencyKey, replayChatOutcome, requestFingerprint } from '../../services/chat-idempotency.js';
import type { FastifyInstance } from 'fastify';
import { chunkText, openSseStream } from '../../services/chat-sse.js';

import { channelTurnFromHeaders } from '../../tools/channel-policy.js';
import { authenticateActiveUser } from '../../auth/route-guards.js';

import { DrawerInputError, chatTurnDrawers } from '../../memory/drawers.js';

import { executeChatTurn } from '../../agent/public.js';
import type { TurnImage } from '../../agent/execution/chat-turn.js';
export * from '../../agent/execution/chat-turn.js';
export { executeChatTurn } from '../../agent/public.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | any[]; // array for multimodal (vision) messages
  /** Images of this message (base64), for a model that can see (CHAT-GAPS-01). */
  images?: TurnImage[];
}

interface ChatRequest {
  model?: string;
  agentId?: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  sessionId?: string;
  systemPrompt?: string;
  systemPromptAppend?: string; // Extra instructions appended AFTER agent system prompt (does not replace it)
  memoryContext?: string;  // Injected relevant memories for this user
  /** CORE-03: the turn's active project / task / mentioned people (memory drawers to open). */
  memoryScope?: { project?: string; task?: string; people?: string[] | string; experience?: boolean };
  userId?: string;         // IGNORED (S0-Q.9): the user comes from the bearer token or the server-side channel turn
  chatContext?: {
    hasAvatarViewer?: boolean;
    isInteractiveMode?: boolean;
    hasDesktopControl?: boolean;
    sessionType?: 'minimal' | 'standard' | 'full';
  };
}

export async function chatRoutes(fastify: FastifyInstance) {
  // POST /api/chat - Send chat message
  fastify.post<{ Body: ChatRequest }>('/api/chat', async (request, reply) => {
    const {
      model,
      agentId,
      messages,
      stream = true,
      temperature,
      maxTokens,
      sessionId = 'default-session',
      systemPrompt,
      systemPromptAppend,
      memoryContext: bodyMemoryContext,
      memoryScope,
      chatContext,
    } = request.body || ({} as ChatRequest);

    // SECURITY (S0-Q.9): authenticate before anything else. The user is the
    // bearer-token user, or - for a channel/phone turn started by server code -
    // the user bound to that turn's server-created token. `userId` in the body
    // is ignored. A channel-turn header with an unknown/ended token is refused.
    const channelTurn = channelTurnFromHeaders(request.headers);
    let userId: string;
    if (channelTurn === null) {
      return reply.status(401).send({ error: 'Authentication required' });
    } else if (channelTurn) {
      userId = channelTurn.userId || 'default';
    } else {
      const authUser = authenticateActiveUser(request);
      if (!authUser) return reply.status(401).send({ error: 'Authentication required' });
      userId = authUser.id;
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return reply.status(400).send({ error: 'Messages array is required' });
    }
    // CORE-03: a bad memoryScope is refused before any SSE stream opens (a
    // channel turn opens no drawers, so its scope is never read).
    if (!channelTurn) {
      try { chatTurnDrawers(true, memoryScope); } catch (err) {
        if (err instanceof DrawerInputError) return reply.status(400).send({ error: 'Invalid memoryScope' });
        throw err;
      }
    }

    // BE-UI-01: turn ids on every frame/body; a repeated Idempotency-Key from
    // the same user within 10 minutes returns the first outcome instead of
    // running the turn again (services/chat-idempotency.ts).
    const idemKey = parseIdempotencyKey(request.headers['idempotency-key']);
    if (idemKey === 'invalid') {
      return reply.status(400).send({ error: 'Idempotency-Key must be 8-128 characters (A-Z, a-z, 0-9, _ - . :)', code: 'invalid_idempotency_key' });
    }
    // The fingerprint covers the whole request that defines the turn (CHAT-01).
    // /api/chat has no anonymous callers: the actor for the per-actor running
    // cap is the signed-in user, or for a server-created channel turn its
    // channel conversation (many outside senders share one owner user id).
    const actor = channelTurn
      ? `channel:${channelTurn.policy.channel}:${channelTurn.policy.conversationId}`
      : `user:${userId}`;
    const turn = beginChatTurn(userId, idemKey, requestFingerprint({
      agentId, sessionId, stream, messages, model, temperature, maxTokens,
      systemPrompt, systemPromptAppend, memoryContext: bodyMemoryContext, memoryScope, chatContext,
    }), actor);
    if (turn.kind === 'busy') {
      // This actor already runs its maximum of keyed turns, or (last resort)
      // every remembered key is still running: refuse rather than forget one.
      reply.header('Retry-After', '30');
      return reply.status(429).send({ error: 'Too Many Requests', code: 'rate_limited', message: 'Too many chat turns are running; try again shortly' });
    }
    if (turn.kind === 'mismatch') {
      return reply.status(422).send({ error: 'This Idempotency-Key was already used for a different request', code: 'idempotency_key_reused' });
    }
    if (turn.kind === 'in_progress') {
      return reply.status(409).send({ error: 'A request with this Idempotency-Key is still running', code: 'idempotency_in_progress', runId: turn.ids.runId, messageId: turn.ids.messageId });
    }
    if (turn.kind === 'replay') return replayChatOutcome(reply, turn.ids, turn.outcome);
    instrumentChatReply(reply, turn.ids, turn.entry);

    // Ids and sizes only: no chat context, prompts or message content in logs.
    console.log('[Chat] Turn accepted', { runId: turn.ids.runId, agentId: agentId ?? null, messages: messages.length, stream });

    const input = { agentId, messages, stream, model, temperature, maxTokens, sessionId, systemPrompt, systemPromptAppend,
      memoryContext: bodyMemoryContext, memoryScope, chatContext, userId, channelTurn, runId: turn.ids.runId };
    if (!stream) return executeChatTurn(reply, input);
    // Legacy direct SSE uses the same privacy boundary as saved chat runs.
    // Its idempotency recorder sees checked frames only.
    openSseStream(reply.raw);
    const frames: Array<Record<string, unknown>> = [];
    let size = 0, overflow = false;
    const buffered = new FakeRaw(frame => {
      size += JSON.stringify(frame).length;
      if (size > 4_000_000) { overflow = true; buffered.close(); return; }
      frames.push(frame);
    });
    const close = () => buffered.close();
    reply.raw.once('close', close);
    let status = 200;
    const checkedReply: any = {
      raw: buffered, header() { return checkedReply; }, headers() { return checkedReply; },
      code(c: number) { status = c; return checkedReply; }, status(c: number) { return checkedReply.code(c); },
      send(body: unknown) { buffered.write(`data: ${JSON.stringify({ type: status >= 400 ? 'error' : 'text', ...(body as object) })}\n\n`); return checkedReply; },
    };
    try {
      await executeChatTurn(checkedReply, input);
      const safe = overflow ? [{ type: 'error', error: 'Reply exceeded the safe buffer limit' }]
        : await vaultChatFrames(userId, sessionId ?? '', frames, !!channelTurn);
      for (const frame of safe) {
        const chunks = typeof frame.content === 'string' ? chunkText(frame.content, 16_000) : [];
        if (chunks.length > 1) {
          for (const content of chunks.slice(0, -1)) reply.raw.write(`data: ${JSON.stringify({ ...frame, content, done: false })}\n\n`);
          frame.content = chunks.at(-1);
        }
        reply.raw.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
    } catch {
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: 'Reply could not be checked' })}\n\n`);
    } finally {
      buffered.end();
      reply.raw.off('close', close);
      reply.raw.end();
    }
    return reply;
  });
}
