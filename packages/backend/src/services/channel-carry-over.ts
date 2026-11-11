/**
 * CHANNELS-01: every chat channel runs in the optional Agent Connect app, its settings under
 * channels.<id> of the one 'agent-connect' row. The separate telegram and discord extensions are gone,
 * so their settings move there once, at startup after the database opens and before extensions load.
 * SQLite only, like every extension.
 *
 * Something to move (an old telegram/discord row, or one of the old channel tables): a before-update
 * backup first (no backup, nothing changes: tried again at the next start), then one transaction
 *  - copies each old row's settings (bot_token, allow-lists, auto_reply, owner_user_id, and any other
 *    key) to channels.<id>, never over a channel already configured there (one with a bot token);
 *  - keeps the channel on only when its old extension was on, and turns agent-connect on when either
 *    was (creating the row if missing); channels that were never switched stay off, as the
 *    activation route leaves them when it first turns the extension on;
 *  - deletes the old rows once copied, so the token is kept in one place only, and forgets the
 *    removed extensions' recorded migrations;
 *  - drops the old channel tables that hold no rows; a table with rows is kept and logged;
 *  - marks the move done, so it never runs twice.
 * channel_events stays as it is: the channel ids are the same.
 */

/** The old extensions whose settings move to agent-connect. */
export const OLD_CHANNEL_EXTENSIONS = ['telegram', 'discord'] as const;
/** Extensions removed with them; only their recorded migrations go. */
const REMOVED_EXTENSIONS = ['telegram', 'discord', 'slack', 'whatsapp'] as const;
/** Tables the removed extensions made; each is dropped only while empty. */
export const OLD_CHANNEL_TABLES = [
  'telegram_messages', 'telegram_config', 'discord_messages', 'discord_config',
  'slack_messages', 'slack_config', 'whatsapp_messages', 'whatsapp_config',
] as const;

export const CARRIED_OVER = 'channels.carried-over';
const HOST = 'agent-connect';
const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;
const message = (error: unknown) => (error instanceof Error ? error.message : 'unknown error');
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
type Db = { prepare(s: string): { get(...a: unknown[]): any; all(...a: unknown[]): any[]; run(...a: unknown[]): unknown }; exec(s: string): void; transaction<T>(fn: () => T): () => T };

export type CarryOver = { channels: string[]; skipped: string[]; dropped: string[]; kept: string[] };

async function sqlite(): Promise<Db | null> {
  const { dbDriver } = await import('../db/pg/config.js');
  if (dbDriver() === 'postgres') return null; // extensions never ran there (Q-33)
  const { getDatabase } = await import('../db/index.js');
  const db = getDatabase().getDb() as Db;
  db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  return db;
}

/** The one-time move. Returns what it did, or null when it did nothing (done before, no SQLite, no backup). */
export async function carryOverChannels(options: { backup?: () => Promise<unknown> } = {}): Promise<CarryOver | null> {
  const db = await sqlite();
  if (!db || db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(CARRIED_OVER)) return null;
  const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const oldRows = () => OLD_CHANNEL_EXTENSIONS
    .map((id) => ({ id, row: db.prepare('SELECT config_json, enabled FROM extension_configs WHERE extension_id = ?').get(id) as { config_json: string; enabled: number } | undefined }))
    .filter((o): o is { id: typeof OLD_CHANNEL_EXTENSIONS[number]; row: { config_json: string; enabled: number } } => !!o.row);
  const tables = () => OLD_CHANNEL_TABLES.filter(has);
  if (oldRows().length || tables().length) {
    try {
      await (options.backup ?? (async () => (await import('./backups.js')).backUpNow('before-update')))();
    } catch (error) {
      console.warn(`[Channels] Old channel settings not moved: the backup before it failed (${message(error)}); trying again at the next start`);
      return null;
    }
  }
  const done: CarryOver = { channels: [], skipped: [], dropped: [], kept: [] };
  db.transaction(() => {
    const host = db.prepare('SELECT config_json, enabled FROM extension_configs WHERE extension_id = ?').get(HOST) as { config_json: string; enabled: number } | undefined;
    let root: Record<string, any> = {};
    try { root = host ? JSON.parse(host.config_json) : {}; } catch { throw new Error('agent-connect settings are not valid JSON'); }
    if (!record(root)) root = {};
    const channels: Record<string, any> = record(root.channels) ? { ...root.channels } : {};
    let turnOn = false;
    for (const { id, row } of oldRows()) {
      let old: unknown;
      try { old = JSON.parse(row.config_json); } catch { old = undefined; }
      if (!record(old)) {
        // Unreadable settings are left where they are for the owner to see.
        console.warn(`[Channels] The old ${id} settings could not be read; they stay in place`);
        done.skipped.push(id);
        continue;
      }
      const on = row.enabled === 1 && old.enabled !== false;
      const current = channels[id];
      if (record(current) && typeof current.bot_token === 'string' && current.bot_token.trim()) {
        done.skipped.push(id); // already configured under agent-connect: kept as it is
      } else {
        channels[id] = { ...(record(current) ? current : {}), ...old, enabled: on };
        done.channels.push(id);
        turnOn ||= on;
      }
      db.prepare('DELETE FROM extension_configs WHERE extension_id = ?').run(id);
    }
    if (done.channels.length) {
      const wasOn = host?.enabled === 1;
      // Turning the extension on for the first time must not switch on channels nobody turned on.
      if (turnOn && !wasOn) {
        for (const [key, value] of Object.entries(channels)) {
          if (!done.channels.includes(key) && record(value) && value.enabled === undefined) channels[key] = { ...value, enabled: false };
        }
      }
      const json = JSON.stringify({ ...root, channels });
      const enabled = wasOn || turnOn ? 1 : 0;
      if (host) db.prepare("UPDATE extension_configs SET config_json = ?, enabled = ?, updated_at = datetime('now') WHERE extension_id = ?").run(json, enabled, HOST);
      else db.prepare('INSERT INTO extension_configs (extension_id, config_json, enabled) VALUES (?, ?, ?)').run(HOST, json, enabled);
    }
    for (const t of tables()) {
      const rows = (db.prepare(`SELECT COUNT(*) AS n FROM ${quote(t)}`).get() as { n: number }).n;
      if (rows === 0) { db.exec(`DROP TABLE ${quote(t)}`); done.dropped.push(t); }
      else { done.kept.push(t); console.log(`[Channels] Kept the old table ${t}: it holds ${rows} row${rows === 1 ? '' : 's'}`); }
    }
    // A removed extension whose tables are all gone has nothing left for its recorded migrations.
    for (const id of REMOVED_EXTENSIONS) {
      if (!OLD_CHANNEL_TABLES.some((t) => t.startsWith(`${id}_`) && has(t))) db.prepare('DELETE FROM extension_migrations WHERE extension_id = ?').run(id);
    }
    db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(CARRIED_OVER, JSON.stringify({ at: new Date().toISOString(), ...done }), Date.now());
  })();
  if (done.channels.length) console.log(`[Channels] Moved the ${done.channels.join(' and ')} settings to Agent Connect`);
  return done;
}
