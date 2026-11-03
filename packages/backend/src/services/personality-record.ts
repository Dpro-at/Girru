/**
 * STORE-MAP-01 P4 (T7, D13–D15): one personality record per agent.
 *
 * The record is the agent's personality versions (agent_personality_versions)
 * plus the text each version points at (personality_texts, by sha256). While
 * GIRRU_STORE_P4 is on:
 *  - every reader takes the text from the record (personalityTextFor);
 *  - an edit in Girru saves at once as a new version (savePersonalityText),
 *    and Undo is a rollback to the version before (a new version again);
 *  - PERSONALITY.md is a view written from the record (writePersonalityView).
 *    personality_file_state keeps the hash of what Girru wrote, so a change
 *    made to the file outside Girru (a coding app, a text editor) becomes a
 *    proposal in Personality review (captureOutsideEdit) and is never used
 *    silently. "No" writes the record back into the file;
 *  - start-up imports each agent's current file text once
 *    (backfillPersonalityRecords), keeping the old file as version history.
 * Off (the default): readers keep reading the file, as before.
 *
 * A personality changes how an agent talks, never its job, skills or
 * permissions: the job comes from its specialty links, and agents_config.
 * system_prompt keeps only the owner's extra instructions (D14).
 */

import { createHash } from 'node:crypto';
import { all, one, run, sql, type Step } from '../repositories/sql-steps.js';
import { getDefaultPersonality, readPersonality, writePersonality } from './agent-files.js';
import { renderPersonalityExport, stripPersonalityExport, upsertPersonalityExport, PersonalityInputError } from './personality.js';
import {
  MAX_PERSONALITY_TEXT_BYTES, PersonalityNotFoundError, appendVersion, createPersonalityTextProposal,
  currentPersonalityStep, personalityTextStep, putPersonalityTextStep,
  type PersonalityProposal, type PersonalityVersion,
} from './personality-store.js';
import { storeP4Enabled } from './store-p4.js';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The personality text of a PERSONALITY.md body: the generated block is dropped, the untouched template is no text. */
export function textOfFile(raw: string): string {
  const clean = stripPersonalityExport(raw).trim();
  return clean === getDefaultPersonality().trim() ? '' : clean;
}

/** Thrown when the version the editor read is no longer the current one (409). */
export class PersonalityVersionConflict extends Error {}

/** The current text in the record ('' for none) and its version; null when the agent does not exist. */
export async function recordText(agentId: string): Promise<{ text: string; version: number; textHash: string | null } | null> {
  return sql().read((function* () {
    const current = yield* currentPersonalityStep(agentId);
    if (!current) return null;
    return { text: yield* personalityTextStep(current.textHash), version: current.version, textHash: current.textHash ?? null };
  })());
}

/**
 * The personality text an agent's prompt uses. P4 on: the record's text
 * (falls back to the file only until the agent has been imported). Off: the
 * file as before, without its generated block and without the template.
 */
export async function personalityTextFor(agentId: string): Promise<string> {
  if (storeP4Enabled()) {
    const r = await recordText(agentId).catch(() => null);
    if (r?.textHash) return r.text;
  }
  // Off: exactly the earlier reading (the whole file compared with the template).
  const file = await readPersonality(agentId).catch(() => '');
  return file && file.trim() !== getDefaultPersonality().trim() ? stripPersonalityExport(file).trim() : '';
}

/**
 * The owner edits the text inside Girru: saved at once as a new version
 * (D15). `expectedVersion` is the version the editor showed (409 when it
 * moved on). The same text answers with the current version unchanged.
 * A lock stops suggestions, not the owner's own edits.
 */
export async function savePersonalityText(agentId: string, rawText: unknown, expectedVersion: unknown, createdBy: string): Promise<PersonalityVersion> {
  if (typeof rawText !== 'string') throw new PersonalityInputError('text is required');
  if (!(expectedVersion === null || (typeof expectedVersion === 'number' && Number.isSafeInteger(expectedVersion) && expectedVersion >= 0))) {
    throw new PersonalityInputError('expectedVersion must be the version you read');
  }
  // The generated settings part is never taken from what was typed.
  const text = textOfFile(rawText);
  if (Buffer.byteLength(text, 'utf8') > MAX_PERSONALITY_TEXT_BYTES) throw new PersonalityInputError('text must be at most 1 MB');
  const saved = await sql().tx(function* () {
    const current = yield* currentPersonalityStep(agentId, { lock: true });
    if (!current) throw new PersonalityNotFoundError('Agent not found');
    if (expectedVersion !== null && current.version !== expectedVersion) throw new PersonalityVersionConflict('changed');
    const textHash = yield* putPersonalityTextStep(text);
    if (textHash === current.textHash && current.version > 0) return current;
    return yield* appendVersion(agentId, createdBy, {
      traits: current.traits, preset: current.preset, dialect: current.dialect, locked: current.locked,
      lockedTraits: current.lockedTraits, source: 'owner', basedOnVersion: current.version || null,
      note: 'text changed', textHash,
    });
  }, { immediate: true });
  await writePersonalityView(agentId).catch(() => {});
  return saved;
}

/**
 * A change made to PERSONALITY.md outside Girru becomes a proposal (T7b).
 * Returns the proposal, or null when the file is what Girru wrote, only its
 * generated part changed, or the agent was never imported.
 */
