import {selectedMemoryExecution,assertNoDefaultMemoryAccess} from './encryption/execution-context.js';
import {consumeCurrentEncryptedMemoryScope,assertNoLegacyMemoryFileAccess} from './encryption/consumer-host.js';
/**
 * STORE-MAP-01 P5 (T4, CX1): an agent's own notes live in its own drawer.
 *
 * MEMORY.md used to be a file only (with compare-and-set and history in
 * .memory-versions, agent-files.ts). While GIRRU_STORE_P5 is on:
 *  - start-up imports each agent's MEMORY.md once into one memory of the
 *    drawer `agent:<agent id>` (drawer_kind 'agent'); the file's earlier
 *    versions become that memory's history (memory_versions), oldest first,
 *    so the old compare-and-set history is kept and never imported twice
 *    (agent_memory_imports);
 *  - prompts read the notes from the drawer, framed as untrusted data as
 *    before (agentMemoryForPrompt);
 *  - the owner saves with the hash of the text read (409 when it moved on),
 *    and MEMORY.md is written from the drawer as a view. A file changed
 *    outside Girru is never overwritten: it is kept, and the change waits
 *    for the owner (agentMemoryStatus.outsideChange).
 * The agent drawer is not one of the shared drawer kinds: no access rule,
 * permission or other agent's recall can open it. Only this agent's own
 * prompt and the owner read it.
 */

import { randomUUID } from 'node:crypto';
import { contentSha256 } from '../services/content-hash.js';
import { all, one, run, sql, type Step } from '../repositories/sql-steps.js';
import { readMemory, readMemoryHistory, readMemorySnapshot, writeMemoryCAS } from '../services/agent-files.js';
import { companyOwnerStep } from '../services/departments.js';
import { storeP5Enabled } from '../services/store-p5.js';
import { recordVersionStep } from './versions.js';
import { redactImportText } from './import/redact.js';
import type { DrawerRef } from './drawers.js';

export const AGENT_DRAWER_KIND = 'agent';
/** The longest notes kept (the MEMORY.md limit). */
export const MAX_AGENT_NOTES = 32_768;

const sha = contentSha256;
/** The drawer of one agent's own notes (outside the shared drawer kinds; cast only for the history rows). */
const drawerOf = (agentId: string) => ({ kind: AGENT_DRAWER_KIND, key: agentId }) as unknown as DrawerRef;

export class AgentMemoryConflict extends Error {}
export class AgentMemoryInputError extends Error {}

interface Ledger { agent_id: string; memory_id: string; file_hash: string | null; versions: number; written_hash: string | null }

function* ledgerStep(agentId: string): Step<Ledger | undefined> {
  return yield* one<Ledger>('SELECT * FROM agent_memory_imports WHERE agent_id = ?', agentId);
}

function* notesStep(agentId: string): Step<{ id: string; content: string; user_id: string } | undefined> {
  return yield* one<{ id: string; content: string; user_id: string }>(
    "SELECT id, content, user_id FROM memories WHERE drawer_kind = 'agent' AND drawer_key = ? AND status = 'active' ORDER BY created_at LIMIT 1", agentId);
}

/**
 * Import one agent's MEMORY.md (and its .memory-versions history) into its
 * drawer, once. True when it was imported now; false when it already was,
 * the switch is off, there is no owner yet, or the file could not be read
 * safely (tried again at the next start).
 */
export async function importAgentMemory(agentId: string): Promise<boolean> {
  assertNoLegacyMemoryFileAccess();
  if (!storeP5Enabled()) return false;
  if (await sql().read(ledgerStep(agentId))) return false;
  let current: Awaited<ReturnType<typeof readMemorySnapshot>>;
  try { current = await readMemorySnapshot(agentId); } catch { return false; }
  if (current.truncated) return false; // an oversized file is never cut silently
  const history = await readMemoryHistory(agentId).catch(() => []);
  const memoryId = randomUUID();
  const createdAt = new Date().toISOString();
  return sql().tx(function* () {
    if (yield* ledgerStep(agentId)) return false;
    if (!(yield* one('SELECT id FROM agents_config WHERE id = ?', agentId))) return false;
    const owner = yield* companyOwnerStep();
    if (!owner) return false;
    yield* run(`
      INSERT INTO memories (id, user_id, type, content, embedding, memory_layer, status, metadata, importance_score, created_at, drawer_kind, drawer_key, source_agent_id, source, trust)
      VALUES (?, ?, 'context', ?, '[]', 'factual', 'active', ?, 0.5, ?, 'agent', ?, ?, 'agent', 'imported')
    `, memoryId, owner, current.content, JSON.stringify({ agentNotes: true, agentId }), createdAt, agentId, agentId);
    const drawer = drawerOf(agentId);
    // The file's history first (oldest first), then the text as it is now.
    const steps = history.map((h) => h.content);
    if (steps[steps.length - 1] !== current.content) steps.push(current.content);
    for (let i = 0; i < steps.length; i++) {
      yield* recordVersionStep({
        memoryId, userId: owner, drawer, change: i === 0 ? 'baseline' : 'update',
        entry: { type: 'context', importance: 5, content: steps[i] }, actor: 'system',
        reason: i < history.length ? 'MEMORY.md history' : 'MEMORY.md imported',
      });
    }
    yield* run('INSERT INTO agent_memory_imports (agent_id, memory_id, file_hash, versions, written_hash) VALUES (?, ?, ?, ?, ?)',
      agentId, memoryId, current.hash, history.length, current.hash);
    return true;
  }, { immediate: true });
}

