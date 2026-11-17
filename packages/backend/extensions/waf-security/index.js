/**
 * Server & Web Security Scanner for Girru — defensive only.
 *
 * Watch and test the security of the servers and sites you own: open ports and services, TLS and
 * certificates, security headers and CORS, WAF behaviour, and this Girru's own settings. Findings
 * are informational, bound to the evidence that proves them, and retestable. An optional sensor you
 * install on your own server pushes live alerts in. Nothing here attacks, exploits, or acts against
 * a target, and nothing here depends on an API key — model help routes through Dpro's own provider.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createWafRoutes } from './src/routes.js';
import { createWafScanTool } from './src/tool.js';
import { seedLibrary } from './src/seed.js';
import { processScheduledCampaigns } from './src/campaign-service.js';
import { allowPrivateTargets, mayUseApp } from './src/settings.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// Ordered migrations. runMigrations is idempotent and tracked per extension, so calling it on every
// start is safe; it only applies files that have not run yet.
const MIGRATIONS = [
  '001_waf_scans.sql',
  '002_waf_rate_limits.sql',
  '003_waf_payload_library.sql',
  '004_waf_campaigns.sql',
  '005_waf_assets.sql',
  '006_waf_findings.sql',
  '007_waf_coverage.sql',
  '008_waf_sensor.sql',
].map((f) => join(HERE, 'migrations', f));

export default {
  id: 'waf-security',
  name: 'Server & Web Security Scanner',
  version: '2.0.0',

  async register(api) {
    // 1. Tables (own, prefixed, tracked, idempotent).
    await api.runMigrations(MIGRATIONS);

    // 2. Starting rows for the test library and campaign stages, into empty tables only.
    const added = seedLibrary(api.db);
    if (added) api.log('info', `Added ${added} starting rows to the test library`);

    // 3. Routes under /api/ext/waf-security/.
    api.registerRoutes(createWafRoutes(api));

    // 4. The owner/admin-gated agent tool (never auto-granted to an agent).
    api.registerTool(createWafScanTool(api));

    // 5. Scheduled campaigns, checked hourly; each runs only while its owner is an active owner/admin.
    api.registerCronJob('0 * * * *', async () => {
      const executed = await processScheduledCampaigns(api.db, {
        allowPrivate: allowPrivateTargets(api),
        mayRun: (userId) => mayUseApp(api, userId),
      });
      if (executed > 0) api.log('info', `Executed ${executed} scheduled security campaigns`);
    }, 'campaign-scheduler');

    api.log('info', 'Server & Web Security Scanner ready');
  },

  async onDisable(api) {
    api.unregisterTool('waf_scan');
    try { api.unregisterCronJob('campaign-scheduler'); } catch { /* not registered */ }
    api.log('info', 'Server & Web Security Scanner disabled');
  },
};
