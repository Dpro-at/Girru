/**
 * One scan of a site: find its WAF, then send the test requests of the chosen groups.
 * Used by the scan route and by the waf_scan tool.
 */

import { randomUUID } from 'crypto';
import { detectWAF, testPayload, getPayloadCategories, getPayloadsFromDatabase } from './engine.js';
import { checkTarget } from './target.js';
import { WafRateLimiter } from './rate-limiter.js';

/**
 * Check the target and the limits, record the scan and start it. Resolves { scanId, done }:
 * `done` settles when the scan has finished (completed or failed). Throws before recording
 * anything when the target or the limits refuse it.
 */
export async function startScan(db, { userId, url, mode = 'quick', categories = [], allowPrivate = false }) {
  if (!userId) throw new Error('Unauthorized: no signed-in user');
  const target = await checkTarget(url, { allowPrivate });
  const rateLimiter = new WafRateLimiter(db);
  await rateLimiter.checkLimit(userId);

  const scanId = randomUUID();
  const ownAddress = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(target);
  db.prepare(`
    INSERT INTO app_waf_security__waf_scans (id, target_url, scan_type, status, started_at, user_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(scanId, target, ownAddress ? 'self' : 'external', 'running', new Date().toISOString(), userId);

  const done = runScan(db, scanId, target, categories, mode, allowPrivate)
    .catch((err) => {
      console.error('[WAF Scan] Error:', err.message);
      db.prepare('UPDATE app_waf_security__waf_scans SET status = ?, ended_at = ? WHERE id = ?')
        .run('failed', new Date().toISOString(), scanId);
    })
    .finally(() => rateLimiter.releaseScan(userId));
  return { scanId, done };
}

async function runScan(db, scanId, url, categories, mode, allowPrivate) {
  const results = {
    detection: null,
    tests: [],
  };

  // Step 1: Detect WAF
  const detection = await detectWAF(url, { allowPrivate });
  results.detection = detection;

  // Step 2: Test payloads (from database); no groups chosen means all of them
  const categoriesToTest = Array.isArray(categories) && categories.length ? categories : getPayloadCategories(db).map(c => c.id);
  const selectedCategories = mode === 'quick' ? categoriesToTest.slice(0, 2) : categoriesToTest;

  for (const category of selectedCategories) {
    const payloadObjects = getPayloadsFromDatabase(db, category, true);
    const payloadsToTest = mode === 'quick' ? payloadObjects.slice(0, 3) : payloadObjects;

    for (const payloadObj of payloadsToTest) {
      const testResult = await testPayload(url, payloadObj.payload, category, 60000, { allowPrivate });
      testResult.severity = payloadObj.severity;
      testResult.description = payloadObj.description;
      testResult.evasionTechnique = payloadObj.evasion_technique;
      results.tests.push(testResult);

      // Brief delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  // Step 3: Calculate metrics
  const totalPayloads = results.tests.length;
  const blockedCount = results.tests.filter(t => t.blocked).length;
  const passedCount = totalPayloads - blockedCount;
  const bypassRate = totalPayloads > 0 ? (passedCount / totalPayloads) * 100 : 0;

  let riskLevel = 'low';
  if (bypassRate > 50) riskLevel = 'critical';
  else if (bypassRate > 30) riskLevel = 'high';
  else if (bypassRate > 10) riskLevel = 'medium';

  db.prepare(`
    UPDATE app_waf_security__waf_scans SET
      waf_detected = ?,
      waf_type = ?,
      waf_confidence = ?,
      total_payloads = ?,
      blocked_count = ?,
      passed_count = ?,
      bypass_rate = ?,
      risk_level = ?,
      results_json = ?,
      status = ?,
      ended_at = ?
    WHERE id = ?
  `).run(
    detection.detected ? 1 : 0,
    detection.type,
    detection.confidence,
    totalPayloads,
    blockedCount,
    passedCount,
    bypassRate,
    riskLevel,
    JSON.stringify(results),
    'completed',
    new Date().toISOString(),
    scanId
  );

  console.log(`[WAF Scan] Completed: ${scanId}`);
}
