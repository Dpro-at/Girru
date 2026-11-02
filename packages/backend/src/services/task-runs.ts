/**
 * Durable task runs (CORE-08, R2): store, leases, durable steps, budget gate.
 *
 * A run executes one orchestrator task. Each model call and each tool call
 * is a step (`task_run_steps`) with a deterministic idempotency key:
 *   sha256(runId | stepIndex | kind | tool | canonical JSON of the input).
 * Before a step runs it is stored 'started'; after it finishes it is stored
 * 'completed' with its result (encrypted). On resume the executor walks the
 * same steps again from the start:
 *  - completed  -> the stored result is replayed, nothing runs again;
 *  - started    -> outcome unknown. Idempotent steps (model calls, tools
 *                  declared idempotent) run again with the same key.
 *                  Anything else (sends, payments, deletes, installs, writes)
 *                  is NOT repeated: the step becomes 'unknown' and the run
 *                  'waiting_approval' until the owner says what happened
 *                  (resolveUncertainStep) or cancels it;
 *  - waiting_approval -> the linked tool approval decides: still pending =
 *                  the run keeps waiting; executed/denied/expired/failed =
 *                  its outcome becomes the step result (never re-run).
 *
 * One worker per run: claimRun() is a single atomic UPDATE that only
 * succeeds when nobody holds a live lease. Every claim bumps
 * lease_generation (fencing token); every step write checks lease owner +
 * generation, so a stale worker that lost its lease cannot record or start
 * steps any more. A heartbeat renews the lease while the run works.
 *
 * Budget gate: max_steps counts fresh step executions (replays are free);
 * max_duration_ms counts active time summed over attempts (time while the
 * server was down or the run waited for the owner does not count).
 */

import { isoUtc } from '../api/timestamps.js';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { all, atomic, dialect, one, run, sql, type Step } from '../repositories/sql-steps.js';
import { forUpdate, greatest, insertOrIgnore, isParam, nowPlusText, nowText, offset } from '../db/pg/dialect.js';
import { getEncryptionService } from '../credentials/encryption.js';
import { orderedId } from '../repositories/ordered-id.js';
import { currentChatRun } from './chat-run-context.js';
import { decryptContract, encryptContract, type TaskContract, type Verdict, type VerificationStatus, contractView, type ContractView } from './task-contracts.js';

export type TaskRunStatus = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'started' | 'completed' | 'failed' | 'unknown' | 'waiting_approval' | 'retry';
export const ACTIVE_RUN_STATUSES: readonly TaskRunStatus[] = ['queued', 'running', 'waiting_approval'];

function envInt(name: string, fallback: number, min: number, max: number): number {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

/** Defaults (env overrides, read at call time). */
export function runDefaults() {
  const leaseMs = envInt('TASK_RUN_LEASE_MS', 30_000, 500, 600_000);
  return {
    maxSteps: envInt('TASK_RUN_MAX_STEPS', 60, 1, 10_000),
    maxDurationMs: envInt('TASK_RUN_MAX_DURATION_MS', 30 * 60_000, 1_000, 24 * 3_600_000),
    leaseMs,
    heartbeatMs: Math.max(100, Math.floor(leaseMs / 3)),
  };
}

/** This process's worker id (lease owner). */
export const WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/** Built-in tools without external side effects: safe to run again after an interruption. */
export const IDEMPOTENT_TOOLS: ReadonlySet<string> = new Set([
  'read', 'memory_search', 'memory_stats', 'storage_search',
]);

/**
 * True when a step for this tool may run again after an unknown outcome.
 * Tools that need owner approval or are exec-class never count as idempotent.
 */
export function isIdempotentTool(
  tool: { name: string; idempotent?: boolean; execClass?: boolean } | undefined,
  needsApproval: boolean,
): boolean {
  if (!tool || needsApproval || tool.execClass) return false;
  return IDEMPOTENT_TOOLS.has(tool.name) || tool.idempotent === true;
}

/** Deterministic JSON (sorted keys). */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v)).join(',')}]`;
  const keys = Object.keys(value as object).filter((k) => (value as any)[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(',')}}`;
}

export function idempotencyKey(runId: string, stepIndex: number, kind: 'model' | 'tool', name: string, input: unknown): string {
  const inputHash = createHash('sha256').update(canonical(input)).digest('hex');
  return createHash('sha256').update(`${runId}|${stepIndex}|${kind}|${name}|${inputHash}`).digest('hex');
}

// ---------------------------------------------------------------------------
// Errors that stop an attempt
// ---------------------------------------------------------------------------

