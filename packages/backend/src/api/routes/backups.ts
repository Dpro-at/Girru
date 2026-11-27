/**
 * Backups (BACKUP-01): Settings › Backups and the workspace_backups MCP tool.
 * Owner only (auth gate tier 'owner' for /api/backups).
 *
 *   GET    /api/backups              status: folder, when it runs, what it keeps, the list
 *   POST   /api/backups              { kind?: 'manual' | 'before-update' } back up now
 *   PUT    /api/backups/folder       { folder } where backups are kept (outside the data folder)
 *   POST   /api/backups/:id/restore  backs up first, then restarts into that backup
 *   POST   /api/backups/:id/show     shows the backup in Finder / Explorer
 *   DELETE /api/backups/:id          deletes one backup
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { execFile } from 'node:child_process';
import { getUserIdFromRequest } from '../../auth/jwt.js';
import { dbDriver } from '../../db/pg/config.js';
import { handleError } from '../error-handler.js';
import { requestRestart } from '../restart-request.js';
import { BackupError, backUpNow, backupStatus, deleteBackup, getBackup, requestRestore, setBackupsFolder, setBackupKeepDays, type BackupKind } from '../../services/backups.js';

const POSTGRES = { available: false, reason: 'On PostgreSQL, back up the database with pg_dump outside the app' };

export async function backupRoutes(fastify: FastifyInstance) {
  const fail = (reply: FastifyReply, err: unknown, what: string) => err instanceof BackupError
    ? reply.code(err.status).send({ error: err.message, code: err.code })
    : handleError(reply, err, 'internal', `[Backups] ${what} failed`);
  const sqliteOnly = (reply: FastifyReply) => { if (dbDriver() === 'postgres') { void reply.code(501).send({ ...POSTGRES, code: 'not_supported_on_postgres' }); return false; } return true; };

  fastify.get('/api/backups', async (request, reply) => {
    try { getUserIdFromRequest(request); return dbDriver() === 'postgres' ? POSTGRES : backupStatus(); } catch (err) { return fail(reply, err, 'Status'); }
  });

  fastify.post<{ Body: { kind?: unknown } | undefined }>('/api/backups', async (request, reply) => {
    try {
      getUserIdFromRequest(request);
      if (!sqliteOnly(reply)) return;
      const asked = request.body?.kind ?? 'manual';
      if (asked !== 'manual' && asked !== 'before-update') return reply.code(400).send({ error: 'kind must be manual or before-update', code: 'invalid_kind' });
      const kind: BackupKind = asked === 'before-update' ? 'before-update' : 'manual';
      return { backup: await backUpNow(kind) };
    } catch (err) { return fail(reply, err, 'Back up'); }
  });

  fastify.put<{ Body: { folder?: unknown } | undefined }>('/api/backups/folder', async (request, reply) => {
    try { getUserIdFromRequest(request); if (!sqliteOnly(reply)) return; return await setBackupsFolder(request.body?.folder); } catch (err) { return fail(reply, err, 'Folder'); }
  });

  fastify.put<{ Body: { keepDays?: unknown } | undefined }>('/api/backups/retention', async (request, reply) => {
    try { getUserIdFromRequest(request); if (!sqliteOnly(reply)) return; return await setBackupKeepDays(request.body?.keepDays); } catch (err) { return fail(reply, err, 'Retention'); }
  });

  fastify.post<{ Params: { id: string } }>('/api/backups/:id/restore', async (request, reply) => {
    try {
      getUserIdFromRequest(request);
      if (!sqliteOnly(reply)) return;
      const { undoId } = await requestRestore(request.params.id);
      return { restarting: requestRestart(), undoId };
    } catch (err) { return fail(reply, err, 'Restore'); }
  });

  fastify.post<{ Params: { id: string } }>('/api/backups/:id/show', async (request, reply) => {
    try {
      getUserIdFromRequest(request);
      const { dir } = getBackup(request.params.id);
      const [cmd, args] = process.platform === 'darwin' ? ['open', ['-R', dir]] : process.platform === 'win32' ? ['explorer', [dir]] : ['xdg-open', [dir]];
      execFile(cmd, args as string[], () => { /* nothing to report */ });
      return { shown: true };
    } catch (err) { return fail(reply, err, 'Show'); }
  });

  fastify.delete<{ Params: { id: string } }>('/api/backups/:id', async (request, reply) => {
    try { getUserIdFromRequest(request); deleteBackup(request.params.id); return { deleted: true }; } catch (err) { return fail(reply, err, 'Delete'); }
  });
}
