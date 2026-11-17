/**
 * The app's settings, kept in its Girru extension config:
 *  - allowPrivateTargets: whether scans may reach local/private network addresses (off by default);
 *  - noiseProfile: how politely the app paces its own checks (quiet | balanced | aggressive).
 *
 * Only Girru's active owner may change a setting; each change is logged with who made it. Anything
 * unreadable counts as the safe default (private off, quiet pacing).
 */

import { profileNames } from './noise.js';

export function readConfig(api) {
  try { return api.getConfig() || {}; } catch { return {}; }
}

export function allowPrivateTargets(api) {
  return readConfig(api).allowPrivateTargets === true;
}

export function noiseProfile(api) {
  const p = readConfig(api).noiseProfile;
  return profileNames().includes(p) ? p : 'quiet';
}

/** True only for Girru's active owner (not an admin); any doubt means no. */
export function isActiveOwner(api, userId) {
  if (!userId) return false;
  try {
    const user = api.db.prepare('SELECT role, status FROM users WHERE id = ?').get(String(userId));
    return !!user && user.role === 'owner' && user.status === 'active';
  } catch {
    return false;
  }
}

/** An active owner or admin, by Girru's own check (the one the scheduler uses); any doubt means no. */
export function mayUseApp(api, userId) {
  if (!userId || typeof api.authorizeChannelUser !== 'function') return false;
  try {
    api.authorizeChannelUser(String(userId));
    return true;
  } catch {
    return false;
  }
}

export class SettingsError extends Error {}

/** Save settings. Only the active owner may. Each changed value is logged with who changed it. */
export function saveSettings(api, userId, patch = {}) {
  if (!isActiveOwner(api, userId)) throw new SettingsError('Only the owner can change these settings');
  const config = readConfig(api);
  const next = { ...config };
  const now = new Date().toISOString();

  if (typeof patch.allowPrivateTargets === 'boolean' && patch.allowPrivateTargets !== (config.allowPrivateTargets === true)) {
    next.allowPrivateTargets = patch.allowPrivateTargets;
    next.allowPrivateTargetsChangedBy = String(userId);
    next.allowPrivateTargetsChangedAt = now;
    api.log('warn', `Scans to local and private network addresses turned ${patch.allowPrivateTargets ? 'on' : 'off'}`, { userId: String(userId) });
  }

  if (typeof patch.noiseProfile === 'string') {
    if (!profileNames().includes(patch.noiseProfile)) throw new SettingsError('noiseProfile must be quiet, balanced or aggressive');
    if (patch.noiseProfile !== (config.noiseProfile || 'quiet')) {
      next.noiseProfile = patch.noiseProfile;
      next.noiseProfileChangedBy = String(userId);
      next.noiseProfileChangedAt = now;
      api.log('info', `Scan pacing set to ${patch.noiseProfile}`, { userId: String(userId) });
    }
  }

  api.setConfig(next);
  return currentSettings(api);
}

export function currentSettings(api) {
  return { allowPrivateTargets: allowPrivateTargets(api), noiseProfile: noiseProfile(api) };
}
