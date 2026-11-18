/**
 * APPS-06 step 3: apps that used to ship with Girru now come from the Girru Store, where an
 * app may only own tables named app_<id>__... (store-install appTables). For someone who
 * already used one, its old tables are renamed once, after a backup, so the data stays; the
 * app is then added again from the Store in the background, and its migrations
 * (CREATE ... IF NOT EXISTS) keep the moved tables and rows. SQLite only, like every extension.
 * "Used one" means Girru has a row for it in extension_configs (on or off) or ran its migrations,
 * so an app with no tables moves too, and a table some old Girru made for everyone does not count.
 * The next app that moves only adds an entry to MOVED_APPS.
 */
import fs from 'node:fs';import {dataPath} from '../config/data-root.js';
import { startAdd, type AddJob, type Fetch } from './store-install.js';

/**
 * Apps moved out of the program into the Girru Store, with the table names they had there and
 * the views their old migrations made over them (a Store app cannot make views; they are dropped).
 */
export const MOVED_APPS: ReadonlyArray<{ id: string; tables: readonly string[]; views?: readonly string[] }> = [
  { id: 'seo', tables: ['seo_domains', 'seo_keywords', 'seo_scraper_jobs', 'seo_search_analytics', 'seo_gsc_sync_log', 'seo_settings'] },
  // waf_scans was also made for everyone by core migration 023; it moves only for an owner who used the app.
  {
    id: 'waf-security',
    tables: ['waf_scans', 'waf_rate_limits', 'waf_payload_library', 'waf_campaigns', 'waf_campaign_stages', 'waf_campaign_scans', 'waf_campaign_comparisons', 'waf_campaign_notifications'],
    views: ['v_campaign_summary', 'v_latest_comparisons'],
  },
  // No tables: an owner who had it (a row in extension_configs) gets it added again, on or off as it was.
  { id: 'server-monitor', tables: [] },
  { id: 'trading', tables: [] },
  { id: 'browser', tables: [] },
  { id: 'call-center', tables: ["call_analytics", "call_campaigns", "call_messages", "call_point_knowledge", "call_point_templates", "call_points", "call_queue", "call_sessions", "campaign_analytics", "campaign_contacts", "phone_number_usage", "phone_numbers", "provider_health_log", "provider_usage_stats", "telephony_providers"] },
];

const MOVED = (id: string) => `store.moved.${id}`;
export const REINSTALL = (id: string) => `store.reinstall.${id}`;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const prefixOf = (id: string) => `app_${id.replace(/-/g, '_')}__`;
const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;
const message = (error: unknown) => (error instanceof Error ? error.message : 'unknown error');
type Db = { prepare(s: string): { get(...a: unknown[]): any; all(...a: unknown[]): any[]; run(...a: unknown[]): unknown }; exec(s: string): void; transaction<T>(fn: () => T): () => T };

async function sqlite(): Promise<Db | null> {
  const { dbDriver } = await import('../db/pg/config.js');
  if (dbDriver() === 'postgres') return null; // extensions never ran there (Q-33)
  const { getDatabase } = await import('../db/index.js');
  const db = getDatabase().getDb() as Db;
  db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  return db;
}
const setting = (db: Db, key: string, value: unknown) => db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, JSON.stringify(value), Date.now());

/**
 * The one-time move, at startup after the database opens and before extensions load.
 * Only for an app the owner used. Old tables found: a before-update backup first (no backup, no
 * rename: tried again at the next start), then one transaction drops its old views, renames the
 * tables, forgets the app's recorded migrations so the Store copy's run, and marks the app as
 * waiting to be added again, on or off as it was. With nothing to rename, no backup is made.
 * Returns the moved apps.
 */
