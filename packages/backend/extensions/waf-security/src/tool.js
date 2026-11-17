/**
 * WAF Scan AI Tool - Pure JavaScript
 * Lets an agent test a site's WAF, or audit this Girru, for the user who called it.
 * Only for an active owner or admin (the page's rule); the same target rules and limits as the page apply.
 */

import { selfAudit } from './engine.js';
import { startScan } from './scanner.js';
import { allowPrivateTargets, mayUseApp } from './settings.js';
import { ownBackendUrl } from './routes.js';

const NO_USER = Object.freeze({ content: [{ type: 'text', text: 'Error: this tool needs a signed-in user.' }], is_error: true });
const NOT_ALLOWED = Object.freeze({ content: [{ type: 'text', text: 'Error: only an active owner or admin of this Girru can run WAF scans.' }], is_error: true });
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { is_error: true } : {}) });

export function createWafScanTool(api) {
  return {
    name: 'waf_scan',
    description: 'Test WAF protection on a URL or run self-audit. Returns security score, detected WAF type, and bypass rates per category.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Target URL to scan, or "self" to audit this Girru',
        },
        mode: {
          type: 'string',
          enum: ['quick', 'full'],
          description: 'Scan mode: "quick" tests 3 payloads in each of 2 categories, "full" tests all payloads',
        },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter attack categories (sql_injection, xss, path_traversal, etc.)',
        },
      },
      required: ['url'],
    },

    async execute(params, context) {
      const userId = context?.userId;
      if (!userId) return NO_USER;
      // The same check as the page's routes and the scheduler: an active owner or admin, else nothing runs.
      if (!mayUseApp(api, userId)) return NOT_ALLOWED;
      const { url, mode, categories } = params || {};

      try {
        if (url === 'self') {
          const audit = await selfAudit(ownBackendUrl());
          return text(`# Girru Security Audit\n\n**Score**: ${audit.securityScore} (${audit.grade})\n**Total Issues**: ${audit.totalIssues}\n` +
            `- Critical: ${audit.criticalSeverity}\n` +
            `- High: ${audit.highSeverity}\n` +
            `- Medium: ${audit.mediumSeverity}\n` +
            `- Low: ${audit.lowSeverity}\n\n` +
            `## Issues Found:\n\n` +
            audit.issues.map((issue, i) =>
              `${i + 1}. **[${issue.severity.toUpperCase()}]** ${issue.type}\n` +
              `   - Detail: ${issue.detail}\n` +
              `   - Fix: ${issue.recommendation}\n`
            ).join('\n'));
        }

        const db = api.db;
        const { scanId, done } = await startScan(db, {
          userId: String(userId),
          url,
          mode: mode === 'full' ? 'full' : 'quick',
          categories: Array.isArray(categories) ? categories.filter((c) => typeof c === 'string').slice(0, 20) : [],
          allowPrivate: allowPrivateTargets(api),
        });

        // Wait up to 30 seconds for the result.
        await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 30_000).unref?.())]);
        const scan = db.prepare('SELECT * FROM app_waf_security__waf_scans WHERE id = ? AND user_id = ?').get(scanId, String(userId));

        if (!scan || scan.status !== 'completed') {
          return text(`Scan is still running or failed. Scan ID: ${scanId}. Its result is kept in the WAF Security app.`);
        }

        let results = null;
        try { results = JSON.parse(scan.results_json); } catch { results = null; }

        const wafStatus = scan.waf_detected
          ? `**WAF Detected**: ${scan.waf_type} (${scan.waf_confidence}% confidence)`
          : '**No WAF detected** (or WAF is transparent)';

        let categorySummary = '';
        if (results && results.tests) {
          const byCategory = {};
          results.tests.forEach(test => {
            if (!byCategory[test.category]) byCategory[test.category] = { total: 0, blocked: 0 };
            byCategory[test.category].total++;
            if (test.blocked) byCategory[test.category].blocked++;
          });
          categorySummary = '\n## Results by Category:\n\n';
          for (const [cat, stats] of Object.entries(byCategory)) {
            const passRate = ((stats.total - stats.blocked) / stats.total * 100).toFixed(1);
            categorySummary += `- **${cat}**: ${stats.blocked}/${stats.total} blocked (${passRate}% bypass rate)\n`;
          }
        }

        return text(`# WAF Scan Results\n\n` +
          `**Target**: ${scan.target_url}\n` +
          `${wafStatus}\n\n` +
          `**Risk Level**: ${String(scan.risk_level || 'unknown').toUpperCase()}\n\n` +
          `**Overall Stats**:\n` +
          `- Total Payloads: ${scan.total_payloads}\n` +
          `- Blocked: ${scan.blocked_count}\n` +
          `- Passed: ${scan.passed_count}\n` +
          `- Bypass Rate: ${Number(scan.bypass_rate).toFixed(1)}%\n` +
          categorySummary);
      } catch (error) {
        return text(`WAF scan error: ${error.message}`, true);
      }
    },
  };
}
