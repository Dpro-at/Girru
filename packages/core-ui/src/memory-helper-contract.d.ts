export type HelperPhase = 'waiting' | 'checking' | 'starting_runtime' | 'downloading' | 'verifying' | 'reembedding' | 'ready' | 'fallback';
export type HelperReason = 'hash_chosen' | 'not_loopback' | 'runtime_missing' | 'runtime_not_running' | 'download_failed' | 'model_not_answering';
export type HelperStatus = {
  enabled: boolean; phase: HelperPhase; reason: HelperReason | null; error: string | null; model: string;
  completedBytes: number; sizeBytes: number; percent: number | null; attempts: number;
  nextTryAt: string | null; readyAt: string | null; remaining: number;
  runtime: { installed: boolean; running: boolean };
  worker: { model: string; phase: 'later' | 'downloading' | 'ready' | 'fallback' } | null;
};
export type HelperReply = { status: HelperStatus; row: { state: 'ok' | 'needs_you' } };
export const MEMORY_HELPER_PATH: '/api/memory/helper';
export const MEMORY_HELPER_RETRY_PATH: '/api/memory/helper/retry';
export const HELPER_PHASES: readonly HelperPhase[];
export function memoryHelperRoute(path: string): boolean;
export function allowedMemoryHelper(method: string, path: string, body?: unknown): boolean;
export function helperStatus(x: unknown): HelperStatus;
export function memoryHelperResponse(path: string, status: number, body: unknown): HelperReply | { started: boolean } | { code: string };
