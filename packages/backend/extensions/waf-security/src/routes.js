/**
 * API routes, mounted at /api/ext/waf-security/.
 *
 * Girru lets only an active owner or admin reach these (routeAccess: 'owner-admin'), except the
 * one public route the server sensor pushes alerts to, which is authenticated by its own token.
 * Each user sees only their own assets, findings, scans and campaigns.
 *
 * Places (match the approved structure): Overview, Servers, Sites, Findings, Campaigns,
 * This Girru (self-audit), Settings.
 */

import { detectWAF, selfAudit, getPayloadCategories } from './engine.js';
import { checkTarget, TargetError } from './target.js';
import { startScan } from './scanner.js';
import { createCampaign, getCampaign, listCampaigns, runCampaign, deleteCampaign } from './campaign-service.js';
import { calculateSecurityScore, generateRecommendations } from './scoring.js';
import { allowPrivateTargets, noiseProfile, saveSettings, currentSettings, SettingsError } from './settings.js';
import { addAsset, listAssets, getAsset, removeAsset, requireInScope, ScopeError } from './scope.js';
import { coverageSummaryForAsset, coverageForScan } from './coverage.js';
import { listFindings, findingDetail, retestFinding, setFindingStatus, FindingError } from './findings.js';
import { runAssetScan } from './scan-engine.js';
import { pairSensor, listSensors, revokeSensor, sensorForToken, ingestAlert, listAlerts, SensorError } from './sensor.js';
import { explainFinding } from './explain.js';

function getUserIdFromRequest(request) {
  if (!request.authUserId) throw new Error('Unauthorized: no signed-in user');
  return String(request.authUserId);
}

function statusOf(err, fallback) {
  if (err instanceof TargetError || err instanceof ScopeError || err instanceof FindingError || err instanceof SensorError) return 400;
  if (err.message.includes('Unauthorized')) return 401;
  if (err.message.includes('Rate limit')) return 429;
  if (err.message.startsWith('Invalid')) return 400;
  return fallback;
}

export function ownBackendUrl() {
  return process.env.BACKEND_URL || `http://${process.env.HOST || 'localhost'}:${process.env.PORT || '41522'}`;
}

function validateScanRequest(body) {
  const { url, mode, categories } = body || {};
  if (!url || typeof url !== 'string') throw new Error('Invalid URL: must be a non-empty string');
  if (mode && !['quick', 'full'].includes(mode)) throw new Error('Invalid mode: must be "quick" or "full"');
  if (categories && (!Array.isArray(categories) || categories.length > 20 || categories.some((c) => typeof c !== 'string'))) throw new Error('Invalid categories: must be a list of group names');
  return { url, mode: mode || 'quick', categories: categories || [] };
}