export class LeaseLostError extends Error { constructor() { super('lease lost'); } }
export class BudgetExceededError extends Error { constructor(readonly which: 'steps' | 'duration' | 'cost', detail: string) { super(`budget: ${detail}`); } }
export class RunCancelledError extends Error { constructor() { super('cancelled'); } }
export class ReplayMismatchError extends Error { constructor(index: number) { super(`replay mismatch at step ${index}: the stored step has a different input`); } }
/** The run paused (waits for the owner); not a failure. */
export class RunPausedError extends Error { constructor(readonly reason: string) { super(`paused: ${reason}`); } }

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface TaskRunRow {
  id: string; task_id: string; agent_id: string; user_id: string | null;
  status: TaskRunStatus; status_reason: string | null;
  lease_owner: string | null; lease_expires_at: number | null; lease_generation: number;
  attempt: number; checkpoint_step: number; steps_used: number;
  max_steps: number; max_duration_ms: number; active_ms: number; segment_started_ms: number | null;
  cancel_requested: number;
  input_encrypted: string | null; input_iv: string | null; input_tag: string | null;
  output_preview: string | null;
  created_at: string; started_at: string | null; updated_at: string; finished_at: string | null;
  // R1 / R2 (migration 068)
  contract_encrypted: string | null; contract_iv: string | null; contract_tag: string | null;
  verification_status: VerificationStatus | null; verification_reasons: string | null;
  verification_round: number; max_verification_retries: number;
  review_mode: string | null; review_decision: 'accepted' | 'rejected' | null;
  reviewed_by: string | null; reviewer_kind: string | null; review_note: string | null; reviewed_at: string | null;
  max_cost_cents: number | null; cost_cents: number;
}

export interface TaskRunStepRow {
  run_id: string; step_index: number; kind: 'model' | 'tool'; tool_name: string | null;
  idempotency_key: string; idempotent: number; status: StepStatus; attempt: number;
  approval_id: string | null;
  result_encrypted: string | null; result_iv: string | null; result_tag: string | null;
  error: string | null; resolved_by: string | null; started_at: string; completed_at: string | null;
  provider: string | null; model: string | null; input_tokens: number | null; output_tokens: number | null;
  cost_cents: number | null; usage_source: string | null;
}

/** The run row; `lock` (inside a transaction): FOR UPDATE on PostgreSQL. */
function* runRow(id: string, lock = false): Step<TaskRunRow | undefined> {
  const d = yield* dialect();
  return yield* one<TaskRunRow>(`SELECT * FROM task_runs WHERE id = ?${lock ? forUpdate(d) : ''}`, id);
}

export function getRun(id: string): Promise<TaskRunRow | undefined> {
  return sql().read(runRow(id));
}

function* activeRunStep(taskId: string): Step<TaskRunRow | undefined> {
  return yield* one<TaskRunRow>(`SELECT * FROM task_runs WHERE task_id = ? AND status IN ('queued', 'running', 'waiting_approval') LIMIT 1`, taskId);
}

export function activeRunForTask(taskId: string): Promise<TaskRunRow | undefined> {
  return sql().read(activeRunStep(taskId));
}

function* stepsOf(runId: string): Step<TaskRunStepRow[]> {
  return yield* all<TaskRunStepRow>('SELECT * FROM task_run_steps WHERE run_id = ? ORDER BY step_index', runId);
}

export function getSteps(runId: string): Promise<TaskRunStepRow[]> {
  return sql().read(stepsOf(runId));
}

export interface CreateRunInput {
  taskId: string;
  agentId: string;
  userId?: string | null;
  prompt: string;
  maxSteps?: number;
  maxDurationMs?: number;
  /** R1: the task's contract, pinned on the run (its budget may only lower the limits). */
  contract?: TaskContract | null;
}

