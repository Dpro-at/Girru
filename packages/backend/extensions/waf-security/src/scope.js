/**
 * Scope / target gate.
 *
 * A check only ever runs against an asset the owner has declared and confirmed they own or may
 * test. The declared, in-scope assets are the coverage denominator. Declaring, confirming ownership
 * of, removing, or allowing a private address for an asset are owner/admin actions, and every one
 * is written to the scope log with who decided it. This sits on top of target.js, which already
 * refuses private/non-public addresses unless the owner turned that on.
 */

import { randomUUID } from 'node:crypto';
import { parseTarget, isNonPublicAddress, TargetError } from './target.js';
import { isIP } from 'node:net';

export class ScopeError extends Error {}

function logScope(db, { userId, assetId = null, action, decidedBy, target = null, note = null }) {
  db.prepare(
    `INSERT INTO app_waf_security__scope_log (id, user_id, asset_id, action, decided_by, target, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), userId, assetId, action, decidedBy, target, note);
}

/** Whether a host literal (or a site base_url's host) is a non-public address. DNS names → unknown (false here; target.js resolves at scan time). */
function hostLooksPrivate(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '');
  return isIP(h) ? isNonPublicAddress(h) : false;
}

/**
 * Add a server or site to scope. The caller must be an active owner/admin (checked by the route).
 * `ownerConfirmed` must be true: the owner is stating they own or may test it.
 */
export function addAsset(db, userId, decidedBy, { kind, label, host, port = null, base_url = null, owner_confirmed, notes = null }) {
  if (!['server', 'site'].includes(kind)) throw new ScopeError('kind must be "server" or "site"');
  if (!label || typeof label !== 'string') throw new ScopeError('A name is required');
  if (!owner_confirmed) throw new ScopeError('You must confirm you own or may test this target');

  let cleanHost = String(host || '').trim();
  let cleanBase = base_url || null;
  if (kind === 'site') {
    // A site is validated as an http(s) target; its host is derived from the address.
    const url = parseTarget(base_url || host); // throws TargetError on a bad address
    cleanBase = url.toString();
    cleanHost = url.hostname.replace(/^\[|\]$/g, '');
  } else {
    if (!cleanHost) throw new ScopeError('A host is required');
    if (cleanHost.length > 255 || /[\s/\\]/.test(cleanHost)) throw new ScopeError('That host does not look valid');
  }

  const isPrivate = hostLooksPrivate(cleanHost) ? 1 : 0;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO app_waf_security__assets (id, user_id, kind, label, host, port, base_url, owner_confirmed, is_private, in_scope, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?)`
  ).run(id, userId, kind, label, cleanHost, port, cleanBase, isPrivate, notes);

  logScope(db, { userId, assetId: id, action: 'declared', decidedBy, target: cleanBase || `${cleanHost}${port ? ':' + port : ''}` });
  logScope(db, { userId, assetId: id, action: 'confirmed-owned', decidedBy, target: cleanHost });
  if (isPrivate) logScope(db, { userId, assetId: id, action: 'private-allowed', decidedBy, target: cleanHost, note: 'host is a private/non-public address' });
  return getAsset(db, userId, id);
}

export function getAsset(db, userId, id) {
  return db.prepare('SELECT * FROM app_waf_security__assets WHERE id = ? AND user_id = ?').get(id, userId) || null;
}

export function listAssets(db, userId, kind = null) {
  if (kind) return db.prepare('SELECT * FROM app_waf_security__assets WHERE user_id = ? AND kind = ? ORDER BY created_at DESC').all(userId, kind);
  return db.prepare('SELECT * FROM app_waf_security__assets WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

/** Remove an asset from scope (reversible: kept in the scope log). The route confirms owner/admin. */
export function removeAsset(db, userId, decidedBy, id) {
  const asset = getAsset(db, userId, id);
  if (!asset) throw new ScopeError('That target is not in your list');
  db.prepare('DELETE FROM app_waf_security__assets WHERE id = ? AND user_id = ?').run(id, userId);
  logScope(db, { userId, assetId: id, action: 'removed', decidedBy, target: asset.base_url || asset.host });
  return { removed: true };
}

/**
 * Resolve an asset to the exact http(s) address or host:port a check will use, and confirm it is
 * in scope and owner-confirmed. Throws ScopeError (out of scope) or TargetError (bad address).
 * A refusal for an out-of-scope target is logged.
 */
export function requireInScope(db, userId, decidedBy, assetId) {
  const asset = getAsset(db, userId, assetId);
  if (!asset || !asset.in_scope || !asset.owner_confirmed) {
    logScope(db, { userId, assetId, action: 'out-of-scope-refused', decidedBy, note: 'target not in confirmed scope' });
    throw new ScopeError('That target is not a confirmed, in-scope asset');
  }
  return asset;
}

export { TargetError };
