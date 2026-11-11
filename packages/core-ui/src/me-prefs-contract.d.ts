export const THEME_PREF_PATH: '/api/me/theme';
export const AGENT_COMMANDS_PATH: '/api/me/agent-commands';
export function mePrefsRoute(path: string): boolean;
export function allowedMePrefs(method: string, path: string, body?: unknown): boolean;
export function mePrefsResponse(path: string, status: number, body: unknown): Record<string, unknown>;