export async function captureOutsideEdit(agentId: string): Promise<PersonalityProposal | null> {
  if (!storeP4Enabled()) return null;
  const state = await sql().read(one<{ written_hash: string }>('SELECT written_hash FROM personality_file_state WHERE agent_id = ?', agentId));
  if (!state) return null;
  const raw = await readPersonality(agentId);
  if (sha(raw) === state.written_hash) return null;
  const record = await recordText(agentId);
  const markSeen = () => sql().read(run('UPDATE personality_file_state SET written_hash = ? WHERE agent_id = ?', sha(raw), agentId));
  const text = textOfFile(raw);
  if (!record || text === record.text) { await markSeen(); return null; }
  try {
    const proposal = await createPersonalityTextProposal(agentId, { text, reason: 'PERSONALITY.md was changed outside Girru.' }, 'owner', 'file:PERSONALITY.md', 'file');
    await markSeen();
    return proposal;
  } catch {
    // Locked or too many pending: the file is written back from the record at the next save; nothing is used silently.
    return null;
  }
}

/**
 * Write PERSONALITY.md from the record: the text, then the generated
 * settings part. A change made outside Girru is captured first, so writing
 * the view never loses it. No-op while the switch is off.
 */
export async function writePersonalityView(agentId: string): Promise<void> {
  if (!storeP4Enabled()) return;
  // An agent met before its import (created after start-up): import first, which writes the view.
  if (await ensurePersonalityRecord(agentId)) return;
  await captureOutsideEdit(agentId);
  const view = await sql().read((function* () {
    const current = yield* currentPersonalityStep(agentId);
    if (!current || !current.textHash) return null;
    return { current, text: yield* personalityTextStep(current.textHash) };
  })());
  if (!view) return;
  const body = upsertPersonalityExport(view.text, renderPersonalityExport(view.current));
  await writePersonality(agentId, body);
  await sql().read(run(`
    INSERT INTO personality_file_state (agent_id, written_hash, written_version) VALUES (?, ?, ?)
    ON CONFLICT (agent_id) DO UPDATE SET written_hash = excluded.written_hash, written_version = excluded.written_version
  `, agentId, sha(body), view.current.version));
}

/**
 * One-time import (expand → backfill): each agent whose current version has
 * no text gets one version holding its PERSONALITY.md text (source 'import';
 * the untouched template is no text). Idempotent: an agent that already has
 * a text is skipped. Returns how many agents were imported.
 */
export async function backfillPersonalityRecords(): Promise<number> {
  const agents = await sql().read(all<{ id: string }>('SELECT id FROM agents_config ORDER BY id'));
  let imported = 0;
  for (const { id } of agents) if (await ensurePersonalityRecord(id)) imported++;
  return imported;
}

/**
 * Import one agent's PERSONALITY.md text into its record when its current
 * version has none yet (also used the first time Files or a save meets an
 * agent created after start-up). True when a version was added.
 */
export async function ensurePersonalityRecord(id: string): Promise<boolean> {
    if (!storeP4Enabled()) return false;
    const done = await sql().read(one<{ text_hash: string | null }>('SELECT text_hash FROM agent_personality_versions WHERE agent_id = ? ORDER BY version DESC LIMIT 1', id));
    if (done?.text_hash) return false;
    let text = '';
    try { text = textOfFile(await readPersonality(id)); } catch { return false; } // an unsafe file is left alone and retried next start
    if (Buffer.byteLength(text, 'utf8') > MAX_PERSONALITY_TEXT_BYTES) return false;
    const changed = await sql().tx(function* () {
      const current = yield* currentPersonalityStep(id, { lock: true });
      if (!current || current.textHash) return false;
      const textHash = yield* putPersonalityTextStep(text);
      yield* appendVersion(id, 'system', {
        traits: current.traits, preset: current.preset, dialect: current.dialect, locked: current.locked,
        lockedTraits: current.lockedTraits, source: 'import', basedOnVersion: current.version || null,
        note: 'text imported from PERSONALITY.md', textHash,
      });
      return true;
    }, { immediate: true });
    if (changed) await writePersonalityView(id).catch(() => {});
    return changed;
}

/** Verify step: agents whose current version still has no text (0 after a full backfill). */
export async function agentsWithoutRecordText(): Promise<number> {
  return sql().read((function* () {
    const rows = yield* all<{ id: string }>('SELECT id FROM agents_config');
    let missing = 0;
    for (const r of rows) {
      const v = yield* one<{ text_hash: string | null }>('SELECT text_hash FROM agent_personality_versions WHERE agent_id = ? ORDER BY version DESC LIMIT 1', r.id);
      if (!v?.text_hash) missing++;
    }
    return missing;
  })());
}

/**
 * Duplicate / sub-agent copy (G3): the new agent's version 1 is a copy of
 * the source's current record (text and adjustments). A step, run in the
 * creating transaction; no-op while the switch is off or the source has none.
 */
export function* copyPersonalityStep(fromAgentId: string, toAgentId: string, createdBy: string): Step<void> {
  if (!storeP4Enabled()) return;
  const source = yield* currentPersonalityStep(fromAgentId);
  if (!source || source.version === 0) return;
  const target = yield* currentPersonalityStep(toAgentId, { lock: true });
  if (!target) return;
  if (target.version !== 0) {
    // Already seeded (a sub-agent copy takes its adjustments at creation): add the text as the next version.
    if (source.textHash && source.textHash !== target.textHash) {
      yield* appendVersion(toAgentId, createdBy, {
        traits: target.traits, preset: target.preset, dialect: target.dialect, locked: target.locked, lockedTraits: target.lockedTraits,
        source: 'seed', basedOnVersion: target.version, note: `text copied from ${fromAgentId} version ${source.version}`, textHash: source.textHash,
      });
    }
    return;
  }
  yield* appendVersion(toAgentId, createdBy, {
    traits: source.traits, preset: source.preset, dialect: source.dialect, locked: false,
    lockedTraits: source.lockedTraits, source: 'seed', basedOnVersion: null,
    note: `copy of ${fromAgentId} version ${source.version}`, textHash: source.textHash,
  });
}
