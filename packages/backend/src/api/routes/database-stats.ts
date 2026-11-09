import {createUnprotectedReadStream,assertMemoryFilesystemAccess,assertNoRawProtectedMemoryCopy} from '../../memory/encryption/protected-filesystem.js';
/**
 * Database Statistics API
 * Provides real-time statistics about the database
 *
 * B2.2c: the stats and the health check run on the process driver (the
 * table check is tableExists from sql-steps; on PostgreSQL the size is
 * pg_database_size). Vacuum and the file backup are SQLite only: refused on
 * PostgreSQL with 501 { code: 'not_supported_on_postgres' } (pg_dump outside
 * the app).
 */

import { dataPath, mainDatabasePath } from '../../config/data-root.js';
import { FastifyInstance } from 'fastify';
import { getDatabase } from '../../db/index.js';
import { dbDriver } from '../../db/pg/config.js';
import { num, q, sql, tableExists } from '../../repositories/sql-steps.js';
import { NOT_SUPPORTED_ON_POSTGRES } from './database.js';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { handleError } from '../error-handler.js';

// Use the same path logic as the database module
const DATABASE_PATH = mainDatabasePath();

interface TableStats {
    name: string;
    description: string;
    records: number;
    size: number; // in bytes
}

interface DatabaseStats {
    totalSize: number; // in bytes
    totalRecords: number;
    tables: TableStats[];
    lastModified: string;
}

