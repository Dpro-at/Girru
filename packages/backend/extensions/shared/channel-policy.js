/**
 * Agent Connect runtime policy (S0-Q.6).
 *
 * Channel settings arrive over HTTP, so nothing in them may decide which
 * program runs or where it writes:
 * - The Python interpreter comes only from the server environment
 *   (AGENT_CONNECT_PYTHON) or a fixed default, never from channel config.
 * - The adapter state directory is always inside a server-controlled base
 *   directory (AGENT_CONNECT_STATE_DIR, default ~/.agent-connect).
 * - Provider settings keys and environment variables are limited to names that belong to the
 *   selected channel; names that point at files, programs, libraries or
 *   interpreter behaviour are refused.
 *
 * The worker process itself is spawned by agent-connect-dpro with its own
 * minimal environment (PATH, HOME, LANG, TEMP, SSL_CERT_* …), so server
 * secrets such as ENCRYPTION_KEY or JWT_SECRET are never inherited.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CHANNEL_CATALOG } from './channel-catalog.js';

export const DEFAULT_PYTHON = 'python';

/** Interpreter for the adapter worker: server environment or fixed default. */
export function resolvePythonExecutable(env = process.env) {
  const configured = typeof env.AGENT_CONNECT_PYTHON === 'string' ? env.AGENT_CONNECT_PYTHON.trim() : '';
  return configured || DEFAULT_PYTHON;
}

/** Server-controlled base directory for all adapter state. */
export function stateBaseDirectory(env = process.env) {
  const configured = typeof env.AGENT_CONNECT_STATE_DIR === 'string' ? env.AGENT_CONNECT_STATE_DIR.trim() : '';
  return resolve(configured || join(homedir(), '.agent-connect'));
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * True when a requested state directory is an acceptable relative name:
 * one or more simple segments, no absolute path, no `..`, no backslashes.
 */
export function isValidStateDirectory(requested) {
  if (requested === undefined) return true;
  if (typeof requested !== 'string' || !requested || requested.length > 200) return false;
  if (isAbsolute(requested) || requested.includes('\\') || requested.includes('\0')) return false;
  return requested.split('/').every(segment => SAFE_SEGMENT.test(segment) && segment !== '..' && !/^\.+$/.test(segment));
}

/**
 * Absolute state directory for a channel. A requested value is only a
 * sub-path of the base directory; anything else throws.
 */
export function resolveStateDirectory(channelId, requested, env = process.env) {
  const base = stateBaseDirectory(env);
  if (!isValidStateDirectory(requested)) throw new Error('Invalid Agent Connect state directory');
  const target = resolve(base, requested === undefined ? channelId : requested);
  const rel = relative(base, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new Error('Agent Connect state directory must stay inside the server state directory');
  }
  return target;
}

// Full, channel-specific name prefixes accepted in addition to the channel
// id prefix (e.g. NTFY_) and the exact catalog requiredEnv names. Never a
// bare vendor word such as GOOGLE_ or MICROSOFT_: those reach SDK-wide
// variables like GOOGLE_APPLICATION_CREDENTIALS.
const EXTRA_PREFIXES = {
  relay: ['GATEWAY_RELAY_'],
  sms: ['TWILIO_'],
  whatsapp_cloud: ['WHATSAPP_CLOUD_'],
  homeassistant: ['HASS_'],
  msgraph_webhook: ['MSGRAPH_WEBHOOK_'],
};

// Never accepted, whatever the channel: names that point at files, programs,
// libraries, directories or credential files, or change interpreter/loader
// behaviour.
const DENIED_NAME_PART = /(^|_)(PATH|PATHS|DIR|DIRS|DIRECTORY|FILE|FILES|KEYFILE|BIN|BINARY|EXE|EXECUTABLE|CMD|COMMAND|COMMANDS|SCRIPT|SHELL|PRELOAD|LIBRARY|LIB|MODULE|MODULES|PLUGIN|PLUGINS|HOOK|HOOKS|CLI|CREDENTIAL|CREDENTIALS)(_|$)/;
const DENIED_NAME_PREFIX = /^(LD_|DYLD_|PYTHON|NODE_|SSL_|REQUESTS_|CURL_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|GOOGLE_APPLICATION_|GOOGLE_EXTERNAL_ACCOUNT|AWS_|AZURE_|GCLOUD_|CLOUDSDK_)/;

// Names ending in HOME point at a program's home directory (config, keys).
const DENIED_NAME_SUFFIX = /HOME$/;

const catalogById = new Map(CHANNEL_CATALOG.map(channel => [channel.id, channel]));

/** Name prefixes a channel's provider variables may use. */
export function channelEnvPrefixes(channelId) {
  if (!catalogById.has(channelId)) return [];
  return [...new Set([channelId.toUpperCase() + '_', ...(EXTRA_PREFIXES[channelId] || [])])];
}

/** True when `key` may be passed to the adapter worker for this channel. */
export function isAllowedEnvironmentKey(channelId, key) {
  if (typeof key !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(key)) return false;
  const channel = catalogById.get(channelId);
  if (!channel) return false;
  if (DENIED_NAME_PREFIX.test(key) || DENIED_NAME_PART.test(key) || DENIED_NAME_SUFFIX.test(key)) return false;
  if ((channel.requiredEnv || []).includes(key)) return true;
  return channelEnvPrefixes(channelId).some(prefix => key.startsWith(prefix) && key.length > prefix.length);
}

/** True when a value may be passed for `key` (JSON variables must be inline JSON objects). */
export function isAllowedEnvironmentValue(key, value) {
  if (typeof value !== 'string' || value.length > 16384 || value.includes('\0')) return false;
  if (key.endsWith('_JSON')) {
    try {
      const parsed = JSON.parse(value);
      return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch { return false; }
  }
  return true;
}

/** Validate a provider environment object for one channel. */
export function isValidEnvironment(channelId, environment) {
  if (environment === undefined) return true;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) return false;
  const entries = Object.entries(environment);
  if (entries.length > 64) return false;
  return entries.every(([key, value]) => isAllowedEnvironmentKey(channelId, key) && isAllowedEnvironmentValue(key, value));
}

/** Copy only allowed variables (defence in depth for stored configs). */
export function filterEnvironment(channelId, environment) {
  const result = {};
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) return result;
  for (const [key, value] of Object.entries(environment)) {
    if (isAllowedEnvironmentKey(channelId, key) && isAllowedEnvironmentValue(key, value)) result[key] = value;
  }
  return result;
}

