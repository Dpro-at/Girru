/**
 * Dashboard API Routes
 * Manages customizable dashboard layouts and widgets
 *
 * B2.2c: every query runs on the process driver (sql-steps); SQLite SQL and
 * response shapes unchanged. Saving a layout is one transaction.
 */

import type { FastifyInstance } from 'fastify';
import { num, q, run, sql } from '../../repositories/sql-steps.js';
import { getUserIdFromRequest } from '../../auth/jwt.js';
import { randomUUID } from 'crypto';
import { handleError } from '../error-handler.js';

export async function registerDashboardRoutes(fastify: FastifyInstance) {
  // ── Widget Management ──

  /**
   * GET /api/dashboard/widgets
   * List all available dashboard widgets (system + extensions)
   */
  fastify.get('/api/dashboard/widgets', async (request, reply) => {
    const widgets = await q.all(`
      SELECT * FROM dashboard_widgets
      ORDER BY category, name
    `);

    return { widgets };
  });

  /**
   * GET /api/dashboard/widgets/:id
   * Get single widget details
   */
  fastify.get('/api/dashboard/widgets/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const widget = await q.one('SELECT * FROM dashboard_widgets WHERE id = ?', id);

    if (!widget) {
      return reply.code(404).send({ error: 'Widget not found' });
    }

    return widget;
  });

  // ── Layout Management ──

  /**
   * GET /api/dashboard/layout
   * Get user's active dashboard layout
   */
  fastify.get('/api/dashboard/layout', async (request, reply) => {
    try {
      const userId = getUserIdFromRequest(request);

      const layout = await q.one(`
        SELECT * FROM user_dashboard_layouts
        WHERE user_id = ? AND is_active = 1
        ORDER BY updated_at DESC
        LIMIT 1
      `, userId) as { widgets: string } | undefined;

      if (!layout) {
        // Return empty layout if none exists
        return { widgets: [] };
      }

      return { widgets: JSON.parse(layout.widgets) };
    } catch (error: any) {
      if (error.message?.includes('Unauthorized')) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Dashboard] Get layout failed');
    }
  });

  /**
   * PUT /api/dashboard/layout
   * Save/update user's dashboard layout
   */
  fastify.put('/api/dashboard/layout', async (request, reply) => {
    try {
      const userId = getUserIdFromRequest(request);
      const { widgets } = request.body as { widgets: any[] };

      if (!Array.isArray(widgets)) {
        return reply.code(400).send({ error: 'widgets must be an array' });
      }

      // One transaction: deactivate all existing layouts, create the new one.
      await sql().tx(function* () {
        yield* run('UPDATE user_dashboard_layouts SET is_active = 0 WHERE user_id = ?', userId);
        yield* run(`
        INSERT INTO user_dashboard_layouts (id, user_id, widgets, is_active)
        VALUES (?, ?, ?, 1)
      `, randomUUID(), userId, JSON.stringify(widgets));
      });

      return { success: true };
    } catch (error: any) {
      if (error.message?.includes('Unauthorized')) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Dashboard] Save layout failed');
    }
  });

  /**
   * DELETE /api/dashboard/layout
   * Reset dashboard to default (remove user layout)
   */
  fastify.delete('/api/dashboard/layout', async (request, reply) => {
    try {
      const userId = getUserIdFromRequest(request);

      await q.run('DELETE FROM user_dashboard_layouts WHERE user_id = ?', userId);

      return { success: true };
    } catch (error: any) {
      if (error.message?.includes('Unauthorized')) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Dashboard] Reset layout failed');
    }
  });

  // ── Widget Data Endpoints ──

  /**
   * GET /api/dashboard/widgets/quick-stats
   * Quick stats widget: Tasks, Agents, Workflows count
   */
  fastify.get('/api/dashboard/widgets/quick-stats', async (request, reply) => {
    // Helper to safely get count from a table
    const safeCount = async (query: string, params?: any): Promise<number> => {
      try {
        const result = params
          ? await q.one(query, params) as { count: number }
          : await q.one(query) as { count: number };
        return result?.count || 0;
      } catch (err) {
        // Table might not exist yet
        return 0;
      }
    };

    const tasksCount = await safeCount('SELECT COUNT(*) as count FROM tasks');
    const agentsCount = await safeCount('SELECT COUNT(*) as count FROM agents_config');
    const workflowsCount = await safeCount('SELECT COUNT(*) as count FROM workflows');
    const activeWorkflows = await safeCount('SELECT COUNT(*) as count FROM workflow_executions WHERE status = ?', 'running');

    return {
      stats: [
        { label: 'Total Tasks', value: tasksCount, icon: 'list-todo', color: 'blue' },
        { label: 'Active Agents', value: agentsCount, icon: 'bot', color: 'green' },
        { label: 'Workflows', value: workflowsCount, icon: 'workflow', color: 'purple' },
        { label: 'Running', value: activeWorkflows, icon: 'play-circle', color: 'orange' },
      ],
    };
  });

  /**
   * GET /api/dashboard/widgets/task-overview
   * Task breakdown by status (pie chart)
   */
  fastify.get('/api/dashboard/widgets/task-overview', async (request, reply) => {
    const statuses = await q.all(`
      SELECT status, COUNT(*) as count
      FROM tasks
      GROUP BY status
    `) as Array<{ status: string; count: number }>;

    return {
      chart: {
        type: 'pie',
        data: statuses.map(s => ({ label: s.status, value: s.count })),
      },
    };
  });

  /**
   * GET /api/dashboard/widgets/agent-performance
   * Agent activity chart (bar chart)
   */
  fastify.get('/api/dashboard/widgets/agent-performance', async (request, reply) => {
    const agents = await q.all(`
      SELECT ac.name, COUNT(aa.id) as activity_count
      FROM agents_config ac
      LEFT JOIN agent_activity aa ON aa.agent_id = ac.id
      GROUP BY ac.id, ac.name
      ORDER BY activity_count DESC
      LIMIT 10
    `) as Array<{ name: string; activity_count: number }>;

    return {
      chart: {
        type: 'bar',
        data: agents.map(a => ({ label: a.name, value: a.activity_count })),
      },
    };
  });

  /**
   * GET /api/dashboard/widgets/storage-usage
   * Storage breakdown by zone (pie chart)
   */
  fastify.get('/api/dashboard/widgets/storage-usage', async (request, reply) => {
    const zones = await q.all(`
      SELECT zone, SUM(size_bytes) as total_size
      FROM storage_files
      GROUP BY zone
    `) as Array<{ zone: string; total_size: number }>;

    const formatSize = (bytes: number) => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
      if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
      return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    };

    return {
      chart: {
        type: 'pie',
        // SUM is numeric (text) on PostgreSQL: a number on both drivers.
        data: zones.map(z => ({
          label: `${z.zone} (${formatSize(num(z.total_size))})`,
          value: num(z.total_size),
        })),
      },
    };
  });

  /**
   * GET /api/dashboard/widgets/recent-activity
   * Latest 10 system actions (list)
   */
  fastify.get('/api/dashboard/widgets/recent-activity', async (request, reply) => {
    const activities = await q.all(`
      SELECT
        id,
        agent_id,
        action_type,
        summary,
        created_at
      FROM agent_activity
      ORDER BY created_at DESC
      LIMIT 10
    `) as Array<{
      id: string;
      agent_id: string;
      action_type: string;
      summary: string;
      created_at: string;
    }>;

    return {
      items: activities.map(a => ({
        id: a.id,
        title: a.action_type,
        description: a.summary || '',
        timestamp: a.created_at,
        icon: 'activity',
      })),
    };
  });

  /**
   * GET /api/dashboard/widgets/workflow-status
   * Active workflows (list)
   */
  fastify.get('/api/dashboard/widgets/workflow-status', async (request, reply) => {
    const workflows = await q.all(`
      SELECT
        we.id,
        w.name,
        we.status,
        we.started_at,
        we.completed_at
      FROM workflow_executions we
      JOIN workflows w ON w.id = we.workflow_id
      WHERE we.status = 'running'
      ORDER BY we.started_at DESC
      LIMIT 10
    `) as Array<{
      id: string;
      name: string;
      status: string;
      started_at: string;
      completed_at: string | null;
    }>;

    return {
      items: workflows.map(w => ({
        id: w.id,
        title: w.name,
        status: w.status,
        timestamp: w.started_at,
        icon: 'workflow',
      })),
    };
  });

  /**
   * GET /api/dashboard/widgets/notifications
   * Recent 5 notifications (list)
   */
  fastify.get('/api/dashboard/widgets/notifications', async (request, reply) => {
    try {
      const userId = getUserIdFromRequest(request);

      const notifications = await q.all(`
        SELECT id, type, title, message, created_at, is_read
        FROM notifications
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 5
      `, userId) as Array<{
        id: string;
        type: string;
        title: string;
        message: string;
        created_at: string;
        is_read: number;
      }>;

      return {
        items: notifications.map(n => ({
          id: n.id,
          title: n.title,
          description: n.message,
          timestamp: n.created_at,
          icon: 'bell',
          isRead: Boolean(n.is_read),
        })),
      };
    } catch (error: any) {
      if (error.message?.includes('Unauthorized')) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Dashboard] Get notifications failed');
    }
  });

  /**
   * GET /api/dashboard/widgets/team-members
   * Active team members (table)
   */
  fastify.get('/api/dashboard/widgets/team-members', async (request, reply) => {
    const members = await q.all(`
      SELECT id, name, email, created_at
      FROM users
      ORDER BY created_at DESC
      LIMIT 10
    `) as Array<{
      id: string;
      name: string;
      email: string;
      created_at: string;
    }>;

    return {
      columns: ['Name', 'Email', 'Joined'],
      rows: members.map(m => [m.name, m.email, m.created_at.split('T')[0]]),
    };
  });

  /**
   * GET /api/dashboard/widgets/ai-usage
   * AI API usage stats (stats widget)
   */
  fastify.get('/api/dashboard/widgets/ai-usage', async (request, reply) => {
    // TODO: Implement AI usage tracking when implemented
    return {
      stats: [
        { label: 'API Calls Today', value: 0, icon: 'cpu', color: 'blue' },
        { label: 'Tokens Used', value: 0, icon: 'zap', color: 'yellow' },
      ],
    };
  });
}
