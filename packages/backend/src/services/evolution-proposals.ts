/**
 * Evolution proposals (S0-Q.23).
 *
 * The old Evolution cycle changed agents by itself (system prompt, the
 * agent's PERSONALITY.md and capabilities). Under D-PERSONALITY it only
 * proposes: each change is a pending row in evolution_proposals (migration
 * 077) and only the owner's approval applies it. Mirrors the personality
 * drift proposals (personality-store.ts, CORE-01c/01d): reviewHash, atomic
 * claim (`changes === 1`), CAS on the target's content hash, owner-only
 * decisions (enforced by the routes).
 *
 * Evolution never enables or changes capabilities, tool grants or
 * permissions. There is no proposal kind for that, and rollback refuses old
 * capability history rows.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isoUtc } from '../api/timestamps.js';
import { all, dialect, one, run, sql, type Step } from '../repositories/sql-steps.js';
import { forUpdate, nowIsoText } from '../db/pg/dialect.js';
import { orderedId } from '../repositories/ordered-id.js';
import { getAgentDir } from './agent-files.js';
import { storeP4Enabled } from './store-p4.js';
import { appendVersion, createPersonalityTextProposal, currentPersonalityStep, personalityTextStep, putPersonalityTextStep, PersonalityProposalError } from './personality-store.js';
import { writePersonalityView } from './personality-record.js';

export const EVOLUTION_PROPOSAL_KINDS = ['prompt_append', 'personality_text'] as const;
export type EvolutionProposalKind = (typeof EVOLUTION_PROPOSAL_KINDS)[number];
export const EVOLUTION_PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'stale', 'cancelled'] as const;
export type EvolutionProposalStatus = (typeof EVOLUTION_PROPOSAL_STATUSES)[number];

export const MAX_PROPOSED_TEXT_CHARS = 4000;
export const MAX_TITLE_CHARS = 200;
export const MAX_REASON_CHARS = 1000;
export const MAX_DECISION_NOTE_CHARS = 500;
/** Pending proposals per agent before Evolution stops filing new ones. */
export const MAX_PENDING_EVOLUTION_PROPOSALS = 50;
/** Author recorded on proposals filed by the Evolution cycle. */
export const EVOLUTION_AUTHOR = 'evolution';

/** Machine codes sent to clients. */
export type EvolutionProposalErrorCode =
  | 'invalid_input' | 'not_found' | 'already_decided' | 'stale' | 'review_changed' | 'review_hash_required'
  | 'already_rolled_back' | 'rollback_unsupported';

export class EvolutionProposalError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string, readonly code: EvolutionProposalErrorCode) { super(message); }
}

export interface EvolutionProposal {
  id: string;
  agentId: string;
  kind: EvolutionProposalKind;
  title: string;
  /** The text that approval appends (plain text, data only). */
  proposedText: string;
  reason: string;
  insightType: string | null;
  confidence: number | null;
  /** sha256 hex of the target content when proposed. */
  baseHash: string;
  source: 'evolution';
  status: EvolutionProposalStatus;
  createdBy: string;
  createdAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  appliedHistoryId: string | null;
  /**
   * sha256 hex of ['evolution-proposal-review/v1', id, agentId, kind, baseHash,
   * title, proposedText, reason]. Approve/reject/cancel must send it back as
   * expectedReviewHash.
   */
  reviewHash: string;
}

