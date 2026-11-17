/**
 * WAF Campaign Service
 * Manages security testing campaigns with scheduling and multi-stage execution
 */

import { randomUUID } from 'crypto';
import { detectWAF, testPayload, getPayloadsFromDatabase } from './engine.js';
import { checkTarget } from './target.js';
import { WafRateLimiter } from './rate-limiter.js';

/** Campaigns one user may have. */
export const MAX_CAMPAIGNS_PER_USER = 50;
import { calculateSecurityScore, generateRecommendations, calculateSeverityDistribution } from './scoring.js';

/**
 * Create a new security testing campaign
 * @param {object} db - Database instance
 * @param {string} userId - User ID
 * @param {object} config - Campaign configuration
 * @returns {object} Created campaign
 */
export async function createCampaign(db, userId, config, { allowPrivate = false } = {}) {
  if (!userId) throw new Error('Unauthorized: no signed-in user');
  const {
    name,
    description,
    targetDomain,
    scanMode = 'full',
    categories = null,
    scheduleEnabled = false,
    scheduleFrequency = null,
    scheduleTime = null,
    scheduleDayOfWeek = null,
    scheduleDayOfMonth = null,
  } = config;

  // Only what the campaign can use; the target is checked like a scan's.
  if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('Invalid name: 1-200 characters');
  if (description != null && (typeof description !== 'string' || description.length > 2000)) throw new Error('Invalid description: at most 2000 characters');
  if (!['quick', 'full'].includes(scanMode)) throw new Error('Invalid scan mode: must be "quick" or "full"');
  if (categories != null && (!Array.isArray(categories) || categories.length > 20 || categories.some((c) => typeof c !== 'string' || !/^[a-z_]{1,40}$/.test(c)))) throw new Error('Invalid categories');
  if (scheduleEnabled) {
    if (!['daily', 'weekly', 'monthly'].includes(scheduleFrequency)) throw new Error('Invalid schedule: frequency must be daily, weekly or monthly');
    if (typeof scheduleTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)) throw new Error('Invalid schedule: time must be HH:MM');
    if (scheduleDayOfWeek != null && !(Number.isInteger(scheduleDayOfWeek) && scheduleDayOfWeek >= 0 && scheduleDayOfWeek <= 6)) throw new Error('Invalid schedule: day of week must be 0-6');
    if (scheduleDayOfMonth != null && !(Number.isInteger(scheduleDayOfMonth) && scheduleDayOfMonth >= 1 && scheduleDayOfMonth <= 31)) throw new Error('Invalid schedule: day of month must be 1-31');
  }
  const owned = db.prepare('SELECT COUNT(*) AS n FROM app_waf_security__waf_campaigns WHERE user_id = ?').get(userId).n;
  if (owned >= MAX_CAMPAIGNS_PER_USER) throw new Error(`Rate limit exceeded: at most ${MAX_CAMPAIGNS_PER_USER} campaigns per user`);
  const target = await checkTarget(targetDomain, { allowPrivate });

  const campaignId = randomUUID();
  const now = new Date().toISOString();

  // Calculate next run if scheduling enabled
  let scheduleNextRun = null;
  if (scheduleEnabled && scheduleFrequency && scheduleTime) {
    scheduleNextRun = calculateNextRunTime(scheduleFrequency, scheduleTime, scheduleDayOfWeek, scheduleDayOfMonth);
  }

  // Insert campaign
  db.prepare(`
    INSERT INTO app_waf_security__waf_campaigns (
      id, user_id, name, description, target_domain,
      status, schedule_enabled, schedule_frequency, schedule_time,
      schedule_day_of_week, schedule_day_of_month, schedule_next_run,
      scan_mode, categories, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    campaignId,
    userId,
    name.trim(),
    description || null,
    target,
    'idle',
    scheduleEnabled ? 1 : 0,
    scheduleFrequency,
    scheduleTime,
    scheduleDayOfWeek,
    scheduleDayOfMonth,
    scheduleNextRun,
    scanMode,
    categories ? JSON.stringify(categories) : null,
    now,
    now
  );

  return getCampaign(db, campaignId);
}

/**
 * Get campaign by ID
 * @param {object} db - Database instance
 * @param {string} campaignId - Campaign ID
 * @returns {object} Campaign details
 */
export function getCampaign(db, campaignId) {
  const campaign = db.prepare('SELECT * FROM app_waf_security__waf_campaigns WHERE id = ?').get(campaignId);

  if (!campaign) {
    return null;
  }

  // Parse JSON fields
  if (campaign.categories) {
    try {
      campaign.categories = JSON.parse(campaign.categories);
    } catch (e) {
      campaign.categories = null;
    }
  }

  return campaign;
}

/**
 * List campaigns for user
 * @param {object} db - Database instance
 * @param {string} userId - User ID
 * @returns {array} Campaigns
 */
export function listCampaigns(db, userId) {
  const campaigns = db.prepare(`
    SELECT
      c.id, c.user_id, c.name, c.target_domain, c.status,
      c.schedule_enabled, c.schedule_frequency, c.schedule_next_run,
      c.total_runs, c.avg_security_score, c.last_security_score, c.baseline_security_score,
      c.created_at, c.last_run_at,
      (SELECT COUNT(*) FROM app_waf_security__waf_campaign_scans WHERE campaign_id = c.id) AS total_scans,
      (SELECT COUNT(*) FROM app_waf_security__waf_campaign_comparisons WHERE campaign_id = c.id AND regression_detected = 1) AS total_regressions
    FROM app_waf_security__waf_campaigns c
    WHERE c.user_id = ?
    ORDER BY c.created_at DESC
  `).all(userId);

  return campaigns.map(c => {
    if (c.categories) {
      try {
        c.categories = JSON.parse(c.categories);
      } catch (e) {
        c.categories = null;
      }
    }
    return c;
  });
}

/**
 * Run a 4-stage campaign
 * @param {object} db - Database instance
 * @param {string} campaignId - Campaign ID
 * @returns {object} Campaign run results
 */
export async function runCampaign(db, campaignId, { allowPrivate = false } = {}) {
  const campaign = getCampaign(db, campaignId);

  if (!campaign) {
    throw new Error('Campaign not found');
  }

  // Update campaign status
  const runNumber = campaign.total_runs + 1;
  const now = new Date().toISOString();

  // One run at a time: the switch to 'running' is the lock.
  const claimed = db.prepare(`
    UPDATE app_waf_security__waf_campaigns
    SET status = 'running', total_runs = ?, last_run_at = ?, updated_at = ?
    WHERE id = ? AND status IS NOT 'running'
  `).run(runNumber, now, now, campaignId);
  if (claimed.changes === 0) {
    throw new Error('Campaign is already running');
  }

  try {
    // Get stage definitions
    const stages = db.prepare('SELECT * FROM app_waf_security__waf_campaign_stages ORDER BY stage_number').all();

    const stageResults = [];

    // Execute each stage
    for (const stage of stages) {
      console.log(`[Campaign ${campaignId}] Starting stage ${stage.stage_number}: ${stage.stage_name}`);

      const stageResult = await runCampaignStage(db, campaign, stage, runNumber, allowPrivate);
      stageResults.push(stageResult);

      // Stop if stage failed
      if (stageResult.stage_status === 'failed') {
        console.error(`[Campaign ${campaignId}] Stage ${stage.stage_number} failed`);
        break;
      }
    }

    // Calculate overall campaign score from last stage
    const lastStage = stageResults[stageResults.length - 1];
    const overallScore = lastStage?.security_score || 0;

    // Update campaign with results
    db.prepare(`
      UPDATE app_waf_security__waf_campaigns
      SET
        status = 'completed',
        successful_runs = successful_runs + 1,
        last_security_score = ?,
        avg_security_score = ((avg_security_score * (total_runs - 1)) + ?) / total_runs,
        baseline_security_score = CASE WHEN baseline_security_score = 0 THEN ? ELSE baseline_security_score END,
        updated_at = ?
      WHERE id = ?
    `).run(overallScore, overallScore, overallScore, new Date().toISOString(), campaignId);

    // Create comparison if this is not the first run
    if (runNumber > 1) {
      await createComparison(db, campaignId, runNumber);
    }

    // Send notification
    createCampaignNotification(db, campaignId, campaign.user_id, 'completion', 'info', {
      title: 'Campaign Completed',
      message: `Campaign "${campaign.name}" completed with score: ${Math.round(overallScore)}`,
      metadata: { runNumber, score: overallScore },
    });

    return {
      campaignId,
      runNumber,
      status: 'completed',
      overallScore,
      stages: stageResults,
    };
  } catch (error) {
    // Mark campaign as failed
    db.prepare(`
      UPDATE app_waf_security__waf_campaigns
      SET status = 'failed', failed_runs = failed_runs + 1, updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), campaignId);

    // Send failure notification
    createCampaignNotification(db, campaignId, campaign.user_id, 'failure', 'high', {
      title: 'Campaign Failed',
      message: `Campaign "${campaign.name}" failed: ${error.message}`,
      metadata: { runNumber, error: error.message },
    });

    throw error;
  }
}

