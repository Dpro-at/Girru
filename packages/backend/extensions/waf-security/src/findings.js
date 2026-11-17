/**
 * Findings: evidence-bound, de-duplicated, and retestable.
 *
 * A finding is informational — what was seen, where, how serious, and a fix hint — never an
 * exploit or an action against the target. The program (not a model) owns each finding's identity:
 * a dedup key built from the asset, category, place and a short signature of the evidence, so
 * re-running a scan updates the same finding instead of piling up duplicates. Each finding is
 * raised together with the evidence that proves it, bound by role. A retest records
 * reproduced / fixed / inconclusive with an "argue the opposite" note, and always keeps the
 * original evidence while adding verification evidence.
 */

import { randomUUID } from 'node:crypto';
import { sha256Hex, putEvidence, bindEvidence, evidenceForFinding } from './evidence.js';

export class FindingError extends Error {}

/** Program-owned identity for a finding. Stable across re-runs; independent of wording. */
export function dedupKey({ assetId, category, where, signature }) {
  return sha256Hex([assetId || '', category || '', where || '', signature || ''].join('|')).slice(0, 32);
}

/**
 * Raise (or refresh) a finding and bind its evidence.
 *
 * @param evidence  array of { kind, body, meta, role } — stored content-addressed and bound by role.
 * Returns the finding row. If an open finding with the same identity exists, it is refreshed
 * (last_seen_at, severity, summary) and any new evidence is bound to it.
 */
export function raiseFinding(db, {
  userId, assetId = null, scanId = null, category, title, severity = 'low',
  summary = null, fixHint = null, where = null, signature = null, evidence = [],
}) {
  const key = dedupKey({ assetId, category, where, signature: signature ?? title });
  const existing = db.prepare('SELECT * FROM app_waf_security__findings WHERE user_id = ? AND dedup_key = ?').get(userId, key);

  let findingId;
  if (existing) {
    findingId = existing.id;
    db.prepare(
      `UPDATE app_waf_security__findings
       SET title = ?, severity = ?, summary = ?, fix_hint = ?, where_url = ?, scan_id = COALESCE(?, scan_id),
           last_seen_at = datetime('now'),
           status = CASE WHEN status IN ('fixed','ignored') THEN status ELSE 'open' END
       WHERE id = ?`
    ).run(title, severity, summary, fixHint, where, scanId, findingId);
  } else {
    findingId = randomUUID();
    db.prepare(
      `INSERT INTO app_waf_security__findings
        (id, user_id, asset_id, scan_id, category, title, severity, summary, fix_hint, where_url, dedup_key, status, is_informational)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1)`
    ).run(findingId, userId, assetId, scanId, category, title, severity, summary, fixHint, where, key);
  }

  for (const e of evidence) {
    const { id } = putEvidence(db, { kind: e.kind, body: e.body, meta: e.meta || null });
    bindEvidence(db, findingId, id, e.role || 'proof');
  }
  return getFinding(db, userId, findingId);
}

export function getFinding(db, userId, id) {
  return db.prepare('SELECT * FROM app_waf_security__findings WHERE id = ? AND user_id = ?').get(id, userId) || null;
}

export function listFindings(db, userId, { status = null, assetId = null, limit = 200 } = {}) {
  const where = ['user_id = ?'];
  const params = [userId];
  if (status) { where.push('status = ?'); params.push(status); }
  if (assetId) { where.push('asset_id = ?'); params.push(assetId); }
  params.push(limit);
  return db.prepare(
    `SELECT * FROM app_waf_security__findings WHERE ${where.join(' AND ')} ORDER BY
       CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
       last_seen_at DESC LIMIT ?`
  ).all(...params);
}

export function findingDetail(db, userId, id) {
  const finding = getFinding(db, userId, id);
  if (!finding) return null;
  const evidence = evidenceForFinding(db, id);
  const retests = db.prepare('SELECT * FROM app_waf_security__finding_retests WHERE finding_id = ? ORDER BY created_at DESC').all(id);
  return { ...finding, evidence, retests };
}

/**
 * Record a retest verdict. `verdict` ∈ reproduced | fixed | inconclusive. `oppositeCheck` is the
 * "argue the opposite" note: what would have to be true for the other verdict, and whether the
 * evidence rules it out — stored so a verdict is never accepted without that check. Optional
 * `verification` evidence ({kind, body, meta}) is bound as the 'verification' role; original
 * evidence is always kept.
 */
export function retestFinding(db, userId, id, { verdict, oppositeCheck = null, verification = null, decidedBy = 'engine' }) {
  if (!['reproduced', 'fixed', 'inconclusive'].includes(verdict)) throw new FindingError('verdict must be reproduced, fixed or inconclusive');
  const finding = getFinding(db, userId, id);
  if (!finding) throw new FindingError('Finding not found');

  let evidenceId = null;
  if (verification) {
    const { id: evId } = putEvidence(db, { kind: verification.kind || 'note', body: verification.body, meta: verification.meta || null });
    bindEvidence(db, id, evId, 'verification');
    evidenceId = evId;
  }

  db.prepare(
    `INSERT INTO app_waf_security__finding_retests (id, finding_id, verdict, opposite_check, evidence_id, decided_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), id, verdict, oppositeCheck, evidenceId, decidedBy);

  const nextStatus = verdict === 'fixed' ? 'fixed' : verdict === 'reproduced' ? 'reproduced' : 'inconclusive';
  db.prepare("UPDATE app_waf_security__findings SET status = ?, verdict_note = ?, last_seen_at = datetime('now') WHERE id = ?")
    .run(nextStatus, oppositeCheck, id);
  return findingDetail(db, userId, id);
}

/** Set a finding to ignored (reversible) or back to open. Confirmation is the route's concern. */
export function setFindingStatus(db, userId, id, status) {
  if (!['open', 'ignored'].includes(status)) throw new FindingError('status must be open or ignored');
  const finding = getFinding(db, userId, id);
  if (!finding) throw new FindingError('Finding not found');
  db.prepare("UPDATE app_waf_security__findings SET status = ?, last_seen_at = datetime('now') WHERE id = ?").run(status, id);
  return getFinding(db, userId, id);
}
