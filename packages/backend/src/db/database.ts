/**
 * Real Database Manager using better-sqlite3
 * Replaces the temporary in-memory database
 */

import { mainDatabasePath } from '../config/data-root.js';
import { dbDriver } from './pg/config.js';
import { StartProblem, appVersion, newErrorId, newerLayout, unknownMigrations } from './layout.js';
import { storeP3Enabled } from '../services/store-p3.js';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DatabaseConfig {
  path: string;
  readonly?: boolean;
  verbose?: boolean;
}

export class DatabaseManager {
  private db: Database.Database;
  private config: DatabaseConfig;

  constructor(config: DatabaseConfig) {
    this.config = config;

    // Ensure database directory exists
    const dbDir = dirname(config.path);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    // Initialize database
    this.db = new Database(config.path, {
      readonly: config.readonly || false,
      verbose: config.verbose ? console.log : undefined
    });

    // SECURITY: Set restrictive file permissions on database file (L-05)
    // chmod 600 = read/write for owner only (rw-------)
    try {
      if (process.platform !== 'win32') {
        // Unix/Linux/macOS: Set to 0o600 (rw-------)
        chmodSync(config.path, 0o600);
        chmodSync(`${config.path}-wal`, 0o600); // WAL file
        chmodSync(`${config.path}-shm`, 0o600); // Shared memory file
      }
      // Note: Windows doesn't use chmod - file permissions are handled via NTFS ACLs
    } catch (error: any) {
      console.warn('[Database] Warning: Could not set file permissions:', error.message);
    }

    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');

    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');
    // STORE-MAP-01 P3: a memory row is rewritten more often (source, trust, packed vector); freed
    // space is zeroed so an earlier copy of a forgotten memory never stays in the file.
    if (storeP3Enabled()) this.db.pragma('secure_delete = ON');

    console.log(`[Database] ✅ Connected to ${config.path}`);
  }

  /**
   * Initialize database schema
   */
  async initialize(): Promise<void> {
    // STORE-MAP-01 P3 (OPS2): never open data a newer Girru wrote (before anything is written).
    this.checkLayout();

    console.log('[Database] Initializing schema...');

    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');

    // Execute schema (CREATE TABLE statements)
    this.db.exec(schema);

    console.log('[Database] ✅ Schema initialized');

    // Run migrations
    await this.runMigrations();

    // Ensure default system user exists for anonymous sessions
    await this.ensureDefaultUser();
  }