export async function databaseStatsRoutes(fastify: FastifyInstance) {
    // Get database statistics
    fastify.get('/api/database/stats', async (request, reply) => {
        try {
            const onPg = dbDriver() === 'postgres';

            // Get database file size
            const dbPath = DATABASE_PATH;
            let totalSize = 0;
            let lastModified = new Date().toISOString();

            if (onPg) {
                totalSize = num<number>((await q.one('SELECT pg_database_size(current_database()) AS size'))?.size) ?? 0;
            } else if (existsSync(dbPath)) {
                const stats = statSync(dbPath);
                totalSize = stats.size;
                lastModified = stats.mtime.toISOString();
            }

            // Get table statistics
            const tables: TableStats[] = [];
            let totalRecords = 0;

            // Define tables with descriptions
            const tableDefinitions = [
                { name: 'chat_messages', description: 'Chat history and conversations' },
                { name: 'chat_sessions', description: 'Chat session metadata' },
                { name: 'users', description: 'User accounts and profiles' },
                { name: 'teams', description: 'Team organizations' },
                { name: 'skills', description: 'Installed skills and configurations' },
                { name: 'skill_secrets', description: 'Encrypted skill secrets' },
                { name: 'workflows', description: 'Saved workflows and automation' },
                { name: 'workflow_executions', description: 'Workflow execution history' },
                { name: 'memory_entries', description: 'Agent memory and context storage' },
                { name: 'scheduled_jobs', description: 'Scheduled automation jobs' },
                { name: 'cron_jobs', description: 'Cron-based scheduled tasks' },
                { name: 'gateway_sessions', description: 'Multi-channel gateway sessions' },
                { name: 'credentials', description: 'Encrypted API keys and secrets' },
            ];

            for (const tableDef of tableDefinitions) {
                try {
                    // Check if table exists
                    const tableCheck = await sql().read(tableExists(tableDef.name));

                    if (!tableCheck) continue;

                    // Get record count
                    const countResult = await q.one(
                        `SELECT COUNT(*) as count FROM ${tableDef.name}`
                    ) as { count: number };

                    const count = countResult?.count || 0;
                    totalRecords += count;

                    // Estimate table size (SQLite doesn't provide per-table size easily)
                    // We'll use a rough estimate based on record count
                    const estimatedSize = count * 1024; // Rough estimate: 1KB per record

                    tables.push({
                        name: tableDef.name,
                        description: tableDef.description,
                        records: count,
                        size: estimatedSize,
                    });
                } catch (error) {
                    console.error(`Error getting stats for table ${tableDef.name}:`, error);
                    // Skip tables that don't exist or have errors
                }
            }

            // Sort tables by record count (descending)
            tables.sort((a, b) => b.records - a.records);

            const response: DatabaseStats = {
                totalSize,
                totalRecords,
                tables,
                lastModified,
            };

            return reply.send(response);
        } catch (error: any) {
            console.error('Error fetching database stats:', error);
            // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
            return handleError(reply, error, 'internal', '[Database Stats] Get stats failed');
        }
    });

    // Get database health check
    fastify.get('/api/database/health', async (request, reply) => {
        try {
            // Run a simple query to check database connection (process driver)
            const result = await q.one('SELECT 1 as test');

            return reply.send({
                status: 'healthy',
                connected: true,
                message: 'Database connection is working',
            });
        } catch (error: any) {
            // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
            return handleError(reply, error, 'internal', '[Database Stats] Health check failed');
        }
    });

    // Vacuum database (optimize)
    fastify.post('/api/database/vacuum', async (request, reply) => {
        try {
            if (dbDriver() === 'postgres') return reply.status(501).send(NOT_SUPPORTED_ON_POSTGRES);
            const db = getDatabase();
            db.getDb().exec('VACUUM');

            return reply.send({
                success: true,
                message: 'Database vacuumed successfully',
            });
        } catch (error: any) {
            // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
            return handleError(reply, error, 'internal', '[Database Stats] Operation failed');
        }
    });

    // Create backup
    fastify.post('/api/database/backup', async (request, reply) => {
        assertNoRawProtectedMemoryCopy();
        try {
            if (dbDriver() === 'postgres') return reply.status(501).send(NOT_SUPPORTED_ON_POSTGRES);
            const { copyFileSync, mkdirSync } = await import('fs');
            const { join } = await import('path');

            const dbPath = DATABASE_PATH;
            const backupsDir = dataPath('backups');

            // Create backups directory if it doesn't exist
            if (!existsSync(backupsDir)) {
                mkdirSync(backupsDir, { recursive: true });
            }

            // Generate backup filename with timestamp
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupFilename = `backup_${timestamp}.db`;
            const backupPath = join(backupsDir, backupFilename);

            // Copy database file
            copyFileSync(dbPath, backupPath);

            const stats = statSync(backupPath);

            return reply.send({
                success: true,
                message: 'Backup created successfully',
                backup: {
                    filename: backupFilename,
                    size: stats.size,
                    created: stats.mtime.toISOString(),
                },
            });
        } catch (error: any) {
            console.error('Backup error:', error);
            // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
            return handleError(reply, error, 'internal', '[Database Stats] Backup failed');
        }
    });

    // List backups
    fastify.get('/api/database/backups', async (request, reply) => {
        try {
            const { readdirSync } = await import('fs');
            const { join } = await import('path');

            const backupsDir = dataPath('backups');

            if (!existsSync(backupsDir)) {
                return reply.send({ backups: [] });
            }

            const files = readdirSync(backupsDir);
            const backups = files
                .filter(file => file.endsWith('.db'))
                .map(file => {
                    const filePath = join(backupsDir, file);
                    const stats = statSync(filePath);
                    return {
                        filename: file,
                        size: stats.size,
                        created: stats.mtime.toISOString(),
                    };
                })
                .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());

            return reply.send({ backups });
        } catch (error: any) {
            // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
            return handleError(reply, error, 'internal', '[Database Stats] Operation failed');
        }
    });

    // Download backup
    fastify.get('/api/database/backups/:filename', async (request, reply) => {
        try {
            const { filename } = request.params as { filename: string };
            const { join } = await import('path');
            const { createReadStream } = await import('fs');

            // Validate filename (security)
            if (!filename.match(/^backup_[\w-]+\.db$/)) {
                return reply.status(400).send({ error: 'Invalid filename' });
            }

            const backupPath = dataPath('backups', filename);

            if (!existsSync(backupPath)) {
                return reply.status(404).send({ error: 'Backup not found' });
            }

            const stats = statSync(backupPath);
            assertMemoryFilesystemAccess(backupPath);
            const stream = createUnprotectedReadStream(backupPath);

            reply.header('Content-Type', 'application/octet-stream');
            reply.header('Content-Disposition', `attachment; filename="${filename}"`);
            reply.header('Content-Length', stats.size);

            return reply.send(stream);
        } catch (error: any) {
            // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
            return handleError(reply, error, 'internal', '[Database Stats] Operation failed');
        }
    });

    // Delete backup
    fastify.delete('/api/database/backups/:filename', async (request, reply) => {
        try {
            const { filename } = request.params as { filename: string };
            const { unlinkSync } = await import('fs');
            const { join } = await import('path');

            // Validate filename (security)
            if (!filename.match(/^backup_[\w-]+\.db$/)) {
                return reply.status(400).send({ error: 'Invalid filename' });
            }

            const backupPath = dataPath('backups', filename);

            if (!existsSync(backupPath)) {
                return reply.status(404).send({ error: 'Backup not found' });
            }

            unlinkSync(backupPath);

            return reply.send({
                success: true,
                message: 'Backup deleted successfully',
            });
        } catch (error: any) {
            // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
            return handleError(reply, error, 'internal', '[Database Stats] Operation failed');
        }
    });

    console.log('[Database Stats API] ✅ Routes registered');
}
