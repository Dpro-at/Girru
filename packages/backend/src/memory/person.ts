import {assertNoLegacyMemoryAccess,selectedEncryptedOwnerRuntime} from './encryption/consumer-host.js';
import {assertNoDefaultMemoryAccess} from './encryption/execution-context.js';
/**
 * STORE-MAP-01 P9 (PRIV5, PRIV6): one person's data (GIRRU_STORE_P9).
 *
 * Export: everything this user's memory holds about one person, in one file:
 *  - the person's drawer (`people:<key>`): current memories and replaced facts;
 *  - memories in other drawers that mention them: linked to their graph
 *    entity, or naming them (the key or a graph name/alias as a whole word);
 *  - their graph entities and how many links those have;
 *  - handoff notes whose lines name them.
 * An agent's own notes are included only as ids and counts (S5).
 *
 * Forget: one action. The person's drawer (every memory and its history,
 * through forget.ts, with a 'person' line in the forget ledger), the
 * mentioning memories the owner picked from the export (only ids the export
 * listed), and the person's graph entities. Handoff notes are not deleted
 * (they are work records); the export lists them so the owner can edit them.
 *
 * Retention (PRIV5): a replaced fact about a person (`status = 'replaced'`
 * in a people drawer) is forgotten once it has been replaced for
 * PEOPLE_REPLACED_DAYS; current facts are kept. Run by memory retention
 * (retention.ts) while P9 is on.
 */

import { all, run, sql, tableExists } from '../repositories/sql-steps.js';
import { normalizeMemoryText } from './text-normalize.js';
import { DRAWER_KEY_SQL, DRAWER_KIND_SQL, isValidDrawerKey } from './drawers.js';
import { forgetMemory, forgetPersonMemories } from './forget.js';

export const PEOPLE_REPLACED_DAYS = 365;
const DAY = 86_400_000;

export interface PersonMemory { id: string; drawer: string; type: string; status: string; content: string; createdAt: string; validTo: string | null }
export interface PersonExport {
  person: string;
  exportedAt: string;
  names: string[];
  drawer: PersonMemory[];
  mentions: Array<PersonMemory & { why: 'graph' | 'name' }>;
  agentNotes: { count: number; ids: string[] };
  graph: Array<{ id: string; name: string; aliases: string[]; links: number }>;
  handoffs: Array<{ id: string; agentId: string; scope: string; createdAt: string; lines: string[] }>;
}

export class PersonError extends Error { constructor(readonly status: number, message: string) { super(message); } }

