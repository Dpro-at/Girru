/**
 * PROJECT-SYNC-01: one call that brings a project's shared state up to date.
 *
 * "We finished the feature — update the handoff and the memory" used to be three calls in Girru's
 * chat: preview the managed files, apply them after the owner's approval, then save the handoff. Each
 * one could be the last one made, which is how the files and the handoff drift apart. This plans all
 * of it, shows ONE preview with ONE hash, and writes it after the owner approves that hash.
 *
 * It adds no permission. The files are still written only between Girru's markers, by the same
 * `previewFiles` / `applyFiles` the owner's own path uses; a lasting fact is still only a proposal the
 * owner reviews; and the apply tool is in the owner-approval list, so nothing here runs unasked.
 *
 * Order of writing: the handoff and the proposals first, the files last. The files are *derived* from
 * memory, so if the filesystem fails the next sync writes them from what is now stored; nothing is
 * lost and nothing is written twice. The other order could leave files describing a handoff that was
 * never saved. What was done and what was not is always reported.
 */
import { createHash } from 'node:crypto';
import { assertNoDefaultMemoryAccess } from '../encryption/execution-context.js';
import { cleanHandoff, HandoffInputError, type HandoffBody } from '../handoff/store.js';
import { learn } from '../learning.js';
import { storeP8Enabled } from '../../services/store-p8.js';
import { folderSettings, latestBridgeHandoff, saveBridgeHandoff } from './store.js';
import { isOutsideProject } from '../project-trust.js';
import { BridgeError, filesApply, filesPreview, ownProject } from './service.js';
import { projectDrawer } from './brief.js';
import type { FilePlan } from './managed-files.js';

/** What one sync would change, and the hash the owner approves. */
export interface SyncPlan {
  projectId: string;
  folder: string;
  /** The managed section of AGENTS.md / CLAUDE.md / GEMINI.md, as `memory_bridge` previews it. */
  files: FilePlan[];
  fileChanges: number;
  conflicts: number;
  /** Why the files are left alone: the owner's switch is off, or this is someone else's repository. */
  filesSkipped: string | null;
  /** The handoff this sync would save, or why it would not. */
  handoff: HandoffBody | null;
  handoffSkipped: string | null;
  /** Lasting facts that would become proposals for the owner to review (never saved directly). */
  memory: string[];
  previewHash: string;
}

export interface SyncInput {
  handoff?: unknown;
  /** One lasting fact per entry; each becomes a review proposal. */
  memory?: unknown;
}

const MAX_FACTS = 10;
const MAX_FACT_CHARS = 4000;

/** The facts of the input, checked; the same text twice counts once. */
function facts(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BridgeError('memory must be a list of short facts');
  const out: string[] = [];
  for (const x of raw) {
    const t = typeof x === 'string' ? x.trim() : '';
    if (!t) continue;
    if (t.length > MAX_FACT_CHARS) throw new BridgeError(`a fact is longer than ${MAX_FACT_CHARS} characters`);
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > MAX_FACTS) throw new BridgeError(`at most ${MAX_FACTS} facts in one sync`);
  return out;
}

const sameHandoff = (a: HandoffBody, b: HandoffBody): boolean =>
  (['done', 'left', 'next', 'questions', 'blockers', 'files'] as const)
    .every((k) => JSON.stringify(a[k] ?? []) === JSON.stringify(b[k] ?? []));

/** The hash covers everything the owner sees, so an approval cannot apply to a different plan. */
const planHash = (filesHash: string, handoff: HandoffBody | null, memory: string[]): string =>
  createHash('sha256').update(JSON.stringify({ filesHash, handoff, memory })).digest('hex');

/**
 * Plan a sync: the files as they would be written, the handoff as it would be saved, the facts as they
 * would be proposed. Writes nothing.
 */
