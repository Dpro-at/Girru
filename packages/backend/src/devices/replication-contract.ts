/** Selection creates review data, never an execution grant or implicit subscription. */
import {z} from 'zod';
import {fingerprint} from './contracts.js';
const identifier=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const syncCategory=z.enum(['agent','personality','specialty','skill','rule','preferences','task','chat','report','artifact']);
export const syncPayload=z.object({recordId:identifier,category:syncCategory,logicalId:identifier,revision:z.number().int().min(1).max(1000000000),parentHash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),contentHash:z.string().regex(/^[a-f0-9]{64}$/),projectBinding:identifier.nullable(),taskId:identifier.nullable(),body:z.record(z.string(),z.unknown())}).strict();
export type SyncPayload=z.infer<typeof syncPayload>;
export function readSync(raw:unknown){const p=syncPayload.parse(raw);if(Buffer.byteLength(JSON.stringify(p))>48000||fingerprint(p.body)!==p.contentHash)throw Error('computer_sync_payload_invalid');return p;}
export interface MemoryReplicationContract {readonly enabled:false;readonly required:readonly string[]}
