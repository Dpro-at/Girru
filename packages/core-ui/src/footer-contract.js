// Wire contract for the footer choices (SH3), shared by the browser client
// (session.ts) and the local bridge (application-server.cjs). Saved per
// person on the server so an agent can tidy the footer through MCP too.
// Settings is not a section here: its gear always stays.

export const FOOTER_PATH = '/api/me/footer';
export const FOOTER_SECTIONS = ['chat', 'agents', 'library', 'board', 'memory', 'approvals', 'store', 'genvr', 'terminal', 'code', 'browser', 'skills', 'personalities', 'specialties'];
/** The usual footer: seven sections; the rest live as places inside Library and the Store. MCP connections live in Settings. */
export const DEFAULT_FOOTER = Object.freeze({ order: FOOTER_SECTIONS, hidden: ['genvr', 'terminal', 'code', 'browser', 'skills', 'personalities', 'specialties'], iconsOnly: false, approvalsWhenWaiting: true });
const ADDED_AFTER = { library: 'agents' };
/** SA6: Apps became Store › My apps; an older saved order keeps the Store where Apps was. */
const renamed = id => id === 'apps' ? 'store' : id;
const KEYS = ['order', 'hidden', 'iconsOnly', 'approvalsWhenWaiting'];
const record = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const ids = x => Array.isArray(x) && x.length <= FOOTER_SECTIONS.length && x.every(v => FOOTER_SECTIONS.includes(v)) && new Set(x).size === x.length;

/** A change the server accepts: known keys only, known sections, no repeats. */
export function footerChangeOk(x) {
  if (!record(x) || !Object.keys(x).length || !Object.keys(x).every(k => KEYS.includes(k))) return false;
  if ('order' in x && !ids(x.order)) return false;
  if ('hidden' in x && !ids(x.hidden)) return false;
  for (const k of ['iconsOnly', 'approvalsWhenWaiting']) if (k in x && typeof x[k] !== 'boolean') return false;
  return true;
}

/** Any saved value made whole: unknown ids dropped, a new section shows in its usual place. */
export function footerPrefs(x) {
  const v = record(x) ? x : {};
  const known = Array.isArray(v.order) ? v.order.map(renamed).filter((id, i, all) => FOOTER_SECTIONS.includes(id) && all.indexOf(id) === i) : [];
  const order = [...known, ...FOOTER_SECTIONS.filter(id => !known.includes(id))];
  // A section added later lands next to its neighbour in an older saved order (Library after Agents).
  for (const [id, after] of Object.entries(ADDED_AFTER)) if (!known.includes(id) && known.includes(after)) { order.splice(order.indexOf(id), 1); order.splice(order.indexOf(after) + 1, 0, id); }
  const hidden = Array.isArray(v.hidden) ? FOOTER_SECTIONS.filter(id => v.hidden.includes(id)) : [...DEFAULT_FOOTER.hidden];
  return { order, hidden, iconsOnly: typeof v.iconsOnly === 'boolean' ? v.iconsOnly : false, approvalsWhenWaiting: typeof v.approvalsWhenWaiting === 'boolean' ? v.approvalsWhenWaiting : true };
}

export function footerRoute(path) { return path === FOOTER_PATH; }
export function allowedFooter(method, path, body) {
  if (!footerRoute(path)) return false;
  if (method === 'GET') return body === undefined;
  return method === 'PUT' && footerChangeOk(body);
}
/** Only the footer value passes back to the page. */
export function footerResponse(status, body) {
  if (status !== 200) return { code: record(body) && typeof body.code === 'string' ? body.code : 'unavailable' };
  return { footer: footerPrefs(record(body) ? body.footer : undefined) };
}