/**
 * Run a single campaign stage
 * @param {object} db - Database instance
 * @param {object} campaign - Campaign object
 * @param {object} stage - Stage definition
 * @param {number} runNumber - Run number
 * @returns {object} Stage results
 */
async function runCampaignStage(db, campaign, stage, runNumber, allowPrivate) {
  const scanId = randomUUID();
  const campaignScanId = randomUUID();
  const now = new Date().toISOString();

  // Parse stage categories
  let stageCategories = null;
  try {
    stageCategories = JSON.parse(stage.default_categories);
  } catch (e) {
    stageCategories = null;
  }

  // Each stage is a scan and counts against the owner's scan limits like any other;
  // over a limit, the run stops here (runCampaign marks it failed).
  const rateLimiter = new WafRateLimiter(db);
  await rateLimiter.checkLimit(campaign.user_id);

  try {
    // Create scan record
    db.prepare(`
      INSERT INTO app_waf_security__waf_scans (id, target_url, scan_type, status, started_at, user_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(scanId, campaign.target_domain, 'external', 'running', now, campaign.user_id);

    // Create campaign scan link
    db.prepare(`
      INSERT INTO app_waf_security__waf_campaign_scans (
        id, campaign_id, scan_id, run_number, stage, stage_name, stage_status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(campaignScanId, campaign.id, scanId, runNumber, stage.stage_number, stage.stage_name, 'running', now);

    // Run scan
    const scanResults = await runScan(db, campaign.target_domain, stageCategories, stage.default_mode, allowPrivate);

    // Calculate score
    const scoreData = calculateSecurityScore(scanResults);
    const severityDist = calculateSeverityDistribution(scanResults.tests);

    // Update scan record
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
      scanResults.detection.detected ? 1 : 0,
      scanResults.detection.type,
      scanResults.detection.confidence,
      scanResults.tests.length,
      scanResults.tests.filter(t => t.blocked).length,
      scanResults.tests.filter(t => !t.blocked).length,
      scoreData.metrics.blockRate,
      calculateRiskLevel(scoreData.score),
      JSON.stringify(scanResults),
      'completed',
      new Date().toISOString(),
      scanId
    );

    // Update campaign scan with results
    db.prepare(`
      UPDATE app_waf_security__waf_campaign_scans SET
        stage_status = 'completed',
        security_score = ?,
        vulnerabilities_found = ?,
        critical_issues = ?,
        high_issues = ?,
        medium_issues = ?,
        low_issues = ?,
        completed_at = ?
      WHERE id = ?
    `).run(
      scoreData.score,
      scanResults.tests.filter(t => !t.blocked).length,
      severityDist.critical,
      severityDist.high,
      severityDist.medium,
      severityDist.low,
      new Date().toISOString(),
      campaignScanId
    );

    return {
      campaignScanId,
      scanId,
      stage: stage.stage_number,
      stage_name: stage.stage_name,
      stage_status: 'completed',
      security_score: scoreData.score,
      vulnerabilities_found: scanResults.tests.filter(t => !t.blocked).length,
    };
  } catch (error) {
    // Mark stage as failed
    db.prepare(`
      UPDATE app_waf_security__waf_campaign_scans SET
        stage_status = 'failed',
        completed_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), campaignScanId);

    db.prepare(`
      UPDATE app_waf_security__waf_scans SET status = 'failed', ended_at = ? WHERE id = ?
    `).run(new Date().toISOString(), scanId);

    return {
      campaignScanId,
      scanId,
      stage: stage.stage_number,
      stage_name: stage.stage_name,
      stage_status: 'failed',
      error: error.message,
    };
  } finally {
    await rateLimiter.releaseScan(campaign.user_id);
  }
}

/**
 * Run actual scan (simplified version of routes.js runScanAsync)
 * @param {object} db - Database instance
 * @param {string} targetUrl - Target URL (each request checked again by target.js)
 * @param {array|null} categories - Categories to test
 * @param {string} mode - Scan mode (quick/full)
 * @returns {object} Scan results
 */
async function runScan(db, targetUrl, categories, mode, allowPrivate) {
  const results = {
    detection: null,
    tests: [],
  };

  // Step 1: Detect WAF
  results.detection = await detectWAF(targetUrl, { allowPrivate });

  // Step 2: Test payloads
  const categoriesToTest = categories || getDefaultCategories(db);

  for (const category of categoriesToTest) {
    const payloadObjects = getPayloadsFromDatabase(db, category, true);
    const payloadsToTest = mode === 'quick' ? payloadObjects.slice(0, 3) : payloadObjects;

    for (const payloadObj of payloadsToTest) {
      const testResult = await testPayload(targetUrl, payloadObj.payload, category, 60000, { allowPrivate });
      testResult.severity = payloadObj.severity;
      testResult.description = payloadObj.description;
      testResult.evasionTechnique = payloadObj.evasion_technique;
      results.tests.push(testResult);

      // Brief delay
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return results;
}

/**
 * Get default categories from database
 * @param {object} db - Database instance
 * @returns {array} Category IDs
 */
function getDefaultCategories(db) {
  const results = db.prepare(`
    SELECT DISTINCT category FROM app_waf_security__waf_payload_library ORDER BY category
  `).all();

  return results.map(r => r.category);
}

/**
 * Calculate risk level from score
 * @param {number} score - Security score
 * @returns {string} Risk level
 */
function calculateRiskLevel(score) {
  if (score >= 90) return 'low';
  if (score >= 70) return 'medium';
  if (score >= 50) return 'high';
  return 'critical';
}

/**
 * Create comparison between two runs
 * @param {object} db - Database instance
 * @param {string} campaignId - Campaign ID
 * @param {number} currentRunNumber - Current run number
 */
async function createComparison(db, campaignId, currentRunNumber) {
  const baselineRunNumber = currentRunNumber - 1;

  // Get baseline scan
  const baselineScan = db.prepare(`
    SELECT * FROM app_waf_security__waf_campaign_scans
    WHERE campaign_id = ? AND run_number = ? AND stage = 4
  `).get(campaignId, baselineRunNumber);

  // Get current scan
  const currentScan = db.prepare(`
    SELECT * FROM app_waf_security__waf_campaign_scans
    WHERE campaign_id = ? AND run_number = ? AND stage = 4
  `).get(campaignId, currentRunNumber);

  if (!baselineScan || !currentScan) {
    return; // Skip if stage 4 not completed
  }

  const scoreDelta = currentScan.security_score - baselineScan.security_score;
  const regressionDetected = scoreDelta < -5; // Regression if score drops >5 points

  // Calculate vulnerability changes
  const vulnDelta = currentScan.vulnerabilities_found - baselineScan.vulnerabilities_found;
  const newVulns = vulnDelta > 0 ? vulnDelta : 0;
  const fixedVulns = vulnDelta < 0 ? Math.abs(vulnDelta) : 0;

  // Insert comparison
  db.prepare(`
    INSERT INTO app_waf_security__waf_campaign_comparisons (
      id, campaign_id, baseline_scan_id, current_scan_id,
      baseline_run_number, current_run_number,
      security_score_delta, baseline_score, current_score,
      new_vulnerabilities, fixed_vulnerabilities,
      persistent_vulnerabilities, regression_detected,
      comparison_type, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    campaignId,
    baselineScan.scan_id,
    currentScan.scan_id,
    baselineRunNumber,
    currentRunNumber,
    scoreDelta,
    baselineScan.security_score,
    currentScan.security_score,
    newVulns,
    fixedVulns,
    Math.min(baselineScan.vulnerabilities_found, currentScan.vulnerabilities_found),
    regressionDetected ? 1 : 0,
    'sequential',
    new Date().toISOString()
  );

  // Send notification if regression detected
  if (regressionDetected) {
    const campaign = getCampaign(db, campaignId);
    createCampaignNotification(db, campaignId, campaign.user_id, 'regression', 'critical', {
      title: 'Security Regression Detected',
      message: `Campaign "${campaign.name}" security score dropped by ${Math.abs(Math.round(scoreDelta))} points`,
      metadata: { scoreDelta, baselineScore: baselineScan.security_score, currentScore: currentScan.security_score },
    });
  } else if (scoreDelta > 5) {
    const campaign = getCampaign(db, campaignId);
    createCampaignNotification(db, campaignId, campaign.user_id, 'improvement', 'info', {
      title: 'Security Improved',
      message: `Campaign "${campaign.name}" security score improved by ${Math.round(scoreDelta)} points`,
      metadata: { scoreDelta, baselineScore: baselineScan.security_score, currentScore: currentScan.security_score },
    });
  }
}

/**
 * Create campaign notification
 * @param {object} db - Database instance
 * @param {string} campaignId - Campaign ID
 * @param {string} userId - User ID
 * @param {string} type - Notification type
 * @param {string} severity - Severity level
 * @param {object} data - Notification data
 */
function createCampaignNotification(db, campaignId, userId, type, severity, data) {
  db.prepare(`
    INSERT INTO app_waf_security__waf_campaign_notifications (
      id, campaign_id, user_id, notification_type, severity,
      title, message, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    campaignId,
    userId,
    type,
    severity,
    data.title,
    data.message,
    JSON.stringify(data.metadata || {}),
    new Date().toISOString()
  );
}

/**
 * Calculate next run time based on schedule
 * @param {string} frequency - Schedule frequency
 * @param {string} time - Time in HH:MM format
 * @param {number|null} dayOfWeek - Day of week (0-6)
 * @param {number|null} dayOfMonth - Day of month (1-31)
 * @returns {string} ISO datetime string
 */
function calculateNextRunTime(frequency, time, dayOfWeek, dayOfMonth) {
  const now = new Date();
  const [hours, minutes] = time.split(':').map(Number);

  let next = new Date();
  next.setHours(hours, minutes, 0, 0);

  switch (frequency) {
    case 'daily':
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }
      break;

    case 'weekly':
      const currentDay = next.getDay();
      const targetDay = dayOfWeek || 0;
      let daysUntil = (targetDay - currentDay + 7) % 7;
      if (daysUntil === 0 && next <= now) {
        daysUntil = 7;
      }
      next.setDate(next.getDate() + daysUntil);
      break;

    case 'monthly':
      const targetDate = dayOfMonth || 1;
      next.setDate(targetDate);
      if (next <= now) {
        next.setMonth(next.getMonth() + 1);
      }
      break;
  }

  return next.toISOString();
}

/**
 * Process scheduled campaigns (called by cron job)
 * A campaign runs only while its owner may still use the app (`mayRun`, checked at each run;
 * no answer means no run). Its next run moves on whether this one worked or not.
 * @param {object} db - Database instance
 * @param {object} options - { allowPrivate, mayRun(userId) }
 * @returns {number} Number of campaigns executed
 */
export async function processScheduledCampaigns(db, { allowPrivate = false, mayRun = () => false } = {}) {
  const now = new Date().toISOString();

  // Find campaigns due for execution
  const dueCampaigns = db.prepare(`
    SELECT * FROM app_waf_security__waf_campaigns
    WHERE schedule_enabled = 1
      AND schedule_next_run IS NOT NULL
      AND schedule_next_run <= ?
      AND status NOT IN ('running')
  `).all(now);

  let executed = 0;

  for (const campaign of dueCampaigns) {
    let nextRun = null;
    try {
      nextRun = calculateNextRunTime(
        campaign.schedule_frequency,
        campaign.schedule_time,
        campaign.schedule_day_of_week,
        campaign.schedule_day_of_month
      );
    } catch {
      nextRun = null; // a schedule that cannot be read stops
    }
    db.prepare(`
      UPDATE app_waf_security__waf_campaigns
      SET schedule_next_run = ?, schedule_last_run = ?, updated_at = ?
      WHERE id = ?
    `).run(nextRun, now, now, campaign.id);

    let allowed = false;
    try { allowed = mayRun(campaign.user_id) === true; } catch { allowed = false; }
    if (!allowed) {
      console.warn(`[Scheduler] Skipped campaign ${campaign.id}: its owner can no longer run it`);
      continue;
    }

    try {
      console.log(`[Scheduler] Running campaign: ${campaign.name}`);
      await runCampaign(db, campaign.id, { allowPrivate });
      executed++;
    } catch (error) {
      console.error(`[Scheduler] Failed to run campaign ${campaign.name}:`, error.message);
    }
  }

  return executed;
}

/**
 * Delete campaign
 * @param {object} db - Database instance
 * @param {string} campaignId - Campaign ID
 */
export function deleteCampaign(db, campaignId) {
  db.prepare('DELETE FROM app_waf_security__waf_campaigns WHERE id = ?').run(campaignId);
}
