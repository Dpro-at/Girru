/**
 * Provider Management Routes
 * APIs for managing telephony providers (Twilio, Microsoft Teams, Vonage, etc.)
 * Fastify routes - NOT Express
 */

import { getDatabase } from '../../../../../../src/db/index.js';

/**
 * Register provider management routes under /api/ext/call-center/providers/
 */
export async function registerProviderRoutes(fastify) {
  const db = getDatabase();

  /**
   * GET /api/ext/call-center/providers
   * List all telephony providers
   */
  fastify.get('/providers', async (request, reply) => {
    try {
      const providers = db
        .prepare(
          `
        SELECT
          id, provider_name, display_name, enabled, is_default,
          config, pricing_info, capabilities, status,
          health_status, last_health_check, created_at, updated_at
        FROM telephony_providers
        ORDER BY is_default DESC, display_name ASC
      `
        )
        .all();

      return { success: true, providers };
    } catch (error) {
      fastify.log.error('[Providers] Error listing providers:', error);
      return reply.status(500).send({ error: 'Failed to list providers', message: error.message });
    }
  });

  /**
   * GET /api/ext/call-center/providers/:id
   * Get single provider details
   */
  fastify.get('/providers/:id', async (request, reply) => {
    try {
      const { id } = request.params;

      const provider = db
        .prepare(
          `
        SELECT *
        FROM telephony_providers
        WHERE id = ?
      `
        )
        .get(id);

      if (!provider) {
        return reply.status(404).send({ error: 'Provider not found' });
      }

      return { success: true, provider };
    } catch (error) {
      fastify.log.error('[Providers] Error getting provider:', error);
      return reply.status(500).send({ error: 'Failed to get provider', message: error.message });
    }
  });

  /**
   * POST /api/ext/call-center/providers/:id/toggle
   * Enable/disable provider
   */
  fastify.post('/providers/:id/toggle', async (request, reply) => {
    try {
      const { id } = request.params;
      const { enabled } = request.body;

      db.prepare(
        `
        UPDATE telephony_providers
        SET enabled = ?, updated_at = datetime('now')
        WHERE id = ?
      `
      ).run(enabled ? 1 : 0, id);

      return { success: true, message: `Provider ${enabled ? 'enabled' : 'disabled'}` };
    } catch (error) {
      fastify.log.error('[Providers] Error toggling provider:', error);
      return reply.status(500).send({ error: 'Failed to toggle provider', message: error.message });
    }
  });

  /**
   * POST /api/ext/call-center/providers/:id/default
   * Set provider as default
   */
  fastify.post('/providers/:id/default', async (request, reply) => {
    try {
      const { id } = request.params;

      // First, unset all defaults
      db.prepare(
        `
        UPDATE telephony_providers
        SET is_default = 0, updated_at = datetime('now')
      `
      ).run();

      // Then set this one as default
      db.prepare(
        `
        UPDATE telephony_providers
        SET is_default = 1, enabled = 1, updated_at = datetime('now')
        WHERE id = ?
      `
      ).run(id);

      return { success: true, message: 'Default provider updated' };
    } catch (error) {
      fastify.log.error('[Providers] Error setting default provider:', error);
      return reply.status(500).send({ error: 'Failed to set default provider', message: error.message });
    }
  });

  /**
   * GET /api/ext/call-center/providers/:id/health-check
   * Perform health check on provider
   */
  fastify.get('/providers/:id/health-check', async (request, reply) => {
    try {
      const { id } = request.params;

      const provider = db
        .prepare('SELECT provider_name FROM telephony_providers WHERE id = ?')
        .get(id);

      if (!provider) {
        return reply.status(404).send({ error: 'Provider not found' });
      }

      // Perform health check (simplified - actual implementation would test API connectivity)
      const startTime = Date.now();
      let health_status = 'healthy';
      let error_message = null;

      try {
        // TODO: Implement actual provider connectivity test
        // For now, just simulate a delay
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Check if provider has credentials configured
        const { getCredentialStorage } = await import('../../../../../../src/credentials/index.js');
        const credStorage = getCredentialStorage();

        if (provider.provider_name === 'twilio') {
          const sid = await credStorage.get('telephony.twilio.account_sid');
          if (!sid) {
            health_status = 'degraded';
            error_message = 'Credentials not configured';
          }
        } else if (provider.provider_name === 'microsoft_teams') {
          const tenantId = await credStorage.get('telephony.teams.tenant_id');
          if (!tenantId) {
            health_status = 'degraded';
            error_message = 'Credentials not configured';
          }
        } else if (provider.provider_name === 'vonage') {
          const apiKey = await credStorage.get('telephony.vonage.api_key');
          if (!apiKey) {
            health_status = 'degraded';
            error_message = 'Credentials not configured';
          }
        }
      } catch (err) {
        health_status = 'down';
        error_message = err.message;
      }

      const response_time_ms = Date.now() - startTime;

      // Update health status in database
      db.prepare(
        `
        UPDATE telephony_providers
        SET health_status = ?, last_health_check = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `
      ).run(health_status, id);

      // Log health check
      db.prepare(
        `
        INSERT INTO provider_health_log (
          provider_id, check_type, status, response_time_ms, error_message
        ) VALUES (?, 'api', ?, ?, ?)
      `
      ).run(
        id,
        health_status === 'healthy' ? 'success' : 'failure',
        response_time_ms,
        error_message
      );

      return {
        success: true,
        health_status,
        response_time_ms,
        message: error_message || 'Provider is healthy',
      };
    } catch (error) {
      fastify.log.error('[Providers] Error checking health:', error);
      return reply.status(500).send({ error: 'Health check failed', message: error.message });
    }
  });

  /**
   * GET /api/ext/call-center/providers/:id/stats
   * Get provider usage statistics
   */
  fastify.get('/providers/:id/stats', async (request, reply) => {
    try {
      const { id } = request.params;
      const { days = 30 } = request.query;

      const stats = db
        .prepare(
          `
        SELECT
          date,
          total_calls,
          successful_calls,
          failed_calls,
          total_minutes,
          estimated_cost
        FROM provider_usage_stats
        WHERE provider_id = ? AND date >= date('now', '-' || ? || ' days')
        ORDER BY date DESC
      `
        )
        .all(id, days);

      // Calculate totals
      const totals = stats.reduce(
        (acc, row) => ({
          total_calls: acc.total_calls + row.total_calls,
          successful_calls: acc.successful_calls + row.successful_calls,
          failed_calls: acc.failed_calls + row.failed_calls,
          total_minutes: acc.total_minutes + row.total_minutes,
          estimated_cost: acc.estimated_cost + row.estimated_cost,
        }),
        { total_calls: 0, successful_calls: 0, failed_calls: 0, total_minutes: 0, estimated_cost: 0 }
      );

      return { success: true, stats, totals };
    } catch (error) {
      fastify.log.error('[Providers] Error getting stats:', error);
      return reply.status(500).send({ error: 'Failed to get stats', message: error.message });
    }
  });
}