  /**
   * Ensure a default system user exists for anonymous/legacy sessions
   */
  private async ensureDefaultUser(): Promise<void> {
    const bcrypt = await import('bcryptjs');

    // Create default system user (string ID for legacy compatibility)
    const DEFAULT_USER_ID = 'mock-user';
    const existingUser = this.db.prepare('SELECT id FROM users WHERE id = ?').get(DEFAULT_USER_ID);

    if (!existingUser) {
      console.log('[Database] Creating default system user...');

      // SECURITY: Use 12 bcrypt rounds for stronger password hashing (M-07)
      const passwordHash = await bcrypt.default.hash(randomBytes(32).toString('hex'), 12);

      this.db.prepare(`
        INSERT INTO users (id, email, username, password_hash, full_name, role, status, email_verified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        DEFAULT_USER_ID,
        'system@agent-player.local',
        'system',
        passwordHash,
        'System User',
        'user',
        'active',
        1
      );

      console.log('[Database] ✅ Default system user created');
    }

    // Create demo user with ID '1' (string) for avatar/voice features
    const demoUserId = '1';
    const existingDemoUser = this.db.prepare('SELECT id FROM users WHERE id = ?').get(demoUserId);

    if (!existingDemoUser) {
      console.log('[Database] Creating demo user (ID: 1)...');

      // SECURITY: Use 12 bcrypt rounds for stronger password hashing (M-07)
      const demoPasswordHash = await bcrypt.default.hash(randomBytes(32).toString('hex'), 12);

      this.db.prepare(`
        INSERT INTO users (id, email, username, password_hash, full_name, role, status, email_verified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        demoUserId,
        'demo1@agent-player.local',
        'demo1',
        demoPasswordHash,
        'Demo User 1',
        'user',
        'active',
        1
      );

      console.log('[Database] ✅ Demo user created (ID: 1)');
    }

    // SECURITY (S0-Q.2): no default owner/admin account. The first owner is created
    // through the setup wizard (POST /api/setup/admin) while no owner exists.
  }

  /**
   * Run database migrations
   */
  private async runMigrations(): Promise<void> {
    console.log('[Database] 🔍 Checking migrations...');

    // Create migrations table if not exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Get applied migrations
    const applied = this.db.prepare('SELECT id, name FROM migrations ORDER BY id').all() as Array<{ id: string; name: string }>;
    const appliedIds = new Set(applied.map(m => m.id));

    console.log(`[Database] 📋 Already applied migrations: ${applied.length}`);
    applied.forEach(m => console.log(`  ✅ ${m.id} - ${m.name}`));

    // Load migration files
    const migrations = this.loadMigrations();

    // Count pending migrations
    const pending = migrations.filter(m => !appliedIds.has(m.id));
    console.log(`[Database] 📦 Pending migrations: ${pending.length}`);
    pending.forEach(m => console.log(`  ⏳ ${m.id} - ${m.name}`));

    // Apply pending migrations
    for (const migration of migrations) {
      if (!appliedIds.has(migration.id)) {
        console.log(`[Database] 🚀 Applying migration: ${migration.name}`);

        try {
          this.db.transaction(() => {
            // Execute migration
            this.db.exec(migration.up);

            // Record migration
            this.db.prepare('INSERT INTO migrations (id, name) VALUES (?, ?)').run(
              migration.id,
              migration.name
            );
          })();
        } catch (err) {
          // STORE-MAP-01 P3 (OPS1): the start-up page names the step and gives an error id.
          if (!storeP3Enabled()) throw err;
          const errorId = newErrorId();
          console.error(`[Database] Update step ${migration.name} failed (${errorId}):`, (err as Error)?.message);
          throw new StartProblem('migration_failed', `The update could not finish (step ${migration.name}).`,
            { step: migration.name, errorId, thisVersion: appVersion() });
        }

        console.log(`[Database] ✅ Applied migration: ${migration.name}`);
      }
    }

    if (storeP3Enabled()) this.writeLayout(migrations.map((m) => m.id));

    if (pending.length === 0) {
      console.log('[Database] ✨ All migrations are up to date!');
    } else {
      console.log(`[Database] ✨ Successfully applied ${pending.length} migration(s)!`);
    }
  }

  /**
   * STORE-MAP-01 P3 (OPS2): stop before writing anything when the data has
   * migrations this build does not know (a newer Girru wrote it). Only logged
   * while GIRRU_STORE_P3 is off.
   */
  private checkLayout(): void {
    const has = (name: string) => !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    if (!has('migrations')) return;
    const applied = (this.db.prepare('SELECT id FROM migrations').all() as Array<{ id: string }>).map((r) => String(r.id));
    const unknown = unknownMigrations(applied, this.migrationFiles().map((f) => f.split('_')[0]));
    if (!unknown.length) return;
    const writtenBy = has('schema_layout') ? ((this.db.prepare('SELECT written_by FROM schema_layout WHERE id = 1').get() as { written_by?: string } | undefined)?.written_by ?? null) : null;
    if (storeP3Enabled()) throw newerLayout(unknown, writtenBy);
    console.warn(`[Database] This data has update steps this Girru does not know (${unknown.join(', ')}); a newer Girru wrote it.`);
  }

  /** STORE-MAP-01 P3: record the level and the version that last opened the data. */
  private writeLayout(ids: string[]): void {
    const level = [...ids].sort().pop() ?? '';
    this.db.prepare(`INSERT INTO schema_layout (id, level, written_by, updated_at) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET level = excluded.level, written_by = excluded.written_by, updated_at = excluded.updated_at`).run(level, appVersion(), new Date().toISOString());
  }

  private migrationFiles(): string[] {
    const dir = join(__dirname, 'migrations');
    return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.sql')).sort() : [];
  }

  /**
   * Load migration files
   */
  private loadMigrations(): Array<{ id: string; name: string; up: string; down: string }> {
    const migrationsDir = join(__dirname, 'migrations');

    if (!existsSync(migrationsDir)) {
      console.log('[Database] No migrations directory found');
      return [];
    }

    const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

    const migrations = files.map(file => {
      const filePath = join(migrationsDir, file);
      const content = readFileSync(filePath, 'utf-8');

      // Extract ID from filename (e.g., "003_avatar_voice.sql" -> "003")
      const id = file.split('_')[0];
      const name = file.replace('.sql', '');

      return {
        id,
        name,
        up: content,
        down: '' // We don't support down migrations for now
      };
    });

    console.log(`[Database] Found ${migrations.length} migration(s)`);
    return migrations;
  }

  /**
   * Get database instance
   */
  getDb(): Database.Database {
    return this.db;
  }

  /**
   * Backwards compatibility: Execute SQL (alias for getDb().exec())
   */
  exec(sql: string): Database.Database {
    return this.db.exec(sql);
  }

  /**
   * Backwards compatibility: Prepare statement (alias for getDb().prepare())
   */
  prepare(sql: string): Database.Statement {
    return this.db.prepare(sql);
  }

  /**
   * Execute a query
   */
  query<T = any>(sql: string, ...params: any[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  /**
   * Execute a query and return first result
   */
  queryOne<T = any>(sql: string, ...params: any[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  /**
   * Execute an insert/update/delete
   */
  execute(sql: string, ...params: any[]): Database.RunResult {
    return this.db.prepare(sql).run(...params);
  }

  /**
   * Begin a transaction
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
    console.log('[Database] Connection closed');
  }

  /**
   * Get database statistics
   */
  getStats(): {
    size: number;
    tables: number;
    pageSize: number;
    pageCount: number;
  } {
    const size = this.db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get() as any;
    const tables = this.db.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table'").get() as any;

    return {
      size: size.size || 0,
      tables: tables.count || 0,
      pageSize: this.db.pragma('page_size', { simple: true }) as number,
      pageCount: this.db.pragma('page_count', { simple: true }) as number
    };
  }

  /**
   * Optimize database (VACUUM)
   */
  optimize(): void {
    console.log('[Database] Optimizing...');
    this.db.exec('VACUUM;');
    this.db.exec('ANALYZE;');
    console.log('[Database] ✅ Optimized');
  }

  /**
   * Backup database
   */
  async backup(backupPath: string): Promise<void> {
    console.log(`[Database] Backing up to ${backupPath}...`);

    return new Promise((resolve, reject) => {
      const backup = this.db.backup(backupPath);

      backup
        .then(() => {
          console.log('[Database] ✅ Backup completed');
          resolve();
        })
        .catch(reject);
    });
  }

  /**
   * Get table row counts
   */
  getTableCounts(): Record<string, number> {
    const tables = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all() as Array<{ name: string }>;

    const counts: Record<string, number> = {};

    for (const table of tables) {
      const result = this.db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get() as any;
      counts[table.name] = result.count;
    }

    return counts;
  }
}

// Singleton instance
let dbInstance: DatabaseManager | null = null;

/**
 * B2.2d-17: on PostgreSQL (AGENT_PLAYER_DB=postgres) the main SQLite file is
 * not used at all; reaching it is a bug, so it fails loudly instead of
 * silently reading or creating `agent-player.db`.
 */
export class SqliteOnPostgresError extends Error {}

/**
 * Get or create database instance. On PostgreSQL only an explicit `config`
 * (a tool that deliberately opens a SQLite file, e.g. a data copy) opens one.
 */
export function getDatabase(config?: DatabaseConfig): DatabaseManager {
  if (!dbInstance) {
    if (!config && dbDriver() === 'postgres') {
      throw new SqliteOnPostgresError('The main SQLite database is not used on PostgreSQL (AGENT_PLAYER_DB=postgres)');
    }
    const defaultConfig: DatabaseConfig = {
      path: mainDatabasePath(),
      verbose: process.env.NODE_ENV === 'development'
    };

    dbInstance = new DatabaseManager(config || defaultConfig);
  }

  return dbInstance;
}

/**
 * Close database connection
 */
export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export default DatabaseManager;
