/**
 * One data root for every backend store (RUN-ISO F1).
 *
 * When `AGENT_PLAYER_DATA_DIR` is set, every store the backend writes (main
 * DB, audit, encryption keys and vault, memory, multi-agent, webhooks,
 * gateway, browser, uploads, audio, secrets.env, instance.json, credential
 * backups, MCP server folders, ...) resolves under that one folder.
 *
 * When it is unset, every caller keeps its old location exactly: the legacy
 * path is passed in and returned unchanged (`<cwd>/.data/...` for most
 * stores, `<cwd>/../../.data/...` for memory and uploads, `~/.agent-player`
 * for credential backups and MCP server folders).
 *
 * Explicit per-store variables (`DATABASE_PATH`, `UPLOADS_DIR`,
 * `AUDIT_DB_PATH`, `ENCRYPTION_DB_PATH`, `MCP_SERVERS_DIR`) still win; the
 * isolated launcher clears them (see config/isolation.ts).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATA_DIR_ENV = 'AGENT_PLAYER_DATA_DIR';

/** Absolute data root from `AGENT_PLAYER_DATA_DIR`, or null when unset. */
export function dataRootOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env[DATA_DIR_ENV] ?? '').trim();
  return raw ? path.resolve(raw) : null;
}

/** The backend data folder: `AGENT_PLAYER_DATA_DIR`, else `<cwd>/.data`. */
export function dataRoot(): string {
  return dataRootOverride() ?? path.join(process.cwd(), '.data');
}

/** `<data root>/<parts>` (absolute); unset: `<cwd>/.data/<parts>`. */
export function dataPath(...parts: string[]): string {
  return path.join(dataRoot(), ...parts);
}

/**
 * `<AGENT_PLAYER_DATA_DIR>/<parts>` when the variable is set; otherwise the
 * caller's legacy path, returned unchanged (same string as before F1).
 */
export function dataPathOr(legacy: string, ...parts: string[]): string {
  const root = dataRootOverride();
  return root ? path.join(root, ...parts) : legacy;
}

/** The main SQLite database: `DATABASE_PATH`, else `<data root>/agent-player.db`. */
export function mainDatabasePath(): string {
  return process.env.DATABASE_PATH || dataPath('agent-player.db');
}

/** Encrypted credential backups: `<data root>/credentials`, else `~/.agent-player/credentials`. */
export function credentialsBackupDir(): string {
  return dataPathOr(path.join(os.homedir(), '.agent-player', 'credentials'), 'credentials');
}

/**
 * realpath of the nearest existing ancestor plus the rest, so a path that
 * does not exist yet (a file about to be written) still resolves every
 * symlinked parent (e.g. /var -> /private/var, or a link into a data dir).
 */
export function realish(p: string): string {
  const abs = path.resolve(p);
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function envDir(name: string, file: boolean): string | null {
  const v = (process.env[name] ?? '').trim();
  if (!v) return null;
  return file ? path.dirname(path.resolve(v)) : path.resolve(v);
}

const insideDir = (child: string, parent: string) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
/** BACKUP-01: ~/Girru Backups (GIRRU_BACKUPS_DIR), or next to the data folder when home is inside it (isolated runs). */
export function defaultBackupsFolder(): string {
  const env = (process.env.GIRRU_BACKUPS_DIR ?? '').trim();
  if (env) return path.resolve(env);
  const home = path.join(os.homedir(), 'Girru Backups');
  return insideDir(realish(home), realish(dataRoot())) ? path.join(path.dirname(path.resolve(dataRoot())), 'Girru Backups') : home;
}
let savedBackupsFolder: string | null = null;
/** The owner's choice, kept in the database (app_settings) and loaded here on start (services/backups.ts). */
export function setSavedBackupsFolder(folder: string | null): void { savedBackupsFolder = folder && path.isAbsolute(folder) ? folder : null; }
/** Where backups are kept: the owner's choice, else the default. */
export function backupsFolder(): string { return savedBackupsFolder ?? defaultBackupsFolder(); }

/**
 * Every folder that holds private server data, canonical (realpath'd) and
 * deduplicated. The one list used by the agent file sandbox
 * (tools/core/file-sandbox.ts) and the exec / MCP working-dir policy
 * (tools/exec-policy.ts), so the two gates always agree.
 *
 *  - the data root, and the legacy `<cwd>/.data` (still there when
 *    AGENT_PLAYER_DATA_DIR moves the root);
 *  - folders of stores that can sit outside the root: the main DB
 *    (`DATABASE_PATH`), audit DB, encryption vault, credential backups;
 *  - the backups folder (a copy of all of it, keys included);
 *  - uploads (`UPLOADS_DIR` / `STORAGE_BASE_DIR`, or the legacy
 *    `<cwd>/../../.data/uploads`) and the legacy memory folder: uploads hold
 *    per-user private files (avatars, attachments, profile pictures) that
 *    are served only through the owner check, so agent tools never touch
 *    them directly.
 *
 * MCP_SERVERS_DIR is not listed: it holds no private data and must stay
 * usable as a server working folder.
 */
export function protectedDataDirs(): string[] {
  const cwd = process.cwd();
  const dirs: Array<string | null> = [
    dataRoot(),
    path.join(cwd, '.data'),
    envDir('DATABASE_PATH', true),
    envDir('AUDIT_DB_PATH', true),
    envDir('ENCRYPTION_DB_PATH', true),
    credentialsBackupDir(),
    envDir('UPLOADS_DIR', false) ?? dataPathOr(path.join(cwd, '..', '..', '.data', 'uploads'), 'uploads'),
    envDir('STORAGE_BASE_DIR', false),
    // Installed program bytes are not agent-editable workspace files.
    envDir('GIRRU_APP_RUNTIMES_DIR', false),
    envDir('GIRRU_CHANNELS_RUNTIME_DIR', false),
    envDir('AGENT_CONNECT_STATE_DIR', false) ?? path.join(os.homedir(), '.agent-connect'),
    dataPathOr(path.join(cwd, '..', '..', '.data', 'memory'), 'memory'),
    // BACKUP-01: backups hold a copy of everything above, keys included.
    backupsFolder(),
  ];
  const out = new Set<string>();
  for (const d of dirs) {
    if (!d) continue;
    out.add(path.resolve(d));
    out.add(realish(d));
  }
  return [...out];
}
