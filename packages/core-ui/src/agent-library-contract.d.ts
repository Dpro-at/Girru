export const LIBRARY_BYTES: number;
export function fileName(x: unknown): x is string;
export function libraryPath(id: string, part?: string, query?: Record<string, string>): string;
export function libraryRoute(path: string): boolean;
export function allowedLibrary(method: string, path: string, body?: unknown): boolean;
export function libraryResponse(path: string, status: number, body: unknown): unknown;
export const LIBRARY_PDF_BASE64: number;