/** Create a queued run, or return the task's unfinished run (one per task). */
export async function createRun(input: CreateRunInput): Promise<TaskRunRow> {
  const existing = await activeRunForTask(input.taskId);
  if (existing) return existing;
  const d = runDefaults();
  const { encrypted, iv, authTag } = await getEncryptionService().encrypt(JSON.stringify({ prompt: input.prompt }));
  const id = orderedId(); // sorts in creation order (listRuns ties on created_at)
  const contract = input.contract ?? null;
  let maxSteps = clampInt(input.maxSteps, d.maxSteps, 1, 10_000);
  let maxDurationMs = clampInt(input.maxDurationMs, d.maxDurationMs, 1, 24 * 3_600_000);
  if (contract?.budget?.maxSteps) maxSteps = Math.min(maxSteps, contract.budget.maxSteps);
  if (contract?.budget?.maxDurationMs) maxDurationMs = Math.min(maxDurationMs, contract.budget.maxDurationMs);
  const enc = contract ? await encryptContract(contract) : null;
  // RUNS-01: a run an agent starts from a chat reply (a small helper) is that reply's sub-task.
  const parentRun = currentChatRun()?.runId;
  return sql().read((function* () {
    try {
      // Its own transaction (a SAVEPOINT inside a caller's): on PostgreSQL a
      // failed INSERT must not abort the caller's transaction.
      yield* atomic(() => run(`
        INSERT INTO task_runs (id, task_id, agent_id, user_id, status, max_steps, max_duration_ms, input_encrypted, input_iv, input_tag,
          contract_encrypted, contract_iv, contract_tag, max_verification_retries, review_mode, max_cost_cents, parent_run_id)
        VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, id, input.taskId, input.agentId, input.userId ?? null, maxSteps, maxDurationMs,
        encrypted, iv, authTag,
        enc?.encrypted ?? null, enc?.iv ?? null, enc?.authTag ?? null,
        contract ? contract.maxVerificationRetries : 0, contract?.review ?? null,
        contract?.budget?.maxCostCents ?? null, parentRun ? `chat:${parentRun}` : null));
    } catch (err: any) {
      // Another process created the task's run at the same moment (one active run per task).
      const raced = yield* activeRunStep(input.taskId);
      if (raced) return raced;
      throw err;
    }
    return (yield* runRow(id))!;
  })());
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export async function runPrompt(run: TaskRunRow): Promise<string> {
  if (!run.input_encrypted || !run.input_iv || !run.input_tag) return '';
  const plain = await getEncryptionService().decrypt(run.input_encrypted, run.input_iv, run.input_tag);
  return String(JSON.parse(plain).prompt ?? '');
}

/** R1: the contract pinned on a run (null = no contract). */
export async function runContract(run: Pick<TaskRunRow, 'contract_encrypted' | 'contract_iv' | 'contract_tag'>): Promise<TaskContract | null> {
  return decryptContract(run.contract_encrypted, run.contract_iv, run.contract_tag);
}

export interface Lease { runId: string; owner: string; generation: number }

/**
 * Atomic claim: succeeds only for a queued run, or a running run whose lease
 * expired. Exactly one of several concurrent claimers wins.
 */
export function claimRun(runId: string, owner = WORKER_ID, now = Date.now()): Promise<Lease | null> {
  const { leaseMs } = runDefaults();
  return sql().read((function* () {
    const d = yield* dialect();
    // One UPDATE: on PostgreSQL a concurrent claimer waits on the row lock and
    // then re-checks the WHERE (READ COMMITTED), so exactly one wins.
    const res = yield* run(`
      UPDATE task_runs SET
        status = 'running', status_reason = NULL,
        lease_owner = ?, lease_expires_at = ?, lease_generation = lease_generation + 1,
        attempt = attempt + 1, segment_started_ms = ?,
        started_at = COALESCE(started_at, ${nowText(d)}), updated_at = ${nowText(d)}
      WHERE id = ? AND cancel_requested = 0 AND (
        status = 'queued' OR (status = 'running' AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ?))
      )
    `, owner, now + leaseMs, now, runId, now);
    if (res.changes !== 1) return null;
    const row = (yield* runRow(runId))!;
    return { runId, owner, generation: row.lease_generation };
  })());
}

const FENCE = `id = ? AND lease_owner = ? AND lease_generation = ? AND status = 'running'`;

/** Renew the lease and fold active time. False = lease lost. */
export function heartbeat(lease: Lease, now = Date.now()): Promise<boolean> {
  const { leaseMs } = runDefaults();
  return sql().read((function* () {
    const d = yield* dialect();
    const res = yield* run(`
      UPDATE task_runs SET lease_expires_at = ?,
        active_ms = active_ms + ${greatest(d)}(0, ? - COALESCE(segment_started_ms, ?)), segment_started_ms = ?, updated_at = ${nowText(d)}
      WHERE ${FENCE}
    `, now + leaseMs, now, now, now, lease.runId, lease.owner, lease.generation);
    return res.changes === 1;
  })());
}

/**
 * The lease is still ours. Inside a transaction (`lock`) the run row is
 * locked on PostgreSQL, so a concurrent claim cannot take the lease between
 * this check and the write that follows it (SQLite: the write transaction is
 * exclusive already).
 */
function* holdsLeaseStep(lease: Lease, lock = false): Step<boolean> {
  const d = yield* dialect();
  return !!(yield* one(`SELECT 1 AS ok FROM task_runs WHERE ${FENCE}${lock ? forUpdate(d) : ''}`, lease.runId, lease.owner, lease.generation));
}

export function holdsLease(lease: Lease): Promise<boolean> {
  return sql().read(holdsLeaseStep(lease));
}

/** Leave the running state (fenced). Folds active time and releases the lease. */
export function finishAttempt(lease: Lease, status: TaskRunStatus, reason: string | null, outputPreview?: string | null): Promise<boolean> {
  const now = Date.now();
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  return sql().read((function* () {
    const d = yield* dialect();
    const res = yield* run(`
      UPDATE task_runs SET status = ?, status_reason = ?,
        output_preview = COALESCE(?, output_preview),
        active_ms = active_ms + ${greatest(d)}(0, ? - COALESCE(segment_started_ms, ?)), segment_started_ms = NULL,
        lease_owner = NULL, lease_expires_at = NULL,
        finished_at = CASE WHEN ? = 1 THEN ${nowText(d)} ELSE finished_at END,
        updated_at = ${nowText(d)}
      WHERE ${FENCE}
    `, status, reason, outputPreview ?? null, now, now, terminal ? 1 : 0, lease.runId, lease.owner, lease.generation);
    return res.changes === 1;
  })());
}

export function elapsedMs(run: TaskRunRow, now = Date.now()): number {
  return run.active_ms + (run.segment_started_ms ? Math.max(0, now - run.segment_started_ms) : 0);
}

// ---------------------------------------------------------------------------
// Durable steps
// ---------------------------------------------------------------------------

async function encryptJson(value: unknown) {
  return getEncryptionService().encrypt(JSON.stringify(value ?? null));
}

async function stepResult<T>(row: TaskRunStepRow): Promise<T> {
  if (!row.result_encrypted || !row.result_iv || !row.result_tag) return null as T;
  return JSON.parse(await getEncryptionService().decrypt(row.result_encrypted, row.result_iv, row.result_tag)) as T;
}

/** Store a completed step result (fenced by the lease). */
async function completeStep(lease: Lease, index: number, result: unknown, extra: { resolvedBy?: string } = {}): Promise<void> {
  const enc = await encryptJson(result);
  await sql().tx(function* () {
    const d = yield* dialect();
    if (!(yield* holdsLeaseStep(lease, true))) throw new LeaseLostError();
    yield* run(`
      UPDATE task_run_steps SET status = 'completed', result_encrypted = ?, result_iv = ?, result_tag = ?,
        error = NULL, completed_at = ${nowText(d)}, resolved_by = COALESCE(?, resolved_by)
      WHERE run_id = ? AND step_index = ?
    `, enc.encrypted, enc.iv, enc.authTag, extra.resolvedBy ?? null, lease.runId, index);
    yield* run(`UPDATE task_runs SET checkpoint_step = ${greatest(d)}(checkpoint_step, ?), updated_at = ${nowText(d)} WHERE id = ?`,
      index, lease.runId);
  });
}

function setStepStatus(lease: Lease, index: number, status: StepStatus, error: string | null, approvalId?: string | null): Promise<void> {
  return sql().tx(function* () {
    if (!(yield* holdsLeaseStep(lease, true))) throw new LeaseLostError();
    yield* run(`UPDATE task_run_steps SET status = ?, error = ?, approval_id = COALESCE(?, approval_id) WHERE run_id = ? AND step_index = ?`,
      status, error, approvalId ?? null, lease.runId, index);
  });
}

/** Budget + cancellation check before a fresh execution; reserves one step. */
function reserveFreshStep(lease: Lease): Promise<number> {
  return sql().tx(function* () {
    const run_ = yield* runRow(lease.runId, true);
    if (!run_ || run_.lease_owner !== lease.owner || run_.lease_generation !== lease.generation || run_.status !== 'running') throw new LeaseLostError();
    if (run_.cancel_requested) throw new RunCancelledError();
    if (run_.steps_used >= run_.max_steps) throw new BudgetExceededError('steps', `max steps ${run_.max_steps} reached`);
    const elapsed = elapsedMs(run_);
    if (elapsed >= run_.max_duration_ms) throw new BudgetExceededError('duration', `max duration ${run_.max_duration_ms} ms reached`);
    yield* run(`UPDATE task_runs SET steps_used = steps_used + 1 WHERE id = ?`, lease.runId);
    return run_.max_duration_ms - elapsed;
  });
}

export interface StepSpec<T> {
  kind: 'model' | 'tool';
  /** 'model' or the tool name. */
  name: string;
  /** Hashed into the idempotency key (not stored). */
  input: unknown;
  idempotent: boolean;
  /** Runs the step. `key` is the step's idempotency key. */
  run: (key: string, stepIndex: number) => Promise<T>;
  /** When the result says "waiting for approval", its approval id (the run pauses). */
  pendingApprovalOf?: (result: T) => string | null;
  /** Result recorded when a linked approval was decided (tool steps). */
  approvalOutcome?: (approval: { status: string; result_preview: string | null; error: string | null }) => T;
}

export interface StepOutcome<T> { result: T; replayed: boolean }

const APPROVAL_FINAL = new Set(['executed', 'denied', 'expired', 'failed']);

type ApprovalRow = { id: string; status: string; result_preview: string | null; error: string | null; tool_name: string };

function approvalFor(runId: string, index: number, approvalId: string | null): Promise<ApprovalRow | undefined> {
  if (approvalId) {
    return sql().read(one<ApprovalRow>('SELECT id, status, result_preview, error, tool_name FROM tool_approvals WHERE id = ?', approvalId));
  }
  return sql().read(one<ApprovalRow>('SELECT id, status, result_preview, error, tool_name FROM tool_approvals WHERE run_id = ? AND run_step = ? ORDER BY requested_at DESC LIMIT 1',
    runId, index));
}

/** Expire pending approvals past their TTL (same rule as tools/approvals.ts; requested_at is TEXT). */
function* expireApprovalsStep(): Step<void> {
  const d = yield* dialect();
  yield* run(`UPDATE tool_approvals SET status = 'expired' WHERE status = 'pending' AND requested_at < ${nowPlusText(d)}`, offset(-24, 'hours'));
}

/**
 * Run (or replay) one step. Throws RunPausedError when the run must wait for
 * the owner, LeaseLostError / BudgetExceededError / RunCancelledError /
 * ReplayMismatchError to stop the attempt.
 */
export async function durableStep<T>(lease: Lease, index: number, spec: StepSpec<T>): Promise<StepOutcome<T>> {
  const key = idempotencyKey(lease.runId, index, spec.kind, spec.name, spec.input);
  const row = await sql().read(one<TaskRunStepRow>('SELECT * FROM task_run_steps WHERE run_id = ? AND step_index = ?', lease.runId, index));

  let attempt = 1;
  if (row) {
    if (row.idempotency_key !== key) throw new ReplayMismatchError(index);
    if (row.status === 'completed') return { result: await stepResult<T>(row), replayed: true };
    if (row.status === 'failed') throw new Error(`step ${index} failed earlier: ${row.error ?? 'unknown error'}`);

    // An approval linked to this step decides it (also when the crash came
    // after the approval was stored but before the step was marked).
    if (row.status === 'waiting_approval' || row.status === 'started' || row.status === 'unknown') {
      await sql().read(expireApprovalsStep());
      const approval = spec.kind === 'tool' ? await approvalFor(lease.runId, index, row.approval_id) : undefined;
      if (approval && approval.tool_name === spec.name) {
        if (APPROVAL_FINAL.has(approval.status) && spec.approvalOutcome) {
          const result = spec.approvalOutcome(approval);
          await completeStep(lease, index, result);
          return { result, replayed: true };
        }
        await setStepStatus(lease, index, 'waiting_approval', null, approval.id);
        throw new RunPausedError('approval');
      }
    }

    if (row.status === 'waiting_approval') {
      // Approval row missing: never guess; the owner decides.
      await setStepStatus(lease, index, 'unknown', 'linked approval not found');
      throw new RunPausedError(`uncertain_step:${index}`);
    }
    if ((row.status === 'started' || row.status === 'unknown') && !row.idempotent) {
      await setStepStatus(lease, index, 'unknown', 'interrupted after it started; it may or may not have happened. Not repeated automatically.');
      throw new RunPausedError(`uncertain_step:${index}`);
    }
    // idempotent started/unknown, or owner-chosen retry: run again with the same key
    attempt = row.attempt + 1;
  }

  const remainingMs = await reserveFreshStep(lease);
  await sql().tx(function* () {
    const d = yield* dialect();
    if (!(yield* holdsLeaseStep(lease, true))) throw new LeaseLostError();
    if (row) {
      yield* run(`UPDATE task_run_steps SET status = 'started', attempt = ?, error = NULL, started_at = ${nowText(d)} WHERE run_id = ? AND step_index = ?`,
        attempt, lease.runId, index);
    } else {
      yield* run(`
        INSERT INTO task_run_steps (run_id, step_index, kind, tool_name, idempotency_key, idempotent, status, attempt)
        VALUES (?, ?, ?, ?, ?, ?, 'started', 1)
      `, lease.runId, index, spec.kind, spec.kind === 'tool' ? spec.name : null, key, spec.idempotent ? 1 : 0);
    }
  });

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BudgetExceededError('duration', 'max duration reached during a step')), Math.max(1, remainingMs));
    timer.unref?.();
  });
  let result: T;
  try {
    result = await Promise.race([spec.run(key, index), timeout]);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      // Outcome of the interrupted step is unknown.
      const why = err.which === 'cost' ? err.message.slice(0, 300) : 'stopped by the duration budget while running';
      try { await setStepStatus(lease, index, spec.idempotent || err.which === 'cost' ? 'failed' : 'unknown', why); } catch { /* lease gone */ }
      throw err;
    }
    try { await setStepStatus(lease, index, 'failed', String((err as any)?.message ?? err).slice(0, 300)); } catch { /* lease gone */ }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const approvalId = spec.pendingApprovalOf?.(result) ?? null;
  if (approvalId) {
    await setStepStatus(lease, index, 'waiting_approval', null, approvalId);
    throw new RunPausedError('approval');
  }
  await completeStep(lease, index, result);
  return { result, replayed: false };
}

// ---------------------------------------------------------------------------
// Owner actions + approval hook
// ---------------------------------------------------------------------------

type RecoveryKick = () => void;
let kick: RecoveryKick | null = null;
/** The recovery loop registers itself so decided approvals continue promptly. */
export function setRecoveryKick(fn: RecoveryKick | null): void { kick = fn; }

/** Called by tools/approvals.ts after an approval was executed/failed/denied. */
export async function onApprovalDecided(approvalId: string): Promise<void> {
  try {
    const changed = await sql().read((function* () {
      const d = yield* dialect();
      const a = yield* one<{ run_id: string | null }>('SELECT run_id FROM tool_approvals WHERE id = ?', approvalId);
      if (!a?.run_id) return false;
      const res = yield* run(`
        UPDATE task_runs SET status = 'queued', status_reason = 'approval decided', updated_at = ${nowText(d)}
        WHERE id = ? AND status = 'waiting_approval' AND status_reason = 'approval' AND cancel_requested = 0
      `, a.run_id);
      return res.changes === 1;
    })());
    if (changed) kick?.();
  } catch (err: any) {
    console.warn('[TaskRuns] could not continue run after approval:', err?.message);
  }
}

/**
 * Runs waiting for an approval that has been decided meanwhile (e.g. the
 * decision came while this process was down) are queued again.
 */
export function requeueDecidedApprovalRuns(): Promise<number> {
  return sql().read((function* () {
    const d = yield* dialect();
    yield* expireApprovalsStep();
    const res = yield* run(`
      UPDATE task_runs SET status = 'queued', status_reason = 'approval decided', updated_at = ${nowText(d)}
      WHERE status = 'waiting_approval' AND status_reason = 'approval' AND cancel_requested = 0
        AND EXISTS (SELECT 1 FROM task_run_steps s JOIN tool_approvals a ON a.id = s.approval_id
                    WHERE s.run_id = task_runs.id AND s.status = 'waiting_approval'
                      AND a.status IN ('executed', 'denied', 'expired', 'failed'))
    `);
    return res.changes;
  })());
}

export class RunStateError extends Error { constructor(message: string, readonly status: number) { super(message); } }

/**
 * Cancel a run. Queued/waiting runs (or running runs whose lease expired)
 * stop at once; a live running run stops before its next step. Pending
 * approvals of the run are denied so they can never run later.
 */
export function cancelRun(runId: string, actor: string): Promise<TaskRunRow> {
  const now = Date.now();
  return sql().tx(function* () {
    const d = yield* dialect();
    const r = yield* runRow(runId, true);
    if (!r) throw new RunStateError('Run not found', 404);
    if (!ACTIVE_RUN_STATUSES.includes(r.status)) throw new RunStateError(`Run is ${r.status}`, 409);
    yield* run(`UPDATE task_runs SET cancel_requested = 1, updated_at = ${nowText(d)} WHERE id = ?`, runId);
    const live = r.status === 'running' && r.lease_owner && (r.lease_expires_at ?? 0) >= now;
    if (!live) {
      yield* run(`
        UPDATE task_runs SET status = 'cancelled', status_reason = ?, lease_owner = NULL, lease_expires_at = NULL,
          segment_started_ms = NULL, finished_at = ${nowText(d)}, updated_at = ${nowText(d)}
        WHERE id = ?
      `, `cancelled by ${actor}`, runId);
    }
    yield* run(`
      UPDATE tool_approvals SET status = 'denied', decided_at = ${nowText(d)}, decided_by = 'run-cancelled'
      WHERE run_id = ? AND status = 'pending'
    `, runId);
    return (yield* runRow(runId))!;
  });
}

export type UncertainOutcome = 'done' | 'skip' | 'retry';

/**
 * Owner decision for a step whose outcome is unknown after an interruption:
 *  - done:  it happened; it is recorded as completed and not repeated;
 *  - skip:  it is recorded as not done; the agent is told and continues;
 *  - retry: it runs again (same idempotency key) when the run resumes.
 */
export async function resolveUncertainStep(runId: string, stepIndex: number, outcome: UncertainOutcome, ownerId: string): Promise<TaskRunRow> {
  const r = await getRun(runId);
  if (!r) throw new RunStateError('Run not found', 404);
  const step = await sql().read(one<TaskRunStepRow>('SELECT * FROM task_run_steps WHERE run_id = ? AND step_index = ?', runId, stepIndex));
  if (!step) throw new RunStateError('Step not found', 404);
  if (r.status !== 'waiting_approval' || step.status !== 'unknown' || r.status_reason !== `uncertain_step:${stepIndex}`) {
    throw new RunStateError('This step is not waiting for an owner decision', 409);
  }
  let enc: { encrypted: string; iv: string; authTag: string } | null = null;
  if (outcome !== 'retry') {
    const text = outcome === 'done'
      ? `The owner confirmed this action already happened before an interruption; it was not repeated.`
      : `The owner chose not to run this action after an interruption; it was not run.`;
    const result = { content: [{ type: 'text', text }], ...(outcome === 'skip' ? { error: 'skipped by owner' } : {}) };
    enc = await encryptJson(result);
  }
  const out = await sql().tx(function* () {
    const d = yield* dialect();
    const cur = (yield* runRow(runId, true))!;
    if (cur.status !== 'waiting_approval' || cur.status_reason !== `uncertain_step:${stepIndex}`) throw new RunStateError('Run changed meanwhile', 409);
    if (enc) {
      yield* run(`
        UPDATE task_run_steps SET status = 'completed', result_encrypted = ?, result_iv = ?, result_tag = ?,
          completed_at = ${nowText(d)}, resolved_by = ? WHERE run_id = ? AND step_index = ?
      `, enc.encrypted, enc.iv, enc.authTag, `${ownerId}:${outcome}`, runId, stepIndex);
    } else {
      yield* run(`UPDATE task_run_steps SET status = 'retry', resolved_by = ? WHERE run_id = ? AND step_index = ?`,
        `${ownerId}:retry`, runId, stepIndex);
    }
    yield* run(`UPDATE task_runs SET status = 'queued', status_reason = ?, updated_at = ${nowText(d)} WHERE id = ?`,
      `owner resolved step ${stepIndex}: ${outcome}`, runId);
    return (yield* runRow(runId))!;
  });
  kick?.();
  return out;
}

/** Runs a recovery worker may claim now: queued, or running with an expired lease. */
export function claimableRunIds(now = Date.now(), limit = 20): Promise<string[]> {
  return sql().read((function* () {
    const rows = yield* all<{ id: string }>(`
      SELECT id FROM task_runs
      WHERE cancel_requested = 0 AND (status = 'queued' OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < ?)))
      ORDER BY created_at LIMIT ?
    `, now, limit);
    return rows.map((r) => r.id);
  })());
}

/** Running runs whose lease expired and that were asked to cancel: cancel them now. */
export function settleCancelledDeadRuns(now = Date.now()): Promise<number> {
  return sql().read((function* () {
    const d = yield* dialect();
    return (yield* run(`
      UPDATE task_runs SET status = 'cancelled', status_reason = COALESCE(status_reason, 'cancelled'),
        lease_owner = NULL, lease_expires_at = NULL, segment_started_ms = NULL,
        finished_at = ${nowText(d)}, updated_at = ${nowText(d)}
      WHERE cancel_requested = 1 AND status IN ('queued', 'running') AND (status = 'queued' OR lease_expires_at IS NULL OR lease_expires_at < ?)
    `, now)).changes;
  })());
}

// ---------------------------------------------------------------------------
// Views (no secrets: no inputs, no results, no parameters)
// ---------------------------------------------------------------------------

export interface TaskRunView {
  id: string; taskId: string; agentId: string; userId: string | null;
  status: TaskRunStatus; statusReason: string | null;
  attempt: number; checkpointStep: number; stepsUsed: number;
  budget: { maxSteps: number; maxDurationMs: number; activeMs: number; maxCostCents: number | null; costCents: number };
  /** R1: separate from the execution status. null = the run has no contract (unverified). */
  verification: {
    status: VerificationStatus | null; reasons: string[]; round: number; maxRetries: number;
    reviewMode: string | null;
    review: { decision: 'accepted' | 'rejected'; by: string | null; reviewer: string | null; note: string | null; at: string | null } | null;
  };
  hasContract: boolean;
  leaseActive: boolean; cancelRequested: boolean;
  outputPreview: string | null;
  createdAt: string; startedAt: string | null; updatedAt: string; finishedAt: string | null;
}

export interface TaskRunStepView {
  index: number; kind: 'model' | 'tool'; tool: string | null; status: StepStatus;
  idempotent: boolean; attempt: number; idempotencyKey: string;
  approvalId: string | null; error: string | null; resolvedBy: string | null;
  startedAt: string; completedAt: string | null;
  /** R2: model steps only (null for tool steps and replayed-free steps). */
  usage: { provider: string | null; model: string | null; inputTokens: number | null; outputTokens: number | null; costCents: number | null; source: string | null } | null;
}

export function runView(row: TaskRunRow, now = Date.now()): TaskRunView {
  return {
    id: row.id, taskId: row.task_id, agentId: row.agent_id, userId: row.user_id,
    status: row.status, statusReason: row.status_reason,
    attempt: row.attempt, checkpointStep: row.checkpoint_step, stepsUsed: row.steps_used,
    budget: { maxSteps: row.max_steps, maxDurationMs: row.max_duration_ms, activeMs: elapsedMs(row, now), maxCostCents: row.max_cost_cents ?? null, costCents: roundCents(row.cost_cents ?? 0) },
    verification: {
      status: row.verification_status ?? null,
      reasons: parseReasons(row.verification_reasons),
      round: row.verification_round ?? 0,
      maxRetries: row.max_verification_retries ?? 0,
      reviewMode: row.review_mode ?? null,
      review: row.review_decision
        ? { decision: row.review_decision, by: row.reviewed_by, reviewer: row.reviewer_kind, note: row.review_note, at: isoUtc(row.reviewed_at) }
        : null,
    },
    hasContract: !!row.contract_encrypted,
    leaseActive: row.status === 'running' && !!row.lease_owner && (row.lease_expires_at ?? 0) >= now,
    cancelRequested: row.cancel_requested === 1,
    outputPreview: row.output_preview,
    // BE-UI-01: ISO-8601 UTC with Z at the API layer (DB keeps SQLite format).
    createdAt: isoUtc(row.created_at) as string, startedAt: isoUtc(row.started_at), updatedAt: isoUtc(row.updated_at) as string, finishedAt: isoUtc(row.finished_at),
  };
}

export function stepView(row: TaskRunStepRow): TaskRunStepView {
  return {
    index: row.step_index, kind: row.kind, tool: row.tool_name, status: row.status,
    idempotent: row.idempotent === 1, attempt: row.attempt, idempotencyKey: row.idempotency_key,
    approvalId: row.approval_id, error: row.error, resolvedBy: row.resolved_by,
    startedAt: isoUtc(row.started_at) as string, completedAt: isoUtc(row.completed_at),
    usage: row.kind === 'model' && (row.provider || row.cost_cents !== null)
      ? { provider: row.provider, model: row.model, inputTokens: row.input_tokens, outputTokens: row.output_tokens, costCents: row.cost_cents, source: row.usage_source }
      : null,
  };
}

/** Newest first; ties on created_at (second precision) by id (B2.2b-3: no rowid). */
export function listRuns(filter: { userId?: string | null; status?: string; taskId?: string; limit?: number }): Promise<TaskRunRow[]> {
  return sql().read((function* () {
    const d = yield* dialect();
    const where: string[] = [];
    const args: Array<string | number | null> = [];
    if (filter.userId !== undefined) { where.push(`user_id ${isParam(d)}`); args.push(filter.userId); }
    if (filter.status) { where.push('status = ?'); args.push(filter.status); }
    if (filter.taskId) { where.push('task_id = ?'); args.push(filter.taskId); }
    const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 200);
    return yield* all<TaskRunRow>(
      `SELECT * FROM task_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ...args, limit);
  })());
}

