/**
 * Content-addressed evidence store.
 *
 * Every finding points to the exact bytes that prove it. Those bytes are stored once, keyed by
 * their own sha256, and a read re-hashes the stored body and refuses to return it if the hash no
 * longer matches. So a finding's evidence cannot be silently edited after the fact, and identical
 * evidence (e.g. the same banner seen twice) is stored once and shared. Evidence also carries a
 * role when it is bound to a finding (baseline / proof / supporting / verification).
 */

import { randomUUID, createHash } from 'node:crypto';

export class EvidenceError extends Error {}

const MAX_BODY = 256 * 1024; // keep evidence small; captured heads, not whole pages

export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * Store a piece of evidence and return { id, sha256 }. If the same bytes are already stored, the
 * existing row is reused (content-addressed, so storing twice is a no-op).
 */
export function putEvidence(db, { kind, body, meta = null }) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  if (text.length > MAX_BODY) throw new EvidenceError('Evidence body too large');
  const sha = sha256Hex(text);
  const existing = db.prepare('SELECT id, sha256 FROM app_waf_security__evidence WHERE sha256 = ? AND kind = ?').get(sha, kind);
  if (existing) return { id: existing.id, sha256: sha, reused: true };
  const id = randomUUID();
  db.prepare(
    'INSERT INTO app_waf_security__evidence (id, sha256, kind, body, meta_json) VALUES (?, ?, ?, ?, ?)'
  ).run(id, sha, kind, text, meta ? JSON.stringify(meta) : null);
  return { id, sha256: sha, reused: false };
}

/**
 * Read evidence by id, re-checking the hash. Throws EvidenceError if the stored body no longer
 * matches its recorded sha256 (tamper-evident), as the study of evidence-bound findings calls for.
 */
export function getEvidence(db, id) {
  const row = db.prepare('SELECT * FROM app_waf_security__evidence WHERE id = ?').get(id);
  if (!row) return null;
  if (sha256Hex(row.body) !== row.sha256) {
    throw new EvidenceError(`Evidence ${id} failed its integrity check (hash mismatch)`);
  }
  let meta = null;
  try { meta = row.meta_json ? JSON.parse(row.meta_json) : null; } catch { meta = null; }
  return { id: row.id, sha256: row.sha256, kind: row.kind, body: row.body, meta, created_at: row.created_at };
}

/** Bind a stored evidence row to a finding with a role. Idempotent per (finding, evidence). */
export function bindEvidence(db, findingId, evidenceId, role) {
  db.prepare(
    `INSERT OR IGNORE INTO app_waf_security__finding_evidence (finding_id, evidence_id, role)
     VALUES (?, ?, ?)`
  ).run(findingId, evidenceId, role);
}

/** All evidence bound to a finding, each with its role, hash re-checked. */
export function evidenceForFinding(db, findingId) {
  const rows = db.prepare(
    `SELECT fe.role, e.id, e.sha256, e.kind, e.body, e.meta_json, e.created_at
     FROM app_waf_security__finding_evidence fe
     JOIN app_waf_security__evidence e ON e.id = fe.evidence_id
     WHERE fe.finding_id = ?
     ORDER BY fe.created_at ASC`
  ).all(findingId);
  return rows.map((r) => {
    const ok = sha256Hex(r.body) === r.sha256;
    let meta = null;
    try { meta = r.meta_json ? JSON.parse(r.meta_json) : null; } catch { meta = null; }
    return { role: r.role, id: r.id, sha256: r.sha256, kind: r.kind, body: r.body, meta, created_at: r.created_at, integrity_ok: ok };
  });
}
