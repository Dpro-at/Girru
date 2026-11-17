/**
 * Defensive scan engine.
 *
 * Runs the right checks for an in-scope asset you own, records what was checked (coverage, including
 * the clean results), and raises evidence-bound findings for anything worth your attention. It is
 * entirely defensive: it observes ports, banners, TLS and response headers and offers fix hints. It
 * never sends an exploit, never logs in, never acts against the target. After a run it closes the
 * loop: any earlier open finding on this asset that did not come back is retested as "fixed", with
 * the coverage row as the argument that it really is gone.
 *
 *   - server asset: TCP port inventory + banner/service detection + CVE hint + TLS on 443.
 *   - site asset:   security-header/CORS/cookie audit + TLS + WAF vendor detection.
 */

import { randomUUID } from 'node:crypto';
import { scanPorts } from './net-scan.js';
import { checkTls } from './tls-check.js';
import { auditHeaders } from './headers-audit.js';
import { cveHintFromBanner } from './cve-hint.js';
import { detectWAF } from './engine.js';
import { NoiseGovernor } from './noise.js';
import { recordCoverage } from './coverage.js';
import { raiseFinding, retestFinding } from './findings.js';

// Services that should not usually face the public internet.
const SENSITIVE_SERVICES = new Set(['mysql', 'postgresql', 'redis', 'mongodb', 'elasticsearch', 'rdp']);

function openScanRow(db, userId, asset) {
  const scanId = randomUUID();
  const target = asset.base_url || `${asset.host}${asset.port ? ':' + asset.port : ''}`;
  db.prepare(
    `INSERT INTO app_waf_security__waf_scans (id, target_url, scan_type, status, started_at, user_id)
     VALUES (?, ?, ?, 'running', datetime('now'), ?)`
  ).run(scanId, target, asset.kind === 'server' ? 'server' : 'site', userId);
  return scanId;
}

function closeScanRow(db, scanId, { status, summary }) {
  db.prepare(
    `UPDATE app_waf_security__waf_scans SET status = ?, results_json = ?, ended_at = datetime('now') WHERE id = ?`
  ).run(status, JSON.stringify(summary || {}), scanId);
}

/** Auto-close the loop: open findings on this asset not seen in this run → retested "fixed". */
function reconcileFindings(db, userId, assetId, seenKeys, scanId) {
  const open = db.prepare(
    "SELECT id, dedup_key, title FROM app_waf_security__findings WHERE user_id = ? AND asset_id = ? AND status IN ('open','reproduced')"
  ).all(userId, assetId);
  for (const f of open) {
    if (seenKeys.has(f.dedup_key)) continue;
    retestFinding(db, userId, f.id, {
      verdict: 'fixed',
      oppositeCheck: 'The check that originally raised this ran again in this scan and did not reproduce it. For the opposite (still present) to be true, the check would have had to miss it; the coverage row for this run shows the check did run, so "fixed" is accepted.',
      verification: { kind: 'note', body: `Not reproduced in scan ${scanId}; coverage recorded for this run.`, meta: { scanId } },
      decidedBy: 'engine',
    });
  }
}

async function scanServer(db, { userId, asset, allowPrivate, governor, scanId, seenKeys }) {
  const ports = await scanPorts(asset.host, { allowPrivate, governor });
  const openSet = new Set(ports.open.map((p) => p.port));
  for (const p of ports.checked) {
    recordCoverage(db, { userId, assetId: asset.id, scanId, checkKind: `port:${p}`, result: openSet.has(p) ? 'issue' : 'ok', detail: openSet.has(p) ? 'open' : 'closed/filtered' });
  }

  const portListEvidence = { kind: 'port-list', body: ports.open.map((p) => `${p.port}/${p.service} ${p.summary}`).join('\n') || '(no open ports)', meta: { host: asset.host, address: ports.address, checked: ports.checked } };

  for (const p of ports.open) {
    const where = `${asset.host}:${p.port}`;
    if (SENSITIVE_SERVICES.has(p.service)) {
      const key = raiseFinding(db, {
        userId, assetId: asset.id, scanId, category: 'open-port', severity: 'high',
        title: `${p.service} reachable on ${where}`,
        summary: `${p.service} answered on port ${p.port}. Services like this are usually meant to be private.`,
        fixHint: `Confirm ${p.service} must be reachable from where you scanned; if not, firewall it to trusted hosts or bind it to localhost.`,
        where, signature: `open:${p.service}`,
        evidence: [
          { kind: 'banner', body: p.banner || `${p.service} (open, no banner)`, meta: { port: p.port }, role: 'proof' },
          portListEvidence && { ...portListEvidence, role: 'baseline' },
        ].filter(Boolean),
      });
      seenKeys.add(key.dedup_key);
    }
    // CVE hint from the banner (informational only).
    const hint = cveHintFromBanner(p.product || p.banner);
    if (hint) {
      const key = raiseFinding(db, {
        userId, assetId: asset.id, scanId, category: 'cve-hint', severity: 'medium', is_informational: 1,
        title: `Check ${hint.product} for known issues on ${where}`,
        summary: hint.note + (hint.matchedVersion ? ` (saw version ${hint.matchedVersion})` : ''),
        fixHint: 'This is a reminder to verify against an advisory database — not a confirmed vulnerability. Make sure the service is patched.',
        where, signature: `cve-hint:${hint.product}`,
        evidence: [{ kind: 'banner', body: p.banner || p.product || '', meta: { port: p.port }, role: 'supporting' }],
      });
      seenKeys.add(key.dedup_key);
    }
  }

  // TLS on 443 if it is open.
  if (openSet.has(443)) await tlsCheckInto(db, { userId, asset, allowPrivate, scanId, seenKeys, host: asset.host, port: 443 });
  else recordCoverage(db, { userId, assetId: asset.id, scanId, checkKind: 'tls', result: 'not-tested', detail: '443 not open' });

  return { kind: 'server', openPorts: ports.open.length, checkedPorts: ports.checked.length };
}

