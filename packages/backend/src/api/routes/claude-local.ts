import {readRegularFile} from '../../services/read-regular-file.js';
import {assertNoProtectedDatabaseAlias} from '../../memory/encryption/protected-filesystem.js';
import type { FastifyInstance } from 'fastify';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { textTimestamp } from '../../db/pg/dialect.js';
import { orderedId } from '../../repositories/ordered-id.js';
import { run, sql } from '../../repositories/sql-steps.js';
import { sendInternalError } from '../error-handler.js';
import { safeErrorFields } from '../../services/safe-error-log.js';
import { getClaudeDir, claudeDirExists, cwdToSlug, findMemoryForCwd, loadClaudeProjectMemory } from '../../agent/context/project-memory.js';
export * from '../../agent/context/project-memory.js';

export async function claudeLocalRoutes(fastify: FastifyInstance): Promise<void> {

  // ── GET /api/claude-local/status ──────────────────────────────────────────
  fastify.get('/api/claude-local/status', async (_req, reply) => {
    const available = await claudeDirExists();
    return reply.send({
      available,
      path: available ? getClaudeDir() : null,
    });
  });

  // ── GET /api/claude-local/stats ───────────────────────────────────────────
  fastify.get('/api/claude-local/stats', async (_req, reply) => {
    if (!(await claudeDirExists())) return reply.send({ available: false });

    try {
      const statsPath = path.join(getClaudeDir(), 'stats-cache.json');
      assertNoProtectedDatabaseAlias(statsPath);
      const raw = (await readRegularFile(statsPath,8*1024*1024)).data.toString('utf8');
      const stats = JSON.parse(raw);
      return reply.send({ available: true, stats });
    } catch (err: any) {
      console.error('[ClaudeLocal] GET /api/claude-local/stats failed', safeErrorFields(err));
      return reply.send({ available: false, error: 'Stats could not be read' });
    }
  });

  // ── GET /api/claude-local/memory ──────────────────────────────────────────
  fastify.get('/api/claude-local/memory', async (_req, reply) => {
    if (!(await claudeDirExists())) return reply.send({ available: false });

    const content = await findMemoryForCwd(process.cwd());
    if (!content) return reply.send({ available: false });

    return reply.send({ available: true, content });
  });

  // ── GET /api/claude-local/sessions ────────────────────────────────────────
  fastify.get('/api/claude-local/sessions', async (_req, reply) => {
    if (!(await claudeDirExists())) return reply.send({ available: false });

    try {
      const projectsDir = path.join(getClaudeDir(), 'projects');
      const slugs = await fs.readdir(projectsDir).catch(() => [] as string[]);

      const projects = await Promise.all(
        slugs.map(async (slug) => {
          const dir = path.join(projectsDir, slug);
          let stat;
          try { stat = await fs.stat(dir); } catch { return null; }
          if (!stat.isDirectory()) return null;

          // Count .jsonl session files
          const entries = await fs.readdir(dir).catch(() => [] as string[]);
          const sessions = entries.filter((e) => e.endsWith('.jsonl'));

          // Find most recent session date
          let lastModified: Date | null = null;
          for (const s of sessions) {
            try {
              const st = await fs.stat(path.join(dir, s));
              if (!lastModified || st.mtime > lastModified) {
                lastModified = st.mtime;
              }
            } catch { /* skip */ }
          }

          // Check if memory file exists
          const hasMemory = await fs.access(path.join(dir, 'memory', 'MEMORY.md'))
            .then(() => true).catch(() => false);

          return {
            slug,
            sessionCount: sessions.length,
            lastModified: lastModified?.toISOString() ?? null,
            hasMemory,
          };
        })
      );

      return reply.send({
        available: true,
        projects: projects.filter(Boolean),
      });
    } catch (err: any) {
      return sendInternalError(reply, '[ClaudeLocal] GET /api/claude-local/sessions', err);
    }
  });

  // ── GET /api/claude-local/sessions/:slug ──────────────────────────────────
  fastify.get<{ Params: { slug: string } }>(
    '/api/claude-local/sessions/:slug',
    async (req, reply) => {
      if (!(await claudeDirExists())) return reply.send({ available: false });

      const { slug } = req.params;
      // Validate slug — no path traversal
      if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
        return reply.status(400).send({ error: 'Invalid slug' });
      }

      const dir = path.join(getClaudeDir(), 'projects', slug);
      const entries = await fs.readdir(dir).catch(() => null);
      if (!entries) return reply.status(404).send({ error: 'Project not found' });

      const sessions = await Promise.all(
        entries
          .filter((e) => e.endsWith('.jsonl'))
          .map(async (filename) => {
            const filePath = path.join(dir, filename);
            const stat = await fs.stat(filePath).catch(() => null);
            return {
              id: filename.replace('.jsonl', ''),
              filename,
              size: stat?.size ?? 0,
              lastModified: stat?.mtime.toISOString() ?? null,
            };
          })
      );

      // Sort newest first
      sessions.sort((a, b) =>
        (b.lastModified ?? '').localeCompare(a.lastModified ?? '')
      );

      return reply.send({ available: true, slug, sessions });
    }
  );

  // ── GET /api/claude-local/session/:slug/:id ───────────────────────────────
  fastify.get<{ Params: { slug: string; id: string } }>(
    '/api/claude-local/session/:slug/:id',
    async (req, reply) => {
      if (!(await claudeDirExists())) return reply.send({ available: false });

      const { slug, id } = req.params;
      if (slug.includes('..') || id.includes('..')) {
        return reply.status(400).send({ error: 'Invalid path' });
      }

      const filePath = path.join(getClaudeDir(), 'projects', slug, `${id}.jsonl`);
      try {
        assertNoProtectedDatabaseAlias(filePath);
      const raw = (await readRegularFile(filePath,32*1024*1024)).data.toString('utf8');
        // Parse each line as JSON
        const messages = raw
          .split('\n')
          .filter((l) => l.trim())
          .map((line) => {
            try { return JSON.parse(line); }
            catch { return null; }
          })
          .filter(Boolean);

        return reply.send({ available: true, slug, id, messages });
      } catch (err: any) {
        return reply.status(404).send({ error: 'Session not found' });
      }
    }
  );

  // ── GET /api/claude-local/plans ───────────────────────────────────────────
  fastify.get('/api/claude-local/plans', async (_req, reply) => {
    if (!(await claudeDirExists())) return reply.send({ available: false });

    try {
      const plansDir = path.join(getClaudeDir(), 'plans');
      const entries = await fs.readdir(plansDir).catch(() => [] as string[]);
      const mdFiles = entries.filter((e) => e.endsWith('.md'));

      const plans = await Promise.all(
        mdFiles.map(async (filename) => {
          const filePath = path.join(plansDir, filename);
          const stat = await fs.stat(filePath).catch(() => null);
          return {
            name: filename,
            size: stat?.size ?? 0,
            lastModified: stat?.mtime.toISOString() ?? null,
          };
        })
      );

      // Sort newest first
      plans.sort((a, b) =>
        (b.lastModified ?? '').localeCompare(a.lastModified ?? '')
      );

      return reply.send({ available: true, plans });
    } catch (err: any) {
      return sendInternalError(reply, '[ClaudeLocal] GET /api/claude-local/plans', err);
    }
  });

  // ── GET /api/claude-local/plans/:name ─────────────────────────────────────
  fastify.get<{ Params: { name: string } }>(
    '/api/claude-local/plans/:name',
    async (req, reply) => {
      if (!(await claudeDirExists())) return reply.send({ available: false });

      const { name } = req.params;
      if (!name.endsWith('.md') || name.includes('..') || name.includes('/')) {
        return reply.status(400).send({ error: 'Invalid plan name' });
      }

      try {
        const filePath = path.join(getClaudeDir(), 'plans', name);
        assertNoProtectedDatabaseAlias(filePath);
        const content = (await readRegularFile(filePath,32*1024*1024)).data.toString('utf8');
        return reply.send({ available: true, name, content });
      } catch {
        return reply.status(404).send({ error: 'Plan not found' });
      }
    }
  );

  // ── POST /api/claude-local/import/:slug/:id ───────────────────────────────
  // Import a Claude Code session into Girru's chat_sessions + chat_messages tables.
  // Returns the new sessionId so the frontend can navigate to /chat.
  fastify.post<{ Params: { slug: string; id: string } }>(
    '/api/claude-local/import/:slug/:id',
    async (req, reply) => {
      if (!(await claudeDirExists())) {
        return reply.status(404).send({ error: 'Claude Code not found' });
      }

      const { slug, id } = req.params;
      if (slug.includes('..') || id.includes('..')) {
        return reply.status(400).send({ error: 'Invalid path' });
      }

      // Read and parse .jsonl file
      const filePath = path.join(getClaudeDir(), 'projects', slug, `${id}.jsonl`);
      let raw: string;
      try {
        assertNoProtectedDatabaseAlias(filePath);
        raw = (await readRegularFile(filePath,32*1024*1024)).data.toString('utf8');
      } catch {
        return reply.status(404).send({ error: 'Session not found' });
      }

      // Parse each line as JSON and extract user/assistant messages
      const lines = raw.split('\n').filter((l) => l.trim());
      const importedMessages: Array<{ role: 'user' | 'assistant'; content: string; ts: string }> = [];

      for (const line of lines) {
        let obj: any;
        try { obj = JSON.parse(line); } catch { continue; }

        // Claude Code uses different formats across versions — handle all
        const msg = obj.message ?? obj;
        const role: string = msg.role ?? obj.type ?? '';
        if (role !== 'user' && role !== 'assistant') continue;

        let content = '';
        if (typeof msg.content === 'string') {
          content = msg.content;
        } else if (Array.isArray(msg.content)) {
          content = msg.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text ?? '')
            .join('\n')
            .trim();
        }

        if (!content) continue;

        // The file's timestamp when it parses, else now; stored in the
        // 'YYYY-MM-DD HH:MM:SS' UTC form that CURRENT_TIMESTAMP rows use
        // (SQLite compares it as text; PostgreSQL casts it to timestamptz).
        const parsed = Date.parse(String(obj.timestamp ?? obj.created_at ?? ''));
        const ts = textTimestamp(Number.isFinite(parsed) ? parsed : Date.now());
        importedMessages.push({ role: role as 'user' | 'assistant', content, ts });
      }

      if (importedMessages.length === 0) {
        return reply.status(400).send({ error: 'No readable messages in this session' });
      }

      // Build a title from the first user message
      const firstUserMsg = importedMessages.find((m) => m.role === 'user');
      const title = firstUserMsg
        ? `[Claude Code] ${firstUserMsg.content.slice(0, 60)}${firstUserMsg.content.length > 60 ? '…' : ''}`
        : `[Claude Code] ${slug}`;

      // Insert into Girru's database (process driver, one transaction).
      // B2.2d-9: the session belongs to the signed-in owner (the auth gate
      // allows owners only here); it used a fixed 'default' user, which the
      // owner-scoped sessions API never shows and the users FK refuses.
      const ownerId = (req as any).authUser?.id as string | undefined;
      if (!ownerId) return reply.status(401).send({ error: 'Authentication required' });
      const sessionId = uuidv4();
      const now = textTimestamp(Date.now());

      try {
        await sql().tx(function* () {
          yield* run(`
            INSERT INTO chat_sessions (id, user_id, title, model, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
            sessionId, ownerId, title, 'claude-sonnet-4-5-20250929', now, now);

          // Messages keep their original timestamps; time-ordered ids keep
          // the file order for equal timestamps.
          for (const m of importedMessages) {
            yield* run(`
              INSERT INTO chat_messages (id, session_id, role, content, created_at)
              VALUES (?, ?, ?, ?, ?)`,
              orderedId(), sessionId, m.role, m.content, m.ts);
          }
        });

        fastify.log.info(`[ClaudeLocal] Imported ${importedMessages.length} messages as session ${sessionId}`);
        return reply.send({
          success: true,
          sessionId,
          title,
          messageCount: importedMessages.length,
        });
      } catch (err: any) {
        return sendInternalError(reply, '[ClaudeLocal] POST /api/claude-local/import/:slug/:id', err);
      }
    }
  );
}