export async function moveLegacyAppTables(options: { backup?: () => Promise<unknown>; apps?: typeof MOVED_APPS } = {}): Promise<string[]> {
  const db = await sqlite();
  if (!db) return [];
  const apps = (options.apps ?? MOVED_APPS).filter((a) => !db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(MOVED(a.id)));
  if (!apps.length) return [];
  const has = (t: string, type = 'table') => !!db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, t);
  const config = (id: string) => db.prepare('SELECT enabled FROM extension_configs WHERE extension_id = ?').get(id) as { enabled?: number } | undefined;
  const used = (id: string) => !!config(id) || !!db.prepare('SELECT 1 FROM extension_migrations WHERE extension_id = ?').get(id);
  // An old table moves only when the new name is free; a fresh data folder has none to move.
  const found = apps.map((app) => {
    const populated=(t:string)=>has(t)&&!!db.prepare(`SELECT 1 FROM ${quote(t)} LIMIT 1`).get();
    const browserFiles=app.id==='browser'&&['screenshots','downloads'].some(kind=>{try{return fs.readdirSync(dataPath('browser',kind),{withFileTypes:true}).some(entry=>entry.isFile());}catch{return false;}});
    const had = browserFiles||used(app.id)||(app.id==='call-center'&&app.tables.some(populated))||(app.id==='trading'&&['paper_bots','paper_accounts','paper_runtime_consents','paper_installations'].some(populated));
    const emptyTargets=had&&app.id==='call-center'?app.tables.filter(t=>has(t)&&has(prefixOf(app.id)+t)&&!populated(prefixOf(app.id)+t)):[];
    const collision=had&&app.id==='call-center'&&app.tables.some(t=>has(t)&&populated(prefixOf(app.id)+t));
    if(collision)console.warn('[Store] Call Center table move requires review: both legacy and namespaced tables exist.');
    return { app, had, collision, emptyTargets, old: had&&!collision ? app.tables.filter((t) => has(t) && (!has(prefixOf(app.id) + t)||emptyTargets.includes(t))) : [] };
  });
  if (found.some((f) => f.old.length)) {
    try {
      await (options.backup ?? (async () => (await import('./backups.js')).backUpNow('before-update')))();
    } catch (error) {
      console.warn(`[Store] Old app tables not moved: the backup before it failed (${message(error)}); trying again at the next start`);
      return [];
    }
  }
  const at = new Date().toISOString();
  db.transaction(() => {
    for (const { app, had, old, collision, emptyTargets } of found) {
      if(collision)continue;
      if (had) {
        for(const t of emptyTargets)db.exec(`DROP TABLE ${quote(prefixOf(app.id)+t)}`);
        const enabled = config(app.id)?.enabled === 1||(['trading','browser'].includes(app.id)&&!config(app.id));
        for (const v of app.views ?? []) if (has(v, 'view')) db.exec(`DROP VIEW ${quote(v)}`);
        for (const t of old) {
          // Its old indexes go; the Store copy's migrations make them again under its own names.
          for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(t) as Array<{ name: string }>) db.exec(`DROP INDEX IF EXISTS ${quote(name)}`);
          db.exec(`ALTER TABLE ${quote(t)} RENAME TO ${quote(prefixOf(app.id) + t)}`);
        }
        if(app.id==='call-center'){
          // Fixed bundled compatibility columns, never SQL supplied by a Store package.
          const additions:Record<string,Record<string,string>>={"call_points": {"template_id": "TEXT", "linked_chat_room_id": "TEXT", "max_concurrent_calls": "INTEGER DEFAULT 5", "queue_enabled": "BOOLEAN DEFAULT 1", "queue_music_url": "TEXT", "queue_announcement_interval": "INTEGER DEFAULT 30"}, "call_sessions": {"transcript_file_id": "TEXT", "analytics_id": "TEXT", "post_call_workflow_id": "TEXT", "provider_type": "TEXT DEFAULT 'twilio'", "teams_call_id": "TEXT", "sip_from": "TEXT", "sip_to": "TEXT"}, "phone_numbers": {"provider_type": "TEXT DEFAULT 'twilio' CHECK(provider_type IN ('twilio', 'microsoft_teams', 'vonage', 'plivo'))", "teams_user_id": "TEXT", "teams_resource_account_id": "TEXT", "sip_uri": "TEXT", "total_calls": "INTEGER DEFAULT 0", "total_inbound_calls": "INTEGER DEFAULT 0", "total_outbound_calls": "INTEGER DEFAULT 0", "total_duration_seconds": "INTEGER DEFAULT 0", "total_inbound_duration_seconds": "INTEGER DEFAULT 0", "total_outbound_duration_seconds": "INTEGER DEFAULT 0", "total_cost_spent": "REAL DEFAULT 0.0", "estimated_monthly_cost": "REAL DEFAULT 0.0", "last_used_at": "TEXT", "last_sync_at": "TEXT", "voice": "TEXT DEFAULT 'Polly.Joanna'", "language": "TEXT DEFAULT 'en-US'", "tts_provider": "TEXT DEFAULT 'twilio'", "provider_api_key": "TEXT", "stt_provider": "TEXT DEFAULT 'twilio'", "stt_provider_api_key": "TEXT"}};
          for(const [legacy,fields] of Object.entries(additions))if(old.includes(legacy)){
            const table=prefixOf(app.id)+legacy;
            const columns=new Set(db.prepare(`PRAGMA table_info(${quote(table)})`).all().map((r:any)=>r.name));
            for(const [column,type] of Object.entries(fields))if(!columns.has(column))db.exec(`ALTER TABLE ${quote(table)} ADD COLUMN ${quote(column)} ${type}`);
          }
        }
        db.prepare('DELETE FROM extension_migrations WHERE extension_id = ?').run(app.id);
        setting(db, REINSTALL(app.id), { enabled, since: at });
      }
      setting(db, MOVED(app.id), { at, tables: old });
    }
  })();
  const moved = found.filter((f) => f.had&&!f.collision).map((f) => f.app.id);
  if (moved.length) console.log(`[Store] Moved ${moved.join(', ')} to the Girru Store names; adding ${moved.length === 1 ? 'it' : 'them'} again from the Girru Store`);
  return moved;
}