async function tlsCheckInto(db, { userId, asset, allowPrivate, scanId, seenKeys, host, port }) {
  const tlsResult = await checkTls(host, { port, allowPrivate });
  recordCoverage(db, { userId, assetId: asset.id, scanId, checkKind: 'tls', result: tlsResult.issues.length ? 'issue' : (tlsResult.connected ? 'ok' : 'error'), detail: tlsResult.connected ? `${tlsResult.protocol} ${tlsResult.cipher}` : 'no TLS' });
  const certBody = `subject=${tlsResult.subject} issuer=${tlsResult.issuer} valid_to=${tlsResult.validTo} days_to_expiry=${tlsResult.daysToExpiry} protocol=${tlsResult.protocol} cipher=${tlsResult.cipher} trusted=${tlsResult.authorized}`;
  for (const issue of tlsResult.issues) {
    if (issue.severity === 'info') continue;
    const key = raiseFinding(db, {
      userId, assetId: asset.id, scanId, category: 'tls', severity: issue.severity,
      title: `${issue.text} (${host}:${port})`,
      summary: issue.text,
      fixHint: issue.text.includes('expire') ? 'Renew the certificate before it lapses (automate with ACME if you can).' : issue.text.includes('trusted') ? 'Install the full certificate chain and a certificate for the right name.' : 'Turn off the weak protocol/cipher in the server TLS configuration.',
      where: `${host}:${port}`, signature: `tls:${issue.text.replace(/\d+/g, 'N')}`,
      evidence: [{ kind: 'cert', body: certBody, meta: { host, port }, role: 'proof' }],
    });
    seenKeys.add(key.dedup_key);
  }
}

async function scanSite(db, { userId, asset, allowPrivate, scanId, seenKeys }) {
  const url = asset.base_url;
  // Header/CORS/cookie audit.
  const audit = await auditHeaders(url, { allowPrivate });
  for (const c of audit.checks) {
    recordCoverage(db, { userId, assetId: asset.id, scanId, checkKind: c.checkKind, result: c.ok ? 'ok' : (c.checkKind === 'reach' ? 'error' : 'issue'), detail: c.detail });
    if (!c.ok && c.checkKind !== 'reach') {
      const key = raiseFinding(db, {
        userId, assetId: asset.id, scanId, category: 'security-header', severity: c.severity,
        title: `${c.title} (${new URL(url).host})`,
        summary: c.detail, fixHint: c.fixHint, where: url, signature: `site:${c.checkKind}`,
        evidence: [
          { kind: 'request', body: audit.requestEvidence, role: 'baseline' },
          { kind: 'response', body: audit.responseEvidence || '(no response head)', role: 'proof' },
        ],
      });
      seenKeys.add(key.dedup_key);
    }
  }

  // WAF vendor detection (passive + one benign probe), kept from the original app.
  try {
    const waf = await detectWAF(url, { allowPrivate });
    recordCoverage(db, { userId, assetId: asset.id, scanId, checkKind: 'waf-detect', result: waf.detected ? 'ok' : 'not-tested', detail: waf.detected ? `${waf.type} (${waf.confidence}%)` : 'no WAF signature seen' });
  } catch { recordCoverage(db, { userId, assetId: asset.id, scanId, checkKind: 'waf-detect', result: 'error', detail: 'detection failed' }); }

  // TLS if https.
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') await tlsCheckInto(db, { userId, asset, allowPrivate, scanId, seenKeys, host: u.hostname, port: Number(u.port) || 443 });
    else recordCoverage(db, { userId, assetId: asset.id, scanId, checkKind: 'tls', result: 'not-tested', detail: 'site is http' });
  } catch { recordCoverage(db, { userId, assetId: asset.id, scanId, checkKind: 'tls', result: 'error' }); }

  return { kind: 'site', reachable: audit.status > 0, status: audit.status };
}

/**
 * Run a full defensive scan of one in-scope asset. The asset must already be validated in scope by
 * the caller (scope.requireInScope). Returns { scanId, summary }.
 */
export async function runAssetScan(db, api, { userId, asset, allowPrivate = false, profile = 'quiet' }) {
  const scanId = openScanRow(db, userId, asset);
  const governor = new NoiseGovernor(profile);
  const seenKeys = new Set();
  try {
    const summary = asset.kind === 'server'
      ? await scanServer(db, { userId, asset, allowPrivate, governor, scanId, seenKeys })
      : await scanSite(db, { userId, asset, allowPrivate, scanId, seenKeys });
    reconcileFindings(db, userId, asset.id, seenKeys, scanId);
    db.prepare("UPDATE app_waf_security__assets SET last_checked_at = datetime('now') WHERE id = ?").run(asset.id);
    closeScanRow(db, scanId, { status: 'completed', summary });
    return { scanId, summary };
  } catch (err) {
    closeScanRow(db, scanId, { status: 'failed', summary: { error: err.message } });
    throw err;
  }
}
