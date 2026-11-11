/**
 * Call Center API Routes
 * All routes are registered under /api/ext/call-center/
 */

export async function registerCallCenterRoutes(fastify) {
  // Re-export all telephony routes from core
  // These will be available at /api/ext/call-center/* instead of /api/telephony/*

  const { registerTelephonyRoutes } = await import('../../../src/api/routes/telephony.js');

  // Register all telephony routes under the extension prefix
  await registerTelephonyRoutes(fastify);

  fastify.log.info('[Call Center] ✅ Routes registered');
}
