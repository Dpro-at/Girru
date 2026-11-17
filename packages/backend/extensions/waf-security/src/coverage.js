/**
 * Coverage ledger helpers.
 *
 * Record every check that ran, including the ones that came back clean, so "no issue" is never
 * confused with "not checked". A scan writes one coverage row per check kind; the UI reads the
 * latest coverage for an asset to show what was and was not tested.
 */

import { randomUUID } from 'node:crypto';

/** Record one check outcome. result ∈ issue | ok | not-tested | error. */
export function recordCoverage(db, { userId, assetId = null, scanId = null, checkKind, result, detail = null }) {
  db.prepare(
    `INSERT INTO app_waf_security__coverage (id, user_id, asset_id, scan_id, check_kind, result, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), userId, assetId, scanId, checkKind, result, detail);
}

/** The coverage rows of one scan run. */
export function coverageForScan(db, scanId) {
  return db.prepare('SELECT check_kind, result, detail, created_at FROM app_waf_security__coverage WHERE scan_id = ? ORDER BY created_at ASC').all(scanId);
}

/**
 * A short coverage summary for an asset's latest scan: how many checks ran and how many were
 * clean, so the UI can say e.g. "12 checks, 9 clean, 2 issues, 1 not tested".
 */
export function coverageSummaryForAsset(db, userId, assetId) {
  const last = db.prepare(
    `SELECT scan_id FROM app_waf_security__coverage WHERE user_id = ? AND asset_id = ? AND scan_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`
  ).get(userId, assetId);
  if (!last) return { scanId: null, total: 0, ok: 0, issue: 0, notTested: 0, error: 0 };
  const rows = coverageForScan(db, last.scan_id);
  const count = (r) => rows.filter((x) => x.result === r).length;
  return {
    scanId: last.scan_id,
    total: rows.length,
    ok: count('ok'),
    issue: count('issue'),
    notTested: count('not-tested'),
    error: count('error'),
  };
}
