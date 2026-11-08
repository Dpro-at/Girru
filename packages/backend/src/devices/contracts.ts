import {syncPayload} from './replication-contract.js';
/** Computer coordination is a separate application protocol inside the existing g1 channel. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
export const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const deviceId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const taskPayload = z.object({ taskId: identifier, attemptId: identifier, projectBinding: identifier, agentBinding: identifier, modelBinding: identifier, text: z.string().min(1).max(8000),source:z.object({conversationId:identifier.optional(),boardId:identifier.optional(),cardId:identifier.optional(),cardVersion:z.number().int().min(1).optional()}).strict().optional() }).strict();
export type TaskPayload = z.infer<typeof taskPayload>;
export const presencePayload = z.object({ bootId: identifier, name: z.string().min(1).max(64).regex(/^[^\x00-\x1f\x7f]+$/), state: z.enum(['available', 'busy', 'paused']), expiresAt: count, capabilities: z.array(z.enum(['synthetic-task-v1','task-v1','selected-sync-v1'])).max(3),capacity:z.object({limit:z.literal(3),active:z.number().int().min(0).max(3)}).strict() }).strict();
export const statusPayload = z.object({ taskId: identifier, attemptId: identifier, state: z.enum(['waiting_approval', 'blocked', 'accepted', 'running', 'completed', 'cancel_requested', 'cancelled', 'unknown']), sessionId: identifier.nullable(), runId: identifier.nullable(), detail: z.string().max(8000) }).strict();
export const cancelPayload = z.object({ taskId: identifier, attemptId: identifier }).strict();
const base = { protocol: z.literal('girru-computer'), version: z.literal(1), workspace: identifier, epoch: count.positive(), sender: deviceId, target: deviceId, eventId: identifier, requestId: identifier, sequence: count.positive(), sentAt: count, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) };
export const envelopeSchema = z.discriminatedUnion('kind', [
    z.object({ ...base, kind: z.literal('presence'), payload: presencePayload }).strict(),
    z.object({ ...base, kind: z.literal('task'), payload: taskPayload }).strict(),
    z.object({ ...base, kind: z.literal('status'), payload: statusPayload }).strict(),
    z.object({ ...base, kind: z.literal('cancel'), payload: cancelPayload }).strict(),
    z.object({...base,kind:z.literal('sync_status'),payload:z.object({recordId:identifier,contentHash:z.string().regex(/^[a-f0-9]{64}$/),state:z.enum(['received','pending','conflict','review','waiting_approval','applying','applied','unknown','rejected']),detail:z.string().max(240)}).strict()}).strict(),
    z.object({...base,kind:z.literal('sync'),payload:syncPayload}).strict(),
    z.object({ ...base, kind: z.literal('ack'), payload: z.object({ eventId: identifier }).strict() }).strict(),
]);
export type Envelope = z.infer<typeof envelopeSchema>;
export function canonical(v: unknown): string { if (Array.isArray(v))
    return '[' + v.map(canonical).join(',') + ']'; if (v && typeof v === 'object')
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}'; return JSON.stringify(v); }
export const fingerprint = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
export function readEnvelope(raw: unknown): Envelope { if (typeof raw === 'string') {
    if (Buffer.byteLength(raw) > 64000)
        throw Error('computer_envelope_too_large');
    raw = JSON.parse(raw);
} if (Buffer.byteLength(JSON.stringify(raw)) > 64000)
    throw Error('computer_envelope_too_large'); const e = envelopeSchema.parse(raw); if (fingerprint(e.payload) !== e.fingerprint)
    throw Error('computer_payload_changed'); return e; }
export const PRODUCTION_ENROLLMENT = Object.freeze({ enabled: false, reason: 'Identity topology, device custody, recovery and restore freshness require owner acceptance.' });