function roundCents(n: number): number { return Math.round((Number(n) || 0) * 10_000) / 10_000; }

function parseReasons(raw: string | null): string[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

// ---------------------------------------------------------------------------
// R2: cost usage per step
// ---------------------------------------------------------------------------

/** Record a model step's usage (provider, model, tokens, cost) and add it to the run total. */
export function recordStepUsage(runId: string, stepIndex: number, u: { provider: string; model: string | null; inputTokens: number; outputTokens: number; costCents: number; source: string }): Promise<void> {
  return sql().tx(function* () {
    const d = yield* dialect();
    yield* run(`
      UPDATE task_run_steps SET provider = ?, model = ?, input_tokens = ?, output_tokens = ?, cost_cents = COALESCE(cost_cents, 0) + ?, usage_source = ?
      WHERE run_id = ? AND step_index = ?
    `, u.provider, u.model, u.inputTokens, u.outputTokens, u.costCents, u.source, runId, stepIndex);
    yield* run(`UPDATE task_runs SET cost_cents = cost_cents + ?, updated_at = ${nowText(d)} WHERE id = ?`, u.costCents, runId);
  });
}

// ---------------------------------------------------------------------------
// R1: verification rounds + review
// ---------------------------------------------------------------------------

export interface StoredVerdict extends Verdict { round: number; verifier: string; createdAt: string }

function* verificationStep(runId: string, round: number): Step<StoredVerdict | null> {
  const row = yield* one<{ round: number; status: VerificationStatus; reasons: string; checks: string; verifier: string; created_at: string }>(
    'SELECT * FROM task_run_verifications WHERE run_id = ? AND round = ?', runId, round);
  if (!row) return null;
  return { round: row.round, status: row.status, reasons: parseReasons(row.reasons), checks: JSON.parse(row.checks), verifier: row.verifier, createdAt: isoUtc(row.created_at) as string };
}

export function getVerification(runId: string, round: number): Promise<StoredVerdict | null> {
  return sql().read(verificationStep(runId, round));
}

export function listVerifications(runId: string): Promise<StoredVerdict[]> {
  return sql().read((function* () {
    const rows = yield* all<{ round: number }>('SELECT round FROM task_run_verifications WHERE run_id = ? ORDER BY round', runId);
    const out: StoredVerdict[] = [];
    for (const r of rows) {
      const v = yield* verificationStep(runId, r.round);
      if (v) out.push(v);
    }
    return out;
  })());
}

/**
 * Store a round's verdict (fenced). A verdict already stored for the round
 * wins: a resumed run replays the same decision instead of judging again.
 */
export function storeVerification(lease: Lease, round: number, verdict: Verdict, verifier: string): Promise<StoredVerdict> {
  return sql().tx(function* () {
    const d = yield* dialect();
    if (!(yield* holdsLeaseStep(lease, true))) throw new LeaseLostError();
    yield* run(insertOrIgnore(d, `
      INSERT INTO task_run_verifications (run_id, round, status, reasons, checks, verifier) VALUES (?, ?, ?, ?, ?, ?)
    `), lease.runId, round, verdict.status, JSON.stringify(verdict.reasons), JSON.stringify(verdict.checks), verifier);
    yield* run(`UPDATE task_runs SET verification_round = ${greatest(d)}(verification_round, ?), updated_at = ${nowText(d)} WHERE id = ?`, round, lease.runId);
    return (yield* verificationStep(lease.runId, round))!;
  });
}

/** Set the run's verification status (fenced while the run is running). */
export async function setRunVerification(lease: Lease, status: VerificationStatus, reasons: string[]): Promise<void> {
  const res = await sql().read((function* () {
    const d = yield* dialect();
    return yield* run(`UPDATE task_runs SET verification_status = ?, verification_reasons = ?, updated_at = ${nowText(d)} WHERE ${FENCE}`,
      status, JSON.stringify(reasons), lease.runId, lease.owner, lease.generation);
  })());
  if (res.changes !== 1) throw new LeaseLostError();
}

/** After the run finished (unfenced): mark it needs_review (e.g. the small-agent card asks for it). */
export async function markRunNeedsReview(runId: string, reason: string): Promise<void> {
  await sql().read((function* () {
    const d = yield* dialect();
    yield* run(`
      UPDATE task_runs SET verification_status = 'needs_review', verification_reasons = ?, updated_at = ${nowText(d)}
      WHERE id = ? AND status = 'completed' AND (verification_status IS NULL OR verification_status = 'verified') AND review_decision IS NULL
    `, JSON.stringify([reason]), runId);
  })());
}

/** Successful tool calls of a run (completed tool steps whose result has no error). */
export async function successfulToolCalls(runId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const s of await getSteps(runId)) {
    if (s.kind !== 'tool' || s.status !== 'completed' || !s.tool_name) continue;
    let ok = false;
    try { const r = await stepResult<any>(s); ok = !!r && !r.error; } catch { ok = false; }
    if (ok) out.set(s.tool_name, (out.get(s.tool_name) ?? 0) + 1);
  }
  return out;
}