const norm = (s: string) => normalizeMemoryText(s).toLowerCase().replace(/[-_.]+/g, ' ').trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A whole-word, normalized match of any of the names. */
function namer(names: string[]): (text: string) => boolean {
  const pats = names.filter((n) => n.length >= 2).map((n) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(n)}($|[^\\p{L}\\p{N}])`, 'u'));
  return (text) => { const t = norm(text); return pats.some((p) => p.test(t)); };
}

function row(r: any): PersonMemory {
  return { id: r.id, drawer: r.dk + (r.dkey ? `:${r.dkey}` : ''), type: r.type, status: r.status || 'active', content: r.content, createdAt: String(r.created_at), validTo: r.valid_to ?? null };
}

async function graphOf(userId: string, key: string): Promise<Array<{ id: string; name: string; aliases: string[] }>> {
  const k = norm(key);
  const rows = await sql().read(all<{ id: string; name: string; norm_name: string; aliases: string }>(
    "SELECT id, name, norm_name, aliases FROM memory_graph_entities WHERE user_id = ? AND kind = 'person'", userId)).catch(() => []);
  return rows
    .map((r) => ({ id: r.id, name: r.name, aliases: (() => { try { const a = JSON.parse(r.aliases); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; } catch { return []; } })(), n: r.norm_name }))
    .filter((r) => norm(r.n) === k || norm(r.name) === k || r.aliases.some((a) => norm(a) === k))
    .map(({ id, name, aliases }) => ({ id, name, aliases }));
}

/** Everything about one person (PRIV6). */
export async function exportPerson(userId: string, personKey: string, now: Date = new Date()): Promise<PersonExport> {
  const encrypted=await selectedEncryptedOwnerRuntime(userId);if(encrypted)return encrypted.ownerPerson(personKey,true);
  assertNoLegacyMemoryAccess();assertNoDefaultMemoryAccess();
  if (!isValidDrawerKey('people', personKey)) throw new PersonError(400, 'Not a valid person');
  const entities = await graphOf(userId, personKey);
  const names = [...new Set([personKey, ...entities.flatMap((e) => [e.name, ...e.aliases])].map(norm).filter(Boolean))];
  const matches = namer(names);

  const rows = await sql().read(all<any>(
    `SELECT id, type, content, status, created_at, valid_to, ${DRAWER_KIND_SQL} AS dk, ${DRAWER_KEY_SQL} AS dkey
       FROM memories WHERE user_id = ? ORDER BY created_at ASC, id ASC`, userId));
  const ids = entities.map((e) => e.id);
  const linked = new Set(ids.length
    ? (await sql().read(all<{ memory_id: string }>(`SELECT memory_id FROM memory_graph_mentions WHERE user_id = ? AND entity_id IN (${ids.map(() => '?').join(', ')})`, userId, ...ids)).catch(() => [])).map((r) => r.memory_id)
    : []);

  const drawer: PersonMemory[] = [];
  const mentions: PersonExport['mentions'] = [];
  const agentNoteIds: string[] = [];
  for (const r of rows) {
    if (r.dk === 'people' && r.dkey === personKey) { drawer.push(row(r)); continue; }
    const why = linked.has(r.id) ? 'graph' : matches(r.content) ? 'name' : null;
    if (!why) continue;
    if (r.dk === 'agent') { agentNoteIds.push(r.id); continue; } // S5: an agent's own notes, ids only
    mentions.push({ ...row(r), why });
  }

  const graph: PersonExport['graph'] = [];
  for (const e of entities) {
    const [c] = await sql().read(all<{ n: number }>('SELECT COUNT(*) AS n FROM memory_graph_links WHERE user_id = ? AND (src_id = ? OR dst_id = ?)', userId, e.id, e.id)).catch(() => [{ n: 0 }]);
    graph.push({ ...e, links: Number(c?.n ?? 0) });
  }

  const handoffs: PersonExport['handoffs'] = [];
  const hrows = await sql().read(all<any>(
    'SELECT id, agent_id, scope_kind, scope_id, created_at, done, remaining, next_steps, open_questions FROM agent_handoffs WHERE owner_id = ? ORDER BY created_at ASC, id ASC', userId)).catch(() => []);
  for (const h of hrows) {
    const lines: string[] = [];
    for (const col of ['done', 'remaining', 'next_steps', 'open_questions']) {
      try { for (const l of JSON.parse(h[col] || '[]')) if (typeof l === 'string' && matches(l)) lines.push(l); } catch { /* not a list */ }
    }
    if (lines.length) handoffs.push({ id: h.id, agentId: h.agent_id, scope: `${h.scope_kind}:${h.scope_id}`, createdAt: String(h.created_at), lines });
  }

  return { person: personKey, exportedAt: now.toISOString(), names, drawer, mentions, agentNotes: { count: agentNoteIds.length, ids: agentNoteIds }, graph, handoffs };
}

/**
 * Forget a person in one action (PRIV6). `mentionIds` must come from this
 * person's export (others are refused); `confirm` must be the person's key.
 */
export async function forgetPerson(userId: string, personKey: string, actor: string, opts: { confirm: unknown; mentionIds?: unknown }): Promise<{ drawer: number; mentions: number; graph: number }> {
  const encrypted=await selectedEncryptedOwnerRuntime(userId);if(encrypted){if(actor!==userId||opts.confirm!==personKey||opts.mentionIds!==undefined&&(!Array.isArray(opts.mentionIds)||opts.mentionIds.some(id=>typeof id!=='string')))throw new PersonError(400,'Explicit owner confirmation required');return encrypted.ownerForgetPerson(personKey,{confirm:personKey,mentionIds:opts.mentionIds as string[]|undefined});}
  assertNoLegacyMemoryAccess();assertNoDefaultMemoryAccess();
  if (!isValidDrawerKey('people', personKey)) throw new PersonError(400, 'Not a valid person');
  if (opts.confirm !== personKey) throw new PersonError(400, 'Type the person\'s name to confirm');
  const wanted = opts.mentionIds === undefined ? [] : opts.mentionIds;
  if (!Array.isArray(wanted) || wanted.length > 5000 || !wanted.every((x) => typeof x === 'string')) throw new PersonError(400, 'mentionIds must be a list of memory ids');
  const exp = await exportPerson(userId, personKey);
  const allowed = new Set(exp.mentions.map((m) => m.id));
  const bad = (wanted as string[]).filter((id) => !allowed.has(id));
  if (bad.length) throw new PersonError(400, 'Some memories do not mention this person');

  const drawer = (await forgetPersonMemories(userId, personKey, actor)).forgotten;
  let mentions = 0;
  for (const id of new Set(wanted as string[])) if (await forgetMemory(userId, id, actor)) mentions++;
  // The person's graph entries (forgetting their memories may already have removed an orphan one).
  for (const e of exp.graph) {
    await sql().read(run('DELETE FROM memory_graph_entities WHERE user_id = ? AND id = ?', userId, e.id)).catch(() => undefined);
  }
  const graph = exp.graph.length;
  // P9b (MD8): open questions that name the person (case-insensitive, by word) go too.
  if (await sql().read(tableExists('memory_open_questions')).catch(() => false)) {
    const names = exp.names.map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 2);
    const qs = await sql().read(all<{ id: string; question: string }>('SELECT id, question FROM memory_open_questions WHERE user_id = ?', userId));
    for (const q of qs) {
      const text = ` ${q.question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
      if (names.some((n) => text.includes(` ${n.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `))) {
        await sql().read(run('DELETE FROM memory_open_questions WHERE user_id = ? AND id = ?', userId, q.id));
      }
    }
  }
  return { drawer, mentions, graph };
}

/** PRIV5: replaced facts about people, replaced longer than PEOPLE_REPLACED_DAYS ago. */
export async function stalePeopleFacts(userId: string, now: Date = new Date()): Promise<Array<{ id: string; person: string; validTo: string }>> {
  assertNoLegacyMemoryAccess();assertNoDefaultMemoryAccess();
  const cutoff = new Date(now.getTime() - PEOPLE_REPLACED_DAYS * DAY).toISOString();
  const rows = await sql().read(all<{ id: string; dkey: string; valid_to: string | null; created_at: string }>(
    `SELECT id, ${DRAWER_KEY_SQL} AS dkey, valid_to, created_at FROM memories
      WHERE user_id = ? AND ${DRAWER_KIND_SQL} = 'people' AND status = 'replaced' ORDER BY id`, userId));
  // A replaced row without valid_to (older than P3) counts from when it was saved.
  return rows.filter((r) => String(r.valid_to ?? r.created_at) < cutoff).map((r) => ({ id: r.id, person: r.dkey, validTo: String(r.valid_to ?? r.created_at) }));
}