interface Row {
  id: string; agent_id: string; kind: string; title: string; proposed_text: string; reason: string;
  insight_type: string | null; confidence: number | null; base_hash: string; source: string; status: string;
  review_hash: string; created_by: string; created_at: string; decided_by: string | null; decided_at: string | null;
  decision_note: string | null; applied_history_id: string | null;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function evolutionProposalReviewHash(
  p: Pick<EvolutionProposal, 'id' | 'agentId' | 'kind' | 'baseHash' | 'title' | 'proposedText' | 'reason'>,
): string {
  return sha256(JSON.stringify(['evolution-proposal-review/v1', p.id, p.agentId, p.kind, p.baseHash, p.title, p.proposedText, p.reason]));
}

function fromRow(row: Row): EvolutionProposal {
  const p = {
    id: row.id, agentId: row.agent_id, kind: row.kind as EvolutionProposalKind, title: row.title,
    proposedText: row.proposed_text, reason: row.reason, insightType: row.insight_type, confidence: row.confidence,
    baseHash: row.base_hash, source: 'evolution' as const, status: row.status as EvolutionProposalStatus,
    createdBy: row.created_by, createdAt: isoUtc(row.created_at), decidedBy: row.decided_by,
    decidedAt: isoUtc(row.decided_at), decisionNote: row.decision_note, appliedHistoryId: row.applied_history_id,
  };
  // Recomputed from what is shown, so the reviewer approves exactly what they saw.
  return { ...p, reviewHash: evolutionProposalReviewHash(p) };
}

// --- target content ---------------------------------------------------------

function personalityPath(agentId: string): string {
  return path.join(getAgentDir(agentId), 'PERSONALITY.md');
}

/** Current PERSONALITY.md text, or '' when the file does not exist. */
function readPersonalitySync(agentId: string): string {
  try {
    return readFileSync(personalityPath(agentId), 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return '';
    throw err;
  }
}

function writePersonalitySync(agentId: string, content: string): void {
  mkdirSync(getAgentDir(agentId), { recursive: true });
  writeFileSync(personalityPath(agentId), content, 'utf-8');
}

/**
 * Current content of the proposal's target; null when the agent does not
 * exist. Inside a transaction the agent row is locked on PostgreSQL, so the
 * content that is hashed/compared is the content that gets changed.
 */
function* targetContent(agentId: string, kind: EvolutionProposalKind): Step<string | null> {
  const d = yield* dialect();
  const agent = yield* one<{ system_prompt: string | null }>(`SELECT system_prompt FROM agents_config WHERE id = ?${forUpdate(d)}`, agentId);
  if (!agent) return null;
  // STORE-MAP-01 P4 (G3): both kinds change the personality record's text; system_prompt is the owner's alone.
  if (storeP4Enabled()) return yield* personalityTextStep((yield* currentPersonalityStep(agentId))?.textHash ?? null);
  return kind === 'prompt_append' ? (agent.system_prompt ?? '') : readPersonalitySync(agentId);
}

/** P4: the new text becomes a version of the personality record (source 'evolution'), in the caller's transaction. */
function* setRecordText(agentId: string, text: string, by: string, note: string): Step<void> {
  const current = yield* currentPersonalityStep(agentId, { lock: true });
  if (!current) throw new EvolutionProposalError(404, 'Agent not found', 'not_found');
  yield* appendVersion(agentId, by, {
    traits: current.traits, preset: current.preset, dialect: current.dialect, locked: current.locked, lockedTraits: current.lockedTraits,
    source: 'evolution', basedOnVersion: current.version || null, note, textHash: yield* putPersonalityTextStep(text),
  });
}

// --- validation -------------------------------------------------------------

function text(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new EvolutionProposalError(400, `${field} is required (text)`, 'invalid_input');
  if (v.length > max) throw new EvolutionProposalError(400, `${field} must be at most ${max} characters`, 'invalid_input');
  return v;
}

function decisionNote(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new EvolutionProposalError(400, 'note must be text', 'invalid_input');
  if (v.length > MAX_DECISION_NOTE_CHARS) throw new EvolutionProposalError(400, `note must be at most ${MAX_DECISION_NOTE_CHARS} characters`, 'invalid_input');
  return v.trim() || null;
}

// --- read -------------------------------------------------------------------

function* proposalStep(agentId: string, id: string): Step<EvolutionProposal | null> {
  const row = yield* one<Row>('SELECT * FROM evolution_proposals WHERE id = ? AND agent_id = ?', id, agentId);
  return row ? fromRow(row) : null;
}

export function getEvolutionProposal(agentId: string, id: string): Promise<EvolutionProposal | null> {
  return sql().read(proposalStep(agentId, id));
}

/** Newest first (at most 200; ties on created_at by id). Null when the agent does not exist. */
export function listEvolutionProposals(agentId: string, status?: EvolutionProposalStatus): Promise<EvolutionProposal[] | null> {
  return sql().read((function* () {
    if (!(yield* one('SELECT 1 AS ok FROM agents_config WHERE id = ?', agentId))) return null;
    const rows = status
      ? yield* all<Row>('SELECT * FROM evolution_proposals WHERE agent_id = ? AND status = ? ORDER BY created_at DESC, id DESC LIMIT 200', agentId, status)
      : yield* all<Row>('SELECT * FROM evolution_proposals WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT 200', agentId);
    return rows.map(fromRow);
  })());
}

// --- create -----------------------------------------------------------------

export interface NewEvolutionProposal {
  kind: EvolutionProposalKind;
  title: string;
  proposedText: string;
  reason: string;
  insightType?: string | null;
  confidence?: number | null;
}

export type CreateOutcome =
  | { status: 'proposed'; proposal: EvolutionProposal }
  | { status: 'personality_proposed'; proposalId: string }
  | { status: 'skipped'; reason: 'agent_not_found' | 'pending_exists' | 'too_many_pending' | 'owner_instructions_only'; proposalId?: string };

/**
 * File a pending proposal. Nothing about the agent changes. The same text
 * for the same target that is already pending is not filed twice.
 */
export async function createEvolutionProposal(agentId: string, input: NewEvolutionProposal, createdBy: string = EVOLUTION_AUTHOR): Promise<CreateOutcome> {
  if (!EVOLUTION_PROPOSAL_KINDS.includes(input.kind)) throw new EvolutionProposalError(400, 'Unknown proposal kind', 'invalid_input');
  const title = text(input.title, 'title', MAX_TITLE_CHARS).trim();
  const proposedText = text(input.proposedText, 'proposedText', MAX_PROPOSED_TEXT_CHARS);
  const reason = text(input.reason, 'reason', MAX_REASON_CHARS).trim();
  const confidence = typeof input.confidence === 'number' && Number.isFinite(input.confidence) ? input.confidence : null;
  const insightType = typeof input.insightType === 'string' ? input.insightType.slice(0, 40) : null;
  const id = orderedId(); // sorts in creation order (list ties on created_at)
  // STORE-MAP-01 P4 (G3, T7d): Evolution suggests a personality text change in Personality review
  // (applied as a version only when the owner agrees); it never adds to the owner's instructions.
  if (storeP4Enabled()) {
    if (input.kind === 'prompt_append') return { status: 'skipped', reason: 'owner_instructions_only' };
    const base = await sql().read((function* () { const c = yield* currentPersonalityStep(agentId); return c ? yield* personalityTextStep(c.textHash) : null; })());
    if (base === null) return { status: 'skipped', reason: 'agent_not_found' };
    try {
      const p = await createPersonalityTextProposal(agentId, { text: base + proposedText, reason: `${title}: ${reason}`.slice(0, 1000), evidence: insightType ? [`insight:${insightType}`] : [] }, 'evolution', createdBy, 'evolution_text');
      return { status: 'personality_proposed', proposalId: p.id };
    } catch (err) {
      if (err instanceof PersonalityProposalError) return { status: 'skipped', reason: err.code === 'too_many_pending' ? 'too_many_pending' : 'pending_exists' };
      throw err;
    }
  }
  return sql().tx(function* (): Step<CreateOutcome> {
    // The agent row is locked (PostgreSQL): the dedup and the pending limit
    // are decided by one writer at a time.
    const base = yield* targetContent(agentId, input.kind);
    if (base === null) return { status: 'skipped', reason: 'agent_not_found' };
    const dup = yield* one<{ id: string }>(`SELECT id FROM evolution_proposals WHERE agent_id = ? AND kind = ? AND proposed_text = ? AND status = 'pending' LIMIT 1`,
      agentId, input.kind, proposedText);
    if (dup) return { status: 'skipped', reason: 'pending_exists', proposalId: dup.id };
    const pending = (yield* one<{ n: number }>(`SELECT COUNT(*) AS n FROM evolution_proposals WHERE agent_id = ? AND status = 'pending'`, agentId))!.n;
    if (pending >= MAX_PENDING_EVOLUTION_PROPOSALS) return { status: 'skipped', reason: 'too_many_pending' };
    const baseHash = sha256(base);
    const reviewHash = evolutionProposalReviewHash({ id, agentId, kind: input.kind, baseHash, title, proposedText, reason });
    yield* run(`
      INSERT INTO evolution_proposals (id, agent_id, kind, title, proposed_text, reason, insight_type, confidence, base_hash, review_hash, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, id, agentId, input.kind, title, proposedText, reason, insightType, confidence, baseHash, reviewHash, createdBy);
    return { status: 'proposed', proposal: (yield* proposalStep(agentId, id))! };
  });
}

// --- decide -----------------------------------------------------------------

const REVIEW_HASH = /^[0-9a-f]{64}$/;

function* decidable(agentId: string, id: string, expectedReviewHash: unknown): Step<EvolutionProposal> {
  const p = yield* proposalStep(agentId, id);
  if (!p) throw new EvolutionProposalError(404, 'Proposal not found', 'not_found');
  if (p.status !== 'pending') throw new EvolutionProposalError(409, `Proposal is already ${p.status}`, 'already_decided');
  if (typeof expectedReviewHash !== 'string' || !REVIEW_HASH.test(expectedReviewHash)) {
    throw new EvolutionProposalError(400, 'expectedReviewHash is required (the reviewHash of the proposal you reviewed)', 'review_hash_required');
  }
  if (expectedReviewHash !== p.reviewHash) {
    throw new EvolutionProposalError(409, 'The proposal changed since it was reviewed; open it again', 'review_changed');
  }
  return p;
}

/** Exactly one decision moves the row out of 'pending'. */
function* claim(agentId: string, id: string, status: Exclude<EvolutionProposalStatus, 'pending'>, decidedBy: string, note: string | null): Step<void> {
  const d = yield* dialect();
  const res = yield* run(`
    UPDATE evolution_proposals SET status = ?, decided_by = ?, decided_at = ${nowIsoText(d)}, decision_note = ?
    WHERE id = ? AND agent_id = ? AND status = 'pending'
  `, status, decidedBy, note, id, agentId);
  if (res.changes !== 1) throw new EvolutionProposalError(409, 'Proposal was already decided', 'already_decided');
}

const HISTORY_TYPE: Record<EvolutionProposalKind, string> = {
  prompt_append: 'prompt_update',
  personality_text: 'personality_text',
};

/**
 * Owner approves. One transaction: pending + reviewHash re-checked, the
 * target's content hash must still equal base_hash (else the row is marked
 * 'stale' and 409 `stale`), the claim, the change, a history row. The
 * PERSONALITY.md write happens inside the transaction, so a failed write
 * rolls the decision back.
 */
export async function approveEvolutionProposal(
  agentId: string, id: string, decidedBy: string, expectedReviewHash: unknown,
): Promise<{ proposal: EvolutionProposal; historyId: string }> {
  const historyId = randomUUID();
  const proposal = await sql().tx(function* () {
    const p = yield* decidable(agentId, id, expectedReviewHash);
    const before = yield* targetContent(agentId, p.kind);
    if (before === null) throw new EvolutionProposalError(404, 'Agent not found', 'not_found');
    if (sha256(before) !== p.baseHash) {
      yield* claim(agentId, id, 'stale', decidedBy, null);
      return null; // committed: the row stays 'stale'
    }
    yield* claim(agentId, id, 'approved', decidedBy, null);
    const after = before + p.proposedText;
    yield* run(`
      INSERT INTO agent_evolution_history (id, agent_id, evolution_type, change_description, before_value, after_value, trigger_reason, insight_ids, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `, historyId, agentId, HISTORY_TYPE[p.kind], `Approved proposal: ${p.title}`.slice(0, 300), before, after, p.reason,
      JSON.stringify([]));
    yield* run('UPDATE evolution_proposals SET applied_history_id = ? WHERE id = ? AND agent_id = ?', historyId, id, agentId);
    if (storeP4Enabled()) {
      yield* setRecordText(agentId, after, decidedBy, `Evolution: ${p.title}`.slice(0, 300));
    } else if (p.kind === 'prompt_append') {
      yield* run('UPDATE agents_config SET system_prompt = ?, updated_at = ? WHERE id = ?', after, new Date().toISOString(), agentId);
    } else {
      writePersonalitySync(agentId, after); // last step: a throw rolls everything back
    }
    return (yield* proposalStep(agentId, id))!;
  });
  if (!proposal) throw new EvolutionProposalError(409, 'The target changed after this proposal was made; it was marked stale', 'stale');
  if (storeP4Enabled()) await writePersonalityView(agentId).catch(() => {});
  return { proposal, historyId };
}

export async function rejectEvolutionProposal(
  agentId: string, id: string, decidedBy: string, expectedReviewHash: unknown, note?: unknown,
): Promise<EvolutionProposal> {
  const n = decisionNote(note);
  return sql().tx(function* () {
    yield* decidable(agentId, id, expectedReviewHash);
    yield* claim(agentId, id, 'rejected', decidedBy, n);
    return (yield* proposalStep(agentId, id))!;
  });
}

export async function cancelEvolutionProposal(
  agentId: string, id: string, decidedBy: string, expectedReviewHash: unknown,
): Promise<EvolutionProposal> {
  return sql().tx(function* () {
    yield* decidable(agentId, id, expectedReviewHash);
    yield* claim(agentId, id, 'cancelled', decidedBy, null);
    return (yield* proposalStep(agentId, id))!;
  });
}

// --- rollback of an applied change -----------------------------------------

/**
 * Undo one history row: restore before_value, only when the target still
 * holds exactly that row's after_value (else 409 `stale`: something changed
 * since, restoring would silently drop it). Only prompt and PERSONALITY.md
 * rows: old capability rows are refused (409 `rollback_unsupported`);
 * capabilities are changed by the owner in the agent settings, never by
 * Evolution.
 */
export async function rollbackEvolutionHistory(agentId: string, evolutionId: string): Promise<{ evolutionId: string; type: string }> {
  const type = await sql().tx(function* () {
    const d = yield* dialect();
    const h = yield* one<{ evolution_type: string; before_value: string | null; after_value: string | null; status: string }>(
      `SELECT * FROM agent_evolution_history WHERE id = ? AND agent_id = ?${forUpdate(d)}`, evolutionId, agentId);
    if (!h) throw new EvolutionProposalError(404, 'Evolution not found for this agent', 'not_found');
    if (h.status === 'rolled_back') throw new EvolutionProposalError(409, 'Evolution already rolled back', 'already_rolled_back');
    const type = h.evolution_type;
    const kind: EvolutionProposalKind | null = type === 'prompt_update' ? 'prompt_append' : type === 'personality_text' ? 'personality_text' : null;
    if (!kind) {
      throw new EvolutionProposalError(409, 'Only prompt and PERSONALITY.md changes can be rolled back here; capabilities are edited in the agent settings', 'rollback_unsupported');
    }
    const current = yield* targetContent(agentId, kind);
    if (current === null) throw new EvolutionProposalError(404, 'Agent not found', 'not_found');
    if (current !== (h.after_value ?? '')) {
      throw new EvolutionProposalError(409, 'The content changed after this evolution; it cannot be rolled back safely', 'stale');
    }
    const res = yield* run(`UPDATE agent_evolution_history SET status = 'rolled_back', rolled_back_at = ? WHERE id = ? AND status != 'rolled_back'`,
      new Date().toISOString(), evolutionId);
    if (res.changes !== 1) throw new EvolutionProposalError(409, 'Evolution already rolled back', 'already_rolled_back');
    if (storeP4Enabled()) {
      yield* setRecordText(agentId, h.before_value ?? '', 'owner', `Evolution rolled back: ${evolutionId}`);
    } else if (kind === 'prompt_append') {
      yield* run('UPDATE agents_config SET system_prompt = ?, updated_at = ? WHERE id = ?', h.before_value ?? '', new Date().toISOString(), agentId);
    } else {
      writePersonalitySync(agentId, h.before_value ?? '');
    }
    return type;
  });
  if (storeP4Enabled()) await writePersonalityView(agentId).catch(() => {});
  return { evolutionId, type };
}
