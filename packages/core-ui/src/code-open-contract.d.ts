export interface CodeTarget { folder: string; file: string; path: string; line: number | null; generated: boolean; where: 'project' | 'data'; project: string | null }
export type CodeOpenRefusal = { code: 'invalid' | 'outside' | 'not_found' | 'not_allowed' | 'unavailable' };
export const CODE_OPEN_PATH: string;
export const MAX_LINE: number;
export function codeOpenRoute(path: string): boolean;
export function allowedCodeOpen(method: string, path: string, body?: unknown): boolean;
export function codeOpenResponse(status: number, body: unknown): CodeTarget | CodeOpenRefusal;