/** Start-up (expand → backfill): import every agent's notes once. Returns how many were imported now. */
export async function importAllAgentMemory(): Promise<number> {
  assertNoLegacyMemoryFileAccess();
  if (!storeP5Enabled()) return 0;
  let n = 0;
  for (const { id } of await sql().read(all<{ id: string }>('SELECT id FROM agents_config ORDER BY id'))) {
    if (await importAgentMemory(id).catch(() => false)) n++;
  }
  return n;
}

/** Verify step: agents without imported notes (0 after a full import). */
export async function agentsWithoutImportedMemory(): Promise<number> {
  assertNoLegacyMemoryFileAccess();
  return sql().read((function* () {
    const row = yield* one<{ n: number }>('SELECT COUNT(*) AS n FROM agents_config a WHERE NOT EXISTS (SELECT 1 FROM agent_memory_imports i WHERE i.agent_id = a.id)');
    return Number(row?.n ?? 0);
  })());
}

/** The notes and their version tag (sha256 of the text), or null before the import / with the switch off. */
async function agentNotesCurrent(agentId: string): Promise<{ content: string; hash: string; memoryId: string } | null> {
 const selected=selectedMemoryExecution();if(selected)return selected.agentNotes(agentId);
  if (!storeP5Enabled()) return null;
  return sql().read((function* () {
    if (!(yield* ledgerStep(agentId))) return null;
    const m = yield* notesStep(agentId);
    return m ? { content: m.content, hash: sha(m.content), memoryId: m.id } : null;
  })());
}

/** What a prompt reads as the agent's own notes: the drawer with the switch on (after the import), else the file. */
async function agentMemoryForPromptCurrent(agentId: string): Promise<string> {
 const selected=selectedMemoryExecution();if(selected)return(await selected.agentNotes(agentId))?.content??'';
  const notes = await agentNotes(agentId).catch(() => null);
  return notes ? notes.content : readMemory(agentId);
}

/**
 * The owner saves the notes over the version read (`expectedHash`, the hash
 * agentNotes gave). Values that look like secrets are hidden first. One
 * history row per change; then the file view is written.
 */
