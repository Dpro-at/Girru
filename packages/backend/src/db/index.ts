/**
 * Database Module - Real SQLite with better-sqlite3
 * Central access point for all database operations
 */

export { DatabaseManager, getDatabase, closeDatabase } from './database.js';
export type { DatabaseConfig } from './database.js';

// Repositories
export { UsersRepository } from './repositories/users.js';
export type { User, CreateUserInput, UpdateUserInput } from './repositories/users.js';

export { SessionsRepository } from './repositories/sessions.js';
export type { ChatSession, ChatMessage, CreateSessionInput, CreateMessageInput } from './repositories/sessions.js';

export { SkillsRepository } from './repositories/skills.js';
export type { Skill, SkillSettings, SkillSecret, CreateSkillInput } from './repositories/skills.js';

// Convenience function to get all repositories
import { getDatabase } from './database.js';
import { dbDriver } from './pg/config.js';
import { UsersRepository } from './repositories/users.js';
import { SessionsRepository } from './repositories/sessions.js';
import { SkillsRepository } from './repositories/skills.js';
import type { ChatMessage, ChatSession } from './repositories/sessions.js';
import * as chatSessions from '../repositories/chat-sessions.js';
import { storeP3Enabled } from '../services/store-p3.js';

export interface Repositories {
  users: UsersRepository;
  sessions: SessionsRepository;
  skills: SkillsRepository;
}

let repositories: Repositories | null = null;

/**
 * Get all repository instances
 */
export function getRepositories(): Repositories {
  if (!repositories) {
    const db = getDatabase();
    repositories = {
      users: new UsersRepository(db),
      sessions: new SessionsRepository(db),
      skills: new SkillsRepository(db)
    };
  }

  return repositories;
}

/**
 * Initialize database and run migrations
 */
let initializing: Promise<void> | null = null;

export async function initializeDatabase(): Promise<void> {
  // Once per process: buildServer() runs it before the route plugins (their
  // runtime DDL must not run ahead of the migrations on a fresh database),
  // and server startup calls it again.
  // B2.2d-17: nothing to do on PostgreSQL (no SQLite file; its schema comes
  // from the PostgreSQL migrations, scripts/pg/migrate-pg.mjs).
  if (dbDriver() === 'postgres') {
    if (storeP3Enabled()) await checkPgLayout();
    return;
  }
  if (!initializing) {
    initializing = getDatabase().initialize().catch((err) => {
      initializing = null;
      throw err;
    });
  }
  return initializing;
}

/**
 * STORE-MAP-01 P3 (OPS2) on PostgreSQL: the same guard as SQLite's. The
 * migrations are applied outside the app (scripts/pg/migrate-pg.mjs), so this
 * only refuses newer data and records the version that opened it.
 */
async function checkPgLayout(): Promise<void> {
  const { q } = await import('../repositories/sql-steps.js');
  const { listPgMigrations } = await import('./pg/migrate.js');
  const { appVersion, newerLayout, unknownMigrations } = await import('./layout.js');
  const known = listPgMigrations().map((m) => m.id);
  const applied = (await q.all<{ id: string }>('SELECT id FROM migrations')).map((r) => String(r.id));
  const unknown = unknownMigrations(applied, known);
  if (unknown.length) {
    const row = await q.one<{ written_by: string | null }>('SELECT written_by FROM schema_layout WHERE id = 1').catch(() => undefined);
    throw newerLayout(unknown, row?.written_by ?? null);
  }
  await q.run(`INSERT INTO schema_layout (id, level, written_by, updated_at) VALUES (1, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET level = excluded.level, written_by = excluded.written_by, updated_at = excluded.updated_at`, [...known].sort().pop() ?? '', appVersion(), new Date().toISOString());
}

// Backward compatibility: Legacy API for sessions and messages.
// B2.2d-8: on the process driver (repositories/chat-sessions.ts), async.

export interface Session {
  id: string;
  title: string | null;
  model: string | null;
  systemPrompt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  model: string | null;
  tokens: number | null;
  createdAt: string;
}

function toSession(s: ChatSession): Session {
  return {
    id: s.id,
    title: s.title,
    model: s.model,
    systemPrompt: s.system_prompt,
    createdAt: s.created_at,
    updatedAt: s.updated_at
  };
}

function toMessage(m: ChatMessage, extra: { model?: string; tokens?: number } = {}): Message {
  return {
    id: m.id,
    sessionId: m.session_id,
    role: m.role,
    content: m.content,
    model: extra.model || null,
    tokens: extra.tokens || null,
    createdAt: m.created_at
  };
}

export const sessionsDb = {
  /** Sessions of one user (S0-Q.11: the caller from the token). */
  async list(userId: string): Promise<Session[]> {
    return (await chatSessions.listUserChatSessions(userId)).map(toSession);
  },

  /** Owner user id of a session, or null if it does not exist. */
  async ownerOf(id: string): Promise<string | null> {
    return (await chatSessions.findChatSession(id))?.user_id ?? null;
  },

  async get(id: string): Promise<Session | null> {
    const session = await chatSessions.findChatSession(id);
    return session ? toSession(session) : null;
  },

  async create(input: { title?: string; model?: string; systemPrompt?: string }, userId: string): Promise<Session> {
    return toSession(await chatSessions.createChatSession({
      user_id: userId,
      title: input.title,
      model: input.model || 'gpt-4',
      system_prompt: input.systemPrompt
    }));
  },

  async update(id: string, input: { title?: string; model?: string }): Promise<Session | null> {
    const session = await chatSessions.updateChatSession(id, { title: input.title, model: input.model });
    return session ? toSession(session) : null;
  },

  async delete(id: string): Promise<boolean> {
    return chatSessions.deleteChatSession(id);
  },

  async touch(id: string): Promise<void> {
    await chatSessions.updateChatSession(id, {});
  }
};

export const messagesDb = {
  async list(sessionId: string): Promise<Message[]> {
    return (await chatSessions.listChatMessages(sessionId)).map((m) => toMessage(m));
  },

  async create(sessionId: string, input: { role: string; content: string; model?: string; tokens?: number }): Promise<Message> {
    const message = await chatSessions.createChatMessage({
      session_id: sessionId,
      role: input.role as ChatMessage['role'],
      content: input.content
    });
    return toMessage(message, input);
  },

  /** Number of messages removed (it always answered 0 before). */
  async clear(sessionId: string): Promise<number> {
    return chatSessions.clearChatMessages(sessionId);
  }
};

// B2.2d-17: no default export. It opened the SQLite file at import time,
// on PostgreSQL too; nothing imported it.