export async function syncPreview(ownerId: string, projectId: unknown, input: SyncInput = {}): Promise<SyncPlan> {
  assertNoDefaultMemoryAccess();
  const p = await ownProject(ownerId, projectId);
  // A sync keeps the managed files up to date; it never turns them on. `filesApply` sets
  // filesEnabled, so without this check a sync would undo the owner's "stop updating this folder"
  // and write into a repository on the Outside projects list. Only the owner's own approval of
  // `memory_bridge` apply_files starts writing a folder.
  const settings = await folderSettings(ownerId, p.id);
  const filesSkipped = !settings.filesEnabled
    ? 'the owner has not turned project files on for this folder (memory_bridge apply_files does that)'
    : (await isOutsideProject(ownerId, p.id))
      ? 'this project is on the Outside projects list; trust it first'
      : null;
  const files = filesSkipped ? null : await filesPreview(ownerId, p.id);
  const memory = facts(input.memory);

  let handoff: HandoffBody | null = null;
  let handoffSkipped: string | null = null;
  if (input.handoff !== undefined && input.handoff !== null) {
    try {
      handoff = cleanHandoff(input.handoff, storeP8Enabled());
    } catch (err) {
      if (!(err instanceof HandoffInputError)) throw err;
      throw new BridgeError(err.message);
    }
    // No duplicate: the same note as the newest one adds nothing but a version.
    const latest = await latestBridgeHandoff(ownerId, p.id);
    if (latest && sameHandoff(handoff, latest as unknown as HandoffBody)) {
      handoffSkipped = 'the newest handoff in this project already says exactly this';
      handoff = null;
    }
  }

  return {
    // ownProject refuses a project without a folder, so this is set.
    projectId: p.id, folder: p.folder as string,
    files: files?.files ?? [], fileChanges: files?.changes ?? 0, conflicts: files?.conflicts ?? 0, filesSkipped,
    handoff, handoffSkipped, memory,
    previewHash: planHash(files?.previewHash ?? `skipped:${filesSkipped}`, handoff, memory),
  };
}

export interface SyncResult {
  projectId: string;
  handoffId: string | null;
  proposals: string[];
  /** Facts that were not proposed, with the reason (a near-duplicate of memory already stored). */
  notProposed: Array<{ content: string; reason: string }>;
  fileChanges: number;
  /** Set when the database part succeeded and the files did not: the next sync writes them. */
  filesError: string | null;
  /** Set when the files were left alone on purpose (the owner's switch, or an outside project). */
  filesSkipped: string | null;
}

/**
 * Apply the plan the owner approved. The hash is recomputed from the same input; anything changed in
 * between (another agent's memory, the folder's files) makes the hash differ and the call is refused.
 */
export async function syncApply(ownerId: string, projectId: unknown, input: SyncInput & { previewHash?: unknown; confirm?: unknown }): Promise<SyncResult> {
  assertNoDefaultMemoryAccess();
  if (input?.confirm !== true) throw new BridgeError('Send confirm: true after reviewing the preview', 400, 'confirm_required');
  if (typeof input.previewHash !== 'string') throw new BridgeError('previewHash is required');
  const project = await ownProject(ownerId, projectId);
  const plan = await syncPreview(ownerId, projectId, input);
  if (plan.previewHash !== input.previewHash) {
    throw new BridgeError('The project changed since that preview. Preview the sync again and approve the new one.', 409, 'preview_stale');
  }

  // 1. The handoff and the facts: what the files are made from.
  let handoffId: string | null = null;
  if (plan.handoff) {
    const h = await saveBridgeHandoff(ownerId, plan.projectId, 'claude-code', plan.handoff, null);
    handoffId = h.id;
  }
  const proposals: string[] = [];
  const notProposed: Array<{ content: string; reason: string }> = [];
  for (const content of plan.memory) {
    const r = await learn({
      userId: ownerId, actor: 'project_sync', review: true,
      candidates: [{ content, type: 'fact', importance: 5, drawer: projectDrawer(project), origin: 'agent' }],
    });
    const proposal = r.proposed[0];
    if (proposal) proposals.push(proposal.id);
    else notProposed.push({ content, reason: r.skipped[0]?.reason ?? 'nothing to add' });
  }

  // 2. The files last: they are derived, so a failure here is fixed by the next sync, never a loss.
  // Left alone entirely when the plan said so (the owner's switch, or someone else's repository).
  let fileChanges = 0;
  let filesError: string | null = null;
  if (!plan.filesSkipped) {
    try {
      const files = await filesPreview(ownerId, plan.projectId);
      const written = await filesApply(ownerId, plan.projectId, { previewHash: files.previewHash, confirm: true }, 'project_sync');
      fileChanges = written.changes;
    } catch (err) {
      filesError = String((err as Error)?.message ?? err).slice(0, 300);
    }
  }

  return { projectId: plan.projectId, handoffId, proposals, notProposed, fileChanges, filesError, filesSkipped: plan.filesSkipped };
}
