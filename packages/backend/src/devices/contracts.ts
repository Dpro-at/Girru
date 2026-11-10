import {executionTiming} from './task-timing.js';
import {syncPayload} from './replication-contract.js';
/** Computer coordination is a separate application protocol inside the existing g1 channel. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
export const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const deviceId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const taskPayload = z.object({ taskId: identifier, attemptId: identifier, projectBinding: identifier, agentBinding: identifier, modelBinding: identifier, text: z.string().min(1).max(8000),timing:executionTiming.optional(),source:z.object({conversationId:identifier.optional(),boardId:identifier.optional(),cardId:identifier.optional(),cardVersion:z.number().int().min(1).optional()}).strict().optional() }).strict();
export type TaskPayload = z.infer<typeof taskPayload>;
export const presencePayload = z.object({ bootId: identifier, name: z.string().min(1).max(64).regex(/^[^\x00-\x1f\x7f]+$/), state: z.enum(['available', 'busy', 'paused']), expiresAt: count, capabilities: z.array(z.enum(['synthetic-task-v1','task-v1','selected-sync-v1'])).max(3),slots:z.array(z.object({id:identifier,label:z.string().min(1).max(128),agentBinding:identifier,modelBinding:identifier}).strict()).max(30).optional(),capacity:z.object({limit:z.literal(3),active:z.number().int().min(0).max(3)}).strict() }).strict();
export const statusPayload = z.object({ taskId: identifier, attemptId: identifier, state: z.enum(['waiting_approval', 'scheduled', 'blocked', 'accepted', 'running', 'completed', 'cancel_requested', 'cancelled', 'unknown']), targetCardId:identifier.nullable().optional(),timing:executionTiming.optional(),sessionId: identifier.nullable(), runId: identifier.nullable(), detail: z.string().max(8000),
    /** CP5: the run's short steps while it runs (no logs, no tool inputs). */
    steps: z.array(z.object({ title: z.string().min(1).max(120).regex(/^[^\x00-\x1f\x7f]+$/), state: z.enum(['done', 'now', 'next', 'failed']) }).strict()).max(12).optional() }).strict();
export const cancelPayload = z.object({ taskId: identifier, attemptId: identifier }).strict();
/** CP10: the work a computer did, coming back (GitHub branch, or the patch in parts inside the channel). */
const resultFile = z.object({ path: z.string().min(1).max(400).regex(/^[^\x00-\x1f\x7f]+$/), added: count, removed: count }).strict();
export const resultPayload = z.object({ taskId: identifier, attemptId: identifier, mode: z.enum(['github', 'direct', 'too_large', 'none']), branch: z.string().regex(/^girru\/[a-z0-9-]{1,40}\/[A-Za-z0-9_-]{1,40}$/).optional(), base: z.string().regex(/^[a-f0-9]{40}$/).optional(), files: z.array(resultFile).max(500), size: count.max(3 * 1024 * 1024).optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), parts: z.number().int().min(1).max(200).optional() }).strict();
export const resultPartPayload = z.object({ taskId: identifier, attemptId: identifier, index: z.number().int().min(0).max(199), text: z.string().max(16000) }).strict();
const base = { protocol: z.literal('girru-computer'), version: z.literal(1), workspace: identifier, epoch: count.positive(), sender: deviceId, target: deviceId, eventId: identifier, requestId: identifier, sequence: count.positive(), sentAt: count, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) };
export const envelopeSchema = z.discriminatedUnion('kind', [
    z.object({ ...base, kind: z.literal('presence'), payload: presencePayload }).strict(),
    z.object({ ...base, kind: z.literal('task'), payload: taskPayload }).strict(),
    z.object({ ...base, kind: z.literal('status'), payload: statusPayload }).strict(),
    z.object({ ...base, kind: z.literal('cancel'), payload: cancelPayload }).strict(),
    z.object({...base,kind:z.literal('sync_status'),payload:z.object({recordId:identifier,contentHash:z.string().regex(/^[a-f0-9]{64}$/),state:z.enum(['received','pending','conflict','review','waiting_approval','applying','applied','unknown','rejected']),detail:z.string().max(240)}).strict()}).strict(),
    z.object({...base,kind:z.literal('sync'),payload:syncPayload}).strict(),
    z.object({ ...base, kind: z.literal('result'), payload: resultPayload }).strict(),
    z.object({ ...base, kind: z.literal('result_part'), payload: resultPartPayload }).strict(),
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