/**
 * Add again, from the Girru Store, every app waiting since the move: one at a time, in the
 * background, never restarting Girru (it loads at the next start). Success clears the mark
 * and keeps the app off when the owner had turned it off; failure keeps it for the next start.
 */
export async function reinstallMovedApps(options: { fetch?: Fetch } = {}): Promise<Array<{ id: string; ok: boolean; message?: string }>> {
  const db = await sqlite();
  if (!db) return [];
  const out: Array<{ id: string; ok: boolean; message?: string }> = [];
  for (const row of db.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'store.reinstall.%' ORDER BY key").all() as Array<{ key: string; value: string }>) {
    const id = row.key.slice('store.reinstall.'.length);
    if (!ID.test(id)) continue;
    let was: { enabled?: unknown } = {};
    try { was = JSON.parse(row.value); } catch { /* added again turned on */ }
    const job = await new Promise<AddJob>((done) => { startAdd(id, { fetch: options.fetch, restart: () => false, onDone: done }); });
    if (job.ok) {
      db.transaction(() => {
        if (typeof was.enabled === 'boolean') db.prepare("UPDATE extension_configs SET enabled = ?, updated_at = datetime('now') WHERE extension_id = ?").run(was.enabled?1:0,id);
        db.prepare('DELETE FROM app_settings WHERE key = ?').run(row.key);
      })();
      console.log(`[Store] ${id} was added again from the Girru Store with its data; it loads at the next start`);
    } else {
      console.warn(`[Store] ${id} could not be added again yet (${job.message ?? 'unknown error'}); trying again at the next start`);
    }
    out.push({ id, ok: !!job.ok, message: job.message });
  }
  return out;
}