export async function saveAgentNotes(agentId: string, content: unknown, expectedHash: unknown, actor: string): Promise<{ content: string; hash: string; redacted: boolean }> {
  assertNoLegacyMemoryFileAccess();
  if (typeof content !== 'string' || typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new AgentMemoryInputError('invalid');
  const clean = redactImportText(content).text;
  if (Buffer.byteLength(clean, 'utf8') > MAX_AGENT_NOTES) throw new AgentMemoryInputError('too_large');
  await sql().tx(function* () {
    const ledger = yield* ledgerStep(agentId);
    const m = yield* notesStep(agentId);
    if (!ledger || !m) throw new AgentMemoryConflict('not_imported');
    if (sha(m.content) !== expectedHash) throw new AgentMemoryConflict('changed');
    if (m.content === clean) return;
    yield* run('UPDATE memories SET content = ? WHERE id = ?', clean, m.id);
    yield* recordVersionStep({ memoryId: m.id, userId: m.user_id, drawer: drawerOf(agentId), change: 'update', entry: { type: 'context', importance: 5, content: clean }, actor, reason: 'notes edited' });
  }, { immediate: true });
  await writeAgentNotesView(agentId).catch(() => {});
  return { content: clean, hash: sha(clean), redacted: clean !== content };
}

/**
 * Write MEMORY.md from the drawer. A file changed outside Girru since Girru
 * last wrote it is never overwritten (agentMemoryStatus says so).
 */
export async function writeAgentNotesView(agentId: string): Promise<'written' | 'unchanged' | 'outside_change' | 'off'> {
  assertNoLegacyMemoryFileAccess();
  if (!storeP5Enabled()) return 'off';
  const state = await sql().read((function* () { return { ledger: yield* ledgerStep(agentId), notes: yield* notesStep(agentId) }; })());
  if (!state.ledger || !state.notes) return 'off';
  const file = await readMemorySnapshot(agentId);
  if (file.hash !== state.ledger.written_hash) return 'outside_change';
  if (file.content === state.notes.content) return 'unchanged';
  const written = await writeMemoryCAS(agentId, state.notes.content, file.hash);
  await sql().read(run('UPDATE agent_memory_imports SET written_hash = ? WHERE agent_id = ?', written.hash, agentId));
  return 'written';
}

/** For the owner: imported or not, how many history rows, and whether MEMORY.md was changed outside Girru. */
export async function agentMemoryStatus(agentId: string): Promise<{ imported: boolean; versions: number; outsideChange: boolean }> {
  assertNoLegacyMemoryFileAccess();
  const ledger = await sql().read(ledgerStep(agentId));
  if (!ledger) return { imported: false, versions: 0, outsideChange: false };
  const file = await readMemorySnapshot(agentId).catch(() => null);
  const versions = await sql().read(one<{ n: number }>('SELECT COUNT(*) AS n FROM memory_versions WHERE memory_id = ?', ledger.memory_id));
  return { imported: true, versions: Number(versions?.n ?? 0), outsideChange: !!file && file.hash !== ledger.written_hash };
}

/** P5a: the notes' history for the owner, newest first (who: the owner, an agent id, or an import word). */
export async function agentNotesHistory(agentId: string): Promise<Array<{ version: number; change: string; createdAt: string; by: string; reason: string | null; content: string | null }> | null> {
  assertNoLegacyMemoryFileAccess();
  if (!storeP5Enabled()) return null;
  const ledger = await sql().read(ledgerStep(agentId));
  if (!ledger) return [];
  const rows = await sql().read(all<{ version: number; change: string; created_at: string; created_by: string; user_id: string; reason: string | null; content: string | null }>(
    'SELECT version, change, created_at, created_by, user_id, reason, content FROM memory_versions WHERE memory_id = ? ORDER BY version DESC LIMIT 40', ledger.memory_id));
  // The owner's id is never shown: their own changes say "owner".
  return rows.map((r) => ({ version: Number(r.version), change: r.change, createdAt: String(r.created_at), by: r.created_by === r.user_id ? 'owner' : r.created_by, reason: r.reason, content: r.content }));
}

/** P5b: MEMORY.md as it is now next to the notes Girru keeps, only while the file was changed outside Girru. */
export async function agentNotesOutside(agentId: string): Promise<{ file: string; fileHash: string; notes: string; notesHash: string } | null> {
  assertNoLegacyMemoryFileAccess();
  if (!storeP5Enabled()) return null;
  const state = await sql().read((function* () { return { ledger: yield* ledgerStep(agentId), notes: yield* notesStep(agentId) }; })());
  if (!state.ledger || !state.notes) return null;
  const file = await readMemorySnapshot(agentId);
  if (!file.hash || file.hash === state.ledger.written_hash) return null;
  return { file: file.content, fileHash: file.hash, notes: state.notes.content, notesHash: sha(state.notes.content) };
}

/**
 * P5b (D19): the owner settles a MEMORY.md changed outside Girru. Nothing
 * happens until they pick, and the pick is made over the file version they
 * saw (`fileHash`, 409 when it moved on).
 *  - 'use':  the file text becomes the next version of the notes (Undo = the version before).
 *  - 'keep': Girru's notes stay and the file is written back from them.
 */
export async function settleAgentNotesOutside(agentId: string, pick: unknown, fileHash: unknown, actor: string): Promise<{ hash: string; previousHash: string }> {
  assertNoLegacyMemoryFileAccess();
  if ((pick !== 'use' && pick !== 'keep') || typeof fileHash !== 'string' || !/^[a-f0-9]{64}$/.test(fileHash)) throw new AgentMemoryInputError('invalid');
  const now = await agentNotesOutside(agentId);
  if (!now) throw new AgentMemoryConflict('no_outside_change');
  if (now.fileHash !== fileHash) throw new AgentMemoryConflict('changed');
  let hash = now.notesHash;
  if (pick === 'use') hash = (await saveAgentNotes(agentId, now.file, now.notesHash, actor)).hash;
  // Either way the file on disk is now the version Girru knows; then the view is written from the notes.
  await sql().read(run('UPDATE agent_memory_imports SET written_hash = ? WHERE agent_id = ?', fileHash, agentId));
  await writeAgentNotesView(agentId);
  return { hash, previousHash: now.notesHash };
}

export function agentNotes(...args:Parameters<typeof agentNotesCurrent>):ReturnType<typeof agentNotesCurrent>{return consumeCurrentEncryptedMemoryScope(()=>agentNotesCurrent(...args));}

export function agentMemoryForPrompt(...args:Parameters<typeof agentMemoryForPromptCurrent>):ReturnType<typeof agentMemoryForPromptCurrent>{return consumeCurrentEncryptedMemoryScope(()=>agentMemoryForPromptCurrent(...args));}
