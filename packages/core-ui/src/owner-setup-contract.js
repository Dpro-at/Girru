// INSTALLER-07: first-run owner creation, shared by the browser client and
// the loopback bridge. The one-time setup code comes from `agent-player
// setup` / `start` on the installation computer (backend checks it, loopback
// only). Exact body; replies project to fixed codes, never backend text.
import { validCompanyKind } from './company-kinds.js';

export const OWNER_SETUP_PATH = '/api/setup/admin';
export const SETUP_CODE = /^[A-Za-z0-9_-]{43}$/;
export const OWNER_SETUP_CODES = Object.freeze([
  'setup_token_missing', 'setup_token_invalid', 'setup_token_expired', 'setup_not_local', 'setup_complete',
  'missing_fields', 'weak_password', 'invalid_email', 'user_exists',
]);
const STATUS_FOR = { setup_token_missing: 403, setup_token_invalid: 403, setup_token_expired: 403, setup_not_local: 403, setup_complete: 403, missing_fields: 400, weak_password: 400, invalid_email: 400, user_exists: 409 };
export const validCompanyName = value => typeof value === 'string' && value.length > 0 && [...value].length <= 100 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
export function validOwnerSetupBody(body) {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).every(k => ['name', 'email', 'password', 'setupToken', 'workspaceType', 'companyName', 'companyKind'].includes(k))
    && ['name', 'email', 'password', 'setupToken'].every(k => Object.hasOwn(body, k))
    && (!Object.hasOwn(body, 'workspaceType') || ['individual', 'company'].includes(body.workspaceType))
    && (body.workspaceType === 'company' ? validCompanyName(body.companyName) : !Object.hasOwn(body, 'companyName'))
    && (!Object.hasOwn(body, 'companyKind') || (body.workspaceType === 'company' && validCompanyKind(body.companyKind)))
    && typeof body.name === 'string' && body.name.trim() === body.name && body.name.length > 0 && [...body.name].length <= 100
    && typeof body.email === 'string' && body.email.length >= 3 && body.email.length <= 320 && body.email.includes('@')
    && typeof body.password === 'string' && body.password.length >= 12 && body.password.length <= 4096
    && typeof body.setupToken === 'string' && SETUP_CODE.test(body.setupToken);
}
/** 200 -> { success: true }; a reviewed refusal -> { code }; anything else -> null. */
export function ownerSetupResponse(status, body) {
  if (status === 200) return body !== null && typeof body === 'object' && body.success === true ? { success: true } : null;
  const code = body !== null && typeof body === 'object' ? body.code : undefined;
  return OWNER_SETUP_CODES.includes(code) && STATUS_FOR[code] === status ? { code } : null;
}
/** The code from a local link's fragment (`#setup=<code>`), or null. */
export function setupCodeFromFragment(hash) {
  const m = /^#setup=([A-Za-z0-9_-]{43})$/.exec(typeof hash === 'string' ? hash : '');
  return m ? m[1] : null;
}
