export type TrustLevel = 'verified' | 'heard-once' | 'not-checked';
export interface TrustView { id: string; level: TrustLevel; byOwner: boolean; heardFrom: Array<{ kind: 'you' | 'chat' | 'agent' | 'tool' | 'import' | 'channel' | 'system'; agentId?: string }>; uses: number; lastUsedAt: string | null }
export interface CorrectedReply { runId: string; sessionId: string | null; title: string | null; agentId: string | null; at: string }
export interface CorrectedItem { memoryId: string; nowId: string; drawer: string; was: string; now: string; changedAt: string | null; how: 'edited' | 'replaced'; checked: boolean; replyCount: number; replies: CorrectedReply[] }
export interface OpenQuestion { id: string; question: string; agentId: string | null; status: 'open' | 'resolved' | 'expired'; askedAt: string; resolvedAt: string | null; resolvedMemoryId: string | null; endsAt: string }
export const TRUST_LEVELS: readonly TrustLevel[];
export const MAX_TRUST_IDS: number;
export function trustPath(ids: readonly string[]): string;
export function verifyPath(memoryId: string, undo?: boolean): string;
export const TRUST_WAITING_PATH: string;
export const CORRECTED_PATH: string;
export function correctedPath(memoryId: string): string;
export const QUESTIONS_PATH: string;
export function questionPath(id: string, action: 'answer' | 'forget' | 'restore'): string;
export function trustPathOf(path: string): { route: string; id?: string; ids?: string[] } | null;
export function trustRoute(path: string): boolean;
export function allowedTrust(method: string, path: string, body?: unknown): boolean;
export function trustPathResponse(path: string, status: number, body: unknown): unknown;