export function createWafRoutes(api) {
  return async function registerWafRoutes(fastify) {
    const db = api.db;
    const send = (reply, err, fallback = 500) => reply.status(statusOf(err, fallback)).send({ error: err.message });

    // ===================== Overview =====================
    fastify.get('/overview', async (request, reply) => {
      try {
        const userId = getUserIdFromRequest(request);
        const needsYou = [];
        const crit = db.prepare("SELECT id, title, severity, where_url, last_seen_at FROM app_waf_security__findings WHERE user_id = ? AND status IN ('open','reproduced') AND severity IN ('critical','high') ORDER BY last_seen_at DESC LIMIT 20").all(userId);
        for (const f of crit) needsYou.push({ kind: 'finding', id: f.id, severity: f.severity, text: f.title, where: f.where_url, at: f.last_seen_at });
        const offline = db.prepare("SELECT id, name FROM app_waf_security__sensors WHERE user_id = ? AND status = 'offline'").all(userId);
        for (const s of offline) needsYou.push({ kind: 'sensor', id: s.id, severity: 'medium', text: `${s.name} is offline` });
        const alerts = db.prepare("SELECT id, title, severity, received_at FROM app_waf_security__sensor_alerts WHERE user_id = ? ORDER BY received_at DESC LIMIT 10").all(userId);
        for (const a of alerts) needsYou.push({ kind: 'alert', id: a.id, severity: a.severity, text: a.title, at: a.received_at });
        return { needsYou };
      } catch (err) { return send(reply, err); }
    });

    // ===================== Servers & Sites (assets) =====================
    fastify.get('/assets', async (request, reply) => {
      try {
        const userId = getUserIdFromRequest(request);
        const kind = request.query?.kind === 'server' || request.query?.kind === 'site' ? request.query.kind : null;
        const assets = listAssets(db, userId, kind).map((a) => ({ ...a, coverage: coverageSummaryForAsset(db, userId, a.id) }));
        return { assets };
      } catch (err) { return send(reply, err); }
    });

    fastify.get('/assets/:id', async (request, reply) => {
      try {
        const userId = getUserIdFromRequest(request);
        const asset = getAsset(db, userId, request.params.id);
        if (!asset) return reply.status(404).send({ error: 'Not found' });
        const coverage = coverageSummaryForAsset(db, userId, asset.id);
        const coverageRows = coverage.scanId ? coverageForScan(db, coverage.scanId) : [];
        const findings = listFindings(db, userId, { assetId: asset.id, limit: 100 });
        return { ...asset, coverage, coverageRows, findings };
      } catch (err) { return send(reply, err); }
    });

    fastify.post('/assets', async (request, reply) => {
      try {
        const userId = getUserIdFromRequest(request);
        const asset = addAsset(db, userId, userId, request.body || {});
        return asset;
      } catch (err) { return send(reply, err, 400); }
    });

    fastify.delete('/assets/:id', async (request, reply) => {
      try {
        const userId = getUserIdFromRequest(request);
        return removeAsset(db, userId, userId, request.params.id);
      } catch (err) { return send(reply, err, 400); }
    });

    fastify.post('/assets/:id/scan', async (request, reply) => {
      try {
        const userId = getUserIdFromRequest(request);
        const asset = requireInScope(db, userId, userId, request.params.id); // scope/target gate
        const allowPrivate = allowPrivateTargets(api);
        if (asset.is_private && !allowPrivate) return reply.status(400).send({ error: 'This target is a private address; turn on private targets in Settings to scan it.' });
        const result = await runAssetScan(db, api, { userId, asset, allowPrivate, profile: noiseProfile(api) });
        return result;
      } catch (err) { return send(reply, err, 400); }
    });

    // ===================== Findings =====================
    fastify.get('/findings', async (request, reply) => {
      try {
        const userId = getUserIdFromRequest(request);
        const status = request.query?.status || null;
        const assetId = request.query?.assetId || null;
        return { findings: listFindings(db, userId, { status, assetId }) };
      } catch (err) { return send(reply, err); }
    });

    fastify.get('/findings/:id', async (request, reply) => {
      try {
        const userId = getUserIdFromRequest(request);
        const detail = findingDetail(db, userId, request.params.id);
        if (!detail) return reply.status(404).send({ error: 'Not found' });
        return detail;
      } catch (err) { return send(reply, err); }
    });

    fastify.post('/findings/:id/retest', async (request, reply) => {
      try {
        const userId = getUserIdFromRequest(request);
        const { verdict, oppositeCheck } = request.body || {};
        return retestFinding(db, userId, request.params.id, { verdict, oppositeCheck, decidedBy: userId });
      } catch (err) { return send(reply, err, 400); }
    });

    fastify.post('/findings/:id/ignore', async (request, reply) => {
      try { return setFindingStatus(db, getUserIdFromRequest(request), request.params.id, 'ignored'); }
      catch (err) { return send(reply, err, 400); }
    });
    fastify.post('/findings/:id/reopen', async (request, reply) => {
      try { return setFindingStatus(db, getUserIdFromRequest(request), request.params.id, 'open'); }
      catch (err) { return send(reply, err, 400); }
    });

    fastify.post('/findings/:id/explain', async (request, reply) => {
      try {
        const userId = getUserIdFromRequest(request);
        return await explainFinding(db, api, userId, request.params.id, request.body?.sessionId);
      } catch (err) { return send(reply, err, 400); }
    });

    // ===================== This Girru (self-audit) =====================
    fastify.post('/self', async (request, reply) => {
      try { getUserIdFromRequest(request); return await selfAudit(ownBackendUrl()); }
      catch (err) { return send(reply, err); }
    });

    // ===================== Settings =====================
    fastify.get('/settings', async () => currentSettings(api));
    fastify.put('/settings', async (request, reply) => {
      try { return saveSettings(api, getUserIdFromRequest(request), request.body || {}); }
      catch (err) {
        if (err instanceof SettingsError) return reply.status(err.message.startsWith('Only') ? 403 : 400).send({ error: err.message });
        return send(reply, err);
      }
    });
    fastify.get('/payloads', async () => ({ categories: getPayloadCategories(db) }));

    // ===================== Sensors =====================
    fastify.get('/sensors', async (request, reply) => {
      try { return { sensors: listSensors(db, getUserIdFromRequest(request)) }; }
      catch (err) { return send(reply, err); }
    });
    fastify.post('/sensors', async (request, reply) => {
      try {
        const userId = getUserIdFromRequest(request);
        const { assetId, name } = request.body || {};
        return pairSensor(db, userId, { assetId, name }); // returns { sensor, token } — token shown once
      } catch (err) { return send(reply, err, 400); }
    });
    fastify.delete('/sensors/:id', async (request, reply) => {
      try { return revokeSensor(db, getUserIdFromRequest(request), request.params.id); }
      catch (err) { return send(reply, err, 400); }
    });
    fastify.get('/alerts', async (request, reply) => {
      try { return { alerts: listAlerts(db, getUserIdFromRequest(request)) }; }
      catch (err) { return send(reply, err); }
    });

    // PUBLIC (manifest publicRoutes): a paired sensor pushes alerts here, authenticated by its token.
    // Outbound-only from the server's side; Dpro never calls back to the server.
    fastify.post('/sensor/push', async (request, reply) => {
      try {
        const auth = request.headers['authorization'] || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (request.body?.token || '');
        const sensor = sensorForToken(db, token);
        if (!sensor) return reply.status(401).send({ error: 'Unknown or revoked sensor token' });
        const result = await ingestAlert(db, api, sensor, request.body || {});
        return { ok: true, ...result };
      } catch (err) { return reply.status(400).send({ error: err.message }); }
    });

    // ===================== Back-compat scan routes (used by waf_scan tool) =====================
    fastify.post('/detect', async (request, reply) => {
      try {
        getUserIdFromRequest(request);
        const allowPrivate = allowPrivateTargets(api);
        const url = await checkTarget(request.body?.url, { allowPrivate });
        return await detectWAF(url, { allowPrivate });
      } catch (err) { return send(reply, err); }
    });
    fastify.post('/scan', async (request, reply) => {
      try {
        const userId = getUserIdFromRequest(request);
        const { url, categories, mode } = validateScanRequest(request.body);
        const { scanId } = await startScan(db, { userId, url, mode, categories, allowPrivate: allowPrivateTargets(api) });
        return { scanId, status: 'started' };
      } catch (err) { return send(reply, err, 400); }
    });
    fastify.get('/scan/:id', async (request, reply) => {
      try {
        const userId = getUserIdFromRequest(request);
        const scan = db.prepare('SELECT * FROM app_waf_security__waf_scans WHERE id = ? AND user_id = ?').get(request.params.id, userId);
        if (!scan) return reply.status(404).send({ error: 'Scan not found' });
        if (scan.results_json) { try { scan.results = JSON.parse(scan.results_json); } catch { scan.results = null; } delete scan.results_json; }
        return scan;
      } catch (err) { return send(reply, err); }
    });
    fastify.get('/scans', async (request, reply) => {
      try {
        const userId = getUserIdFromRequest(request);
        return { scans: db.prepare('SELECT id, target_url, scan_type, waf_detected, waf_type, risk_level, status, started_at, ended_at, created_at FROM app_waf_security__waf_scans WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(userId) };
      } catch (err) { return send(reply, err); }
    });
    fastify.delete('/scans/:id', async (request, reply) => {
      try {
        const userId = getUserIdFromRequest(request);
        const r = db.prepare('DELETE FROM app_waf_security__waf_scans WHERE id = ? AND user_id = ?').run(request.params.id, userId);
        if (r.changes === 0) return reply.status(404).send({ error: 'Scan not found' });
        return { success: true };
      } catch (err) { return send(reply, err); }
    });

    // ===================== Campaigns (kept) =====================
    const ownCampaign = (request, reply) => {
      const userId = getUserIdFromRequest(request);
      const campaign = getCampaign(db, request.params.id);
      if (!campaign || campaign.user_id !== userId) { reply.status(404).send({ error: 'Campaign not found' }); return null; }
      return campaign;
    };
    fastify.post('/campaigns', async (request, reply) => {
      try { return await createCampaign(db, getUserIdFromRequest(request), request.body || {}, { allowPrivate: allowPrivateTargets(api) }); }
      catch (err) { return send(reply, err, 400); }
    });
    fastify.get('/campaigns', async (request, reply) => {
      try { return { campaigns: listCampaigns(db, getUserIdFromRequest(request)) }; }
      catch (err) { return send(reply, err); }
    });
    fastify.get('/campaigns/:id', async (request, reply) => {
      try {
        const campaign = ownCampaign(request, reply);
        if (!campaign) return reply;
        const scans = db.prepare('SELECT * FROM app_waf_security__waf_campaign_scans WHERE campaign_id = ? ORDER BY run_number DESC, stage ASC').all(campaign.id);
        const comparisons = db.prepare('SELECT * FROM app_waf_security__waf_campaign_comparisons WHERE campaign_id = ? ORDER BY created_at DESC').all(campaign.id);
        return { ...campaign, scans, comparisons };
      } catch (err) { return send(reply, err); }
    });
    fastify.post('/campaigns/:id/run', async (request, reply) => {
      try {
        const campaign = ownCampaign(request, reply);
        if (!campaign) return reply;
        if (campaign.status === 'running') return reply.status(409).send({ error: 'Campaign is already running' });
        const allowPrivate = allowPrivateTargets(api);
        await checkTarget(campaign.target_domain, { allowPrivate });
        runCampaign(db, campaign.id, { allowPrivate }).catch((err) => console.error('[Campaign Run] Error:', err.message));
        return { campaignId: campaign.id, status: 'started' };
      } catch (err) { return send(reply, err, 400); }
    });
    fastify.delete('/campaigns/:id', async (request, reply) => {
      try { const campaign = ownCampaign(request, reply); if (!campaign) return reply; deleteCampaign(db, campaign.id); return { success: true }; }
      catch (err) { return send(reply, err); }
    });
    fastify.get('/campaigns/:id/score', async (request, reply) => {
      try {
        const campaign = ownCampaign(request, reply);
        if (!campaign) return reply;
        const latestScan = db.prepare("SELECT cs.*, s.results_json FROM app_waf_security__waf_campaign_scans cs INNER JOIN app_waf_security__waf_scans s ON cs.scan_id = s.id WHERE cs.campaign_id = ? AND cs.stage = 4 ORDER BY cs.run_number DESC LIMIT 1").get(campaign.id);
        if (!latestScan || !latestScan.results_json) return reply.status(404).send({ error: 'No completed scans found' });
        const scanResults = JSON.parse(latestScan.results_json);
        return { score: calculateSecurityScore(scanResults), recommendations: generateRecommendations(scanResults, calculateSecurityScore(scanResults)), scanId: latestScan.scan_id, runNumber: latestScan.run_number };
      } catch (err) { return send(reply, err); }
    });
  };
}
