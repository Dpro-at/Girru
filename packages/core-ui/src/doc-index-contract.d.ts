export const DOCUMENTS_PATH: string;
export const DOCUMENT_SOURCES_PATH: string;
export const READ_PDF_PATH: string;
export function reindexPath(id: string): string;
export const READ_PDF_BASE64: number;
export const DOC_STATES: readonly string[];
export const PDF_REASONS: readonly string[];
export function docIndexRoute(path: string): boolean;
export function allowedDocIndex(method: string, path: string, body?: unknown): boolean;
export function docIndexResponse(path: string, status: number, body: unknown): unknown;
export type DocSource = {
  id: string; enabled: boolean; state: 'pending' | 'running' | 'ready' | 'error'; files: number; chunks: number;
  unreadable: Array<{ file: string; reason: string }>; limited: boolean; note: string | null; scannedAt: string | null;
};
export type DocProject = {
  id: string; name: string; mine: boolean; hasFolder: boolean; source: DocSource | null;
  folders: Array<{ path: string; name: string; main: boolean; files: number }>;
};
export type DocumentsView = { projects: DocProject[]; agents: { sources: number; files: number; unreadable: Array<{ file: string; reason: string }>; state: 'running' | 'ready' | null } };