// ---- Provider settings (PlatformConfig) -------------------------------

// Top-level PlatformConfig keys a channel config may set. Everything else
// (home_channel, channel_overrides, unknown keys) is refused.
const SETTINGS_SCALAR_KEYS = {
  token: 'string', api_key: 'string', reply_to_mode: 'string',
  typing_status_text: 'string', typing_indicator: 'boolean', gateway_restart_notification: 'boolean',
};
const REPLY_TO_MODES = ['off', 'first', 'all'];

// Per-channel extra keys that are otherwise refused by the generic rules.
const NAMED_EXTRAS = {
  relay: { url: 'string', platform: 'string', bot_id: 'string', upgrade_secret: 'string', descriptor: 'object' },
};

// Generic extra keys: lower-case names; nothing that names a file, program,
// directory, command, library or URL target.
const EXTRA_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const DENIED_EXTRA_PART = /(^|_)(path|paths|dir|dirs|directory|file|files|keyfile|bin|binary|exe|executable|cmd|command|commands|script|shell|preload|library|lib|module|modules|plugin|plugins|hook|hooks|cli|url|uri|endpoint|host|socket|credential|credentials|python|interpreter|env|environment)(_|$)/;
// String values that look like local paths or file URLs are refused in generic extras.
const PATH_LIKE_VALUE = /^(\/|~|\.{1,2}(\/|\\|$)|file:|[A-Za-z]:[\\/])|\\|\0/;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isSmallJson(value, depth = 0) {
  if (depth > 6) return false;
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return typeof value !== 'string' || (value.length <= 8192 && !value.includes('\0'));
  }
  if (Array.isArray(value)) return value.length <= 256 && value.every(item => isSmallJson(item, depth + 1));
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    return entries.length <= 256 && entries.every(([, item]) => isSmallJson(item, depth + 1));
  }
  return false;
}

/** True when `key: value` may appear in `settings.extra` for this channel. */
export function isAllowedExtra(channelId, key, value) {
  const named = NAMED_EXTRAS[channelId]?.[key];
  if (named === 'object') return isPlainObject(value) && isSmallJson(value);
  if (named === 'string') return typeof value === 'string' && value.length <= 8192 && !value.includes('\0');
  if (typeof key !== 'string' || !EXTRA_KEY.test(key) || DENIED_EXTRA_PART.test(key)) return false;
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return true;
  if (typeof value === 'string') return value.length <= 8192 && !PATH_LIKE_VALUE.test(value);
  if (Array.isArray(value)) {
    return value.length <= 256 && value.every(item => typeof item === 'number'
      || (typeof item === 'string' && item.length <= 1024 && !PATH_LIKE_VALUE.test(item)));
  }
  return false;
}

function isAllowedSettingsEntry(channelId, key, value) {
  if (key === 'extra') {
    return isPlainObject(value) && Object.keys(value).length <= 64
      && Object.entries(value).every(([extraKey, extraValue]) => isAllowedExtra(channelId, extraKey, extraValue));
  }
  const type = SETTINGS_SCALAR_KEYS[key];
  if (!type || typeof value !== type) return false;
  if (type === 'string' && (value.length > 8192 || value.includes('\0'))) return false;
  if (key === 'reply_to_mode') return REPLY_TO_MODES.includes(value);
  return true;
}

/** Validate a provider settings object for one channel; unknown keys are refused. */
export function isValidSettings(channelId, settings) {
  if (settings === undefined) return true;
  if (!catalogById.has(channelId) || !isPlainObject(settings)) return false;
  return Object.entries(settings).every(([key, value]) => isAllowedSettingsEntry(channelId, key, value));
}

/** Copy only allowed settings (defence in depth for stored configs). */
export function filterSettings(channelId, settings) {
  const result = {};
  if (!catalogById.has(channelId) || !isPlainObject(settings)) return result;
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'extra') {
      if (!isPlainObject(value)) continue;
      const extra = {};
      for (const [extraKey, extraValue] of Object.entries(value)) {
        if (isAllowedExtra(channelId, extraKey, extraValue)) extra[extraKey] = extraValue;
      }
      result.extra = extra;
    } else if (isAllowedSettingsEntry(channelId, key, value)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Options for PythonTransport. Interpreter and state directory never come
 * from `config`; a stored legacy `python_executable` is ignored. Settings and
 * environment are filtered again here even though saves are validated.
 */
export function transportOptions(channelId, config = {}, env = process.env) {
  return {
    pythonExecutable: resolvePythonExecutable(env),
    stateDirectory: resolveStateDirectory(channelId, config.state_directory, env),
    settings: filterSettings(channelId, config.settings),
    environment: filterEnvironment(channelId, config.environment),
  };
}