export type ReviewDecision = 'accept' | 'reject';

/**
 * Owner decision for a run whose result needs review. Only once; only for
 * a completed run in needs_review.
 */
export function reviewRun(runId: string, decision: ReviewDecision, by: string, reviewer: 'owner' | 'large_agent', note: string | null): Promise<TaskRunRow> {
  return sql().tx(function* () {
    const d = yield* dialect();
    // Locked (PostgreSQL): a second concurrent review waits, then sees review_decision set.
    const r = yield* runRow(runId, true);
    if (!r) throw new RunStateError('Run not found', 404);
    if (r.status !== 'completed' || r.verification_status !== 'needs_review') throw new RunStateError('This run is not waiting for a review', 409);
    if (r.review_decision) throw new RunStateError('This run was already reviewed', 409);
    yield* run(`
      UPDATE task_runs SET review_decision = ?, reviewed_by = ?, reviewer_kind = ?, review_note = ?, reviewed_at = ${nowText(d)}, updated_at = ${nowText(d)}
      WHERE id = ?
    `, decision === 'accept' ? 'accepted' : 'rejected', by, reviewer, note, runId);
    return (yield* runRow(runId))!;
  });
}

export interface TaskRunDetailView extends TaskRunView {
  contract: ContractView | null;
  verificationRounds: StoredVerdict[];
}

/** Run detail for the API: contract without input values or secrets, verification rounds, cost. */
export async function runDetailView(row: TaskRunRow): Promise<TaskRunDetailView> {
  let contract: ContractView | null = null;
  try {
    const c = await runContract(row);
    contract = c ? contractView(c) : null;
  } catch { contract = null; }
  return { ...runView(row), contract, verificationRounds: await listVerifications(row.id) };
}
