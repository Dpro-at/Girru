// Wire contract for small per-person program choices, shared by the browser client
// (session.ts) and the local bridge (application-server.cjs):
// the theme (CP13) and the owner's switch "Agents can run commands on this computer" (CP15).

export const THEME_PREF_PATH = '/api/me/theme';
export const AGENT_COMMANDS_PATH = '/api/me/agent-commands';
const THEMES = ['system', 'light', 'dark'];
const record = x => typeof x === 'object' && x !== null && !Array.isArray(x);

export function mePrefsRoute(path) { return path === THEME_PREF_PATH || path === AGENT_COMMANDS_PATH; }
export function allowedMePrefs(method, path, body) {
  if (!mePrefsRoute(path)) return false;
  if (method === 'GET') return body === undefined;
  if (method !== 'PUT' || !record(body)) return false;
  if (path === THEME_PREF_PATH) return Object.keys(body).join() === 'theme' && THEMES.includes(body.theme);
  return Object.keys(body).join() === 'on' && typeof body.on === 'boolean';
}
/** Only the known value passes back to the page. */
export function mePrefsResponse(path, status, body) {
  if (status !== 200) return { code: record(body) && typeof body.code === 'string' ? body.code : 'unavailable' };
  if (path === THEME_PREF_PATH) return record(body) && [...THEMES, null].includes(body.theme) ? { theme: body.theme } : {};
  return record(body) && typeof body.on === 'boolean' ? { on: body.on } : {};
}
