/**
 * Hidden keys in memory (MEM-READ-01 MR2).
 *
 * Passwords, SSH logins, API keys and tokens found in memory text (at import,
 * on save or edit, and once over memories saved before) are moved to the
 * encrypted key store and the text keeps a reference `[SECRET:<type>:<id>]`,
 * shown as a lock chip. The value never reaches recall, replies, MCP or an
 * export.
 *
 * Kept here: a credential with skill `memory` (name `chat:<type>:<id>`, so the
 * reference has the chat format). Agents cannot resolve it: the tools registry
 * resolves only skill `chat` keys. "Move to Connections…" turns it into a
 * Saved key (skill `chat`), which an agent may use only with the owner's
 * approval, like a key typed in the chat. "Show" reveals one value to the
 * owner alone (audited by the route).
 *
 * The Needs you row reads the report: how many were hidden, where and what
 * kind; it disappears when the owner answers (Keep hidden here / Move).
 */

import { getCredentialManager } from '../credentials/manager.js';
import { getCredentialStorage } from '../credentials/storage.js';
import { CredentialType } from '../credentials/types.js';
import { all, one, run, sql } from '../repositories/sql-steps.js';
import { CHAT_SECRET_SKILL, vaultSecretsInText } from '../services/chat-secrets.js';
import { SECRET_REF_RE, redactImportText, type RedactionType } from './import/redact.js';

export const MEMORY_SECRET_SKILL = 'memory';
const NAME_RE = /^chat:([a-z_]+):([a-z0-9]{6,32})$/;
const REF_PARTS = /^\[SECRET:([a-z_]+):([a-z0-9]{6,32})\]$/;

/** The plain word for a kind of key (for chips and the Needs you row). */
export function keyKindLabel(type: string): 'login' | 'password' | 'key' | 'token' {
  if (type === 'url_credentials' || type === 'basic_auth' || type === 'ssh_login') return 'login';
  if (type === 'password') return 'password';
  if (/token|jwt|bearer/.test(type)) return 'token';
  return 'key';
}

let ready: Promise<void> | null = null;
const storeReady = () => (ready ??= getCredentialStorage().initialize().catch((e) => { ready = null; throw e; }));

/** Move the keys in `text` to the key store (owner `userId`, kept as hidden). Returns the text with references. */
export async function hideKeysInText(userId: string, text: string, where: string): Promise<{ text: string; hidden: Array<{ id: string; type: RedactionType }> }> {
  if (!text || !redactImportText(text).total) return { text, hidden: [] };
  // Stored as memory keys (never resolvable by an agent) until the owner moves them to Connections.
  const out = await vaultSecretsInText(userId, `memory:${where}`.slice(0, 200), text, undefined, MEMORY_SECRET_SKILL);
  return { text: out.text, hidden: out.saved.map((s) => ({ id: s.id, type: s.type })) };
}

async function own(userId: string, id: string) {
  await storeReady();
  return (await getCredentialManager().list(userId)).find((c) => c.userId === userId && NAME_RE.exec(c.name)?.[2] === id) ?? null;
}

/** Re-create the credential under another skill (the store has no skill update); the reference stays the same. */
async function setSkill(userId: string, id: string, skill: string): Promise<boolean> {
  const c = await own(userId, id);
  if (!c) return false;
  if (c.skillId === skill) return true;
  const m = getCredentialManager();
  const value = await m.getValue(c.id);
  await m.delete(c.id);
  try {
    // A Saved key from memory belongs to no chat (the Saved keys list links chats by `chat:<id>`).
    const description = skill === CHAT_SECRET_SKILL ? `memory ${(c.description ?? '').replace(/^chat:memory:/, '')}`.trim() : c.description ?? undefined;
    await m.create({ name: c.name, type: c.type as CredentialType, value, description, skillId: skill, userId });
  } catch (e) {
    await m.create({ name: c.name, type: c.type as CredentialType, value, description: c.description ?? undefined, skillId: c.skillId ?? undefined, userId });
    throw e;
  }
  return true;
}

/**
 * Hide the keys in proposed changes. An update keeps the references its `before` already has
 * (the same value gets the same reference, so a re-import does not hide one key twice).
 */
export async function hideKeysInChanges<C extends { op: string; after?: { content: string }; before?: { content: string } }>(userId: string, changes: C[], where: string): Promise<{ changes: C[]; hidden: Array<{ id: string; type: RedactionType }> }> {
  const hidden: Array<{ id: string; type: RedactionType }> = [];
  const out: C[] = [];
  for (const c of changes) {
    if (!c.after || typeof c.after.content !== 'string' || !redactImportText(c.after.content).total) { out.push(c); continue; }
    let content = c.after.content;
    // Reuse the before's references for values that are the same.
    for (const r of keyRefs(c.before?.content ?? '')) {
      const value = await revealKey(userId, r.id).catch(() => null);
      if (value && content.includes(value)) content = content.split(value).join(r.ref);
    }
    const res = await hideKeysInText(userId, content, where);
    hidden.push(...res.hidden);
    out.push({ ...c, after: { ...c.after, content: res.text } });
  }
  return { changes: out, hidden };
}

/** The references in a text: [{ ref, type, id }]. */
export function keyRefs(text: string): Array<{ ref: string; type: string; id: string }> {
  const out: Array<{ ref: string; type: string; id: string }> = [];
  for (const ref of text.match(SECRET_REF_RE) ?? []) { const m = REF_PARTS.exec(ref); if (m && !out.some((x) => x.ref === ref)) out.push({ ref, type: m[1], id: m[2] }); }
  return out;
}

/** Where a hidden key is now: kept hidden in memory, a Saved key (Connections), or gone. */
export async function keyState(userId: string, id: string): Promise<'hidden' | 'connections' | 'missing'> {
  const c = await own(userId, id);
  return !c ? 'missing' : c.skillId === CHAT_SECRET_SKILL ? 'connections' : 'hidden';
}

/** The owner's "Show": one value, for the owner alone. Null when unknown. */
export async function revealKey(userId: string, id: string): Promise<string | null> {
  if (!/^[a-z0-9]{6,32}$/.test(id)) return null;
  const c = await own(userId, id);
  return c ? getCredentialManager().getValue(c.id) : null;
}

/** Move hidden keys to Connections (Saved keys): an agent may then use one only with the owner's approval. */
export async function moveKeysToConnections(userId: string, ids: string[]): Promise<number> {
  let moved = 0;
  for (const id of ids.slice(0, 500)) if (/^[a-z0-9]{6,32}$/.test(id) && await setSkill(userId, id, CHAT_SECRET_SKILL)) moved++;
  return moved;
}

// ---------------------------------------------------------------------------
// The report behind the Needs you row, and the one-time run over old memories
// ---------------------------------------------------------------------------

function* ensureTable() {
  yield* run(`CREATE TABLE IF NOT EXISTS memory_hidden_keys (owner_id TEXT NOT NULL, key_id TEXT NOT NULL, kind TEXT NOT NULL, memory_id TEXT, drawer TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL, PRIMARY KEY (owner_id, key_id))`);
  yield* run('CREATE TABLE IF NOT EXISTS memory_hidden_keys_runs (owner_id TEXT PRIMARY KEY, done_at TEXT NOT NULL, memories INTEGER NOT NULL, hidden INTEGER NOT NULL)');
}

const running = new Map<string, Promise<unknown>>();
/** The one-time run over saved memories, once per owner (kept as done in memory_hidden_keys_runs). */
export async function hideKeysOnce(userId: string): Promise<void> {
  const done = await sql().tx(function* () { yield* ensureTable(); return yield* one('SELECT 1 AS x FROM memory_hidden_keys_runs WHERE owner_id = ?', userId); });
  if (done) return;
  if (!running.has(userId)) running.set(userId, (async () => {
    const r = await hideKeysInSavedMemories(userId);
    await sql().tx(function* () { yield* run('INSERT INTO memory_hidden_keys_runs (owner_id, done_at, memories, hidden) VALUES (?, ?, ?, ?) ON CONFLICT (owner_id) DO NOTHING', userId, new Date().toISOString(), r.memories, r.keys); });
  })().finally(() => running.delete(userId)));
  await running.get(userId);
}

/** Record keys hidden in one memory (state 'new' until the owner answers the Needs you row). */
export async function recordHiddenKeys(userId: string, memoryId: string | null, drawer: string, hidden: Array<{ id: string; type: string }>): Promise<void> {
  if (!hidden.length) return;
  const now = new Date().toISOString();
  await sql().tx(function* () {
    yield* ensureTable();
    for (const h of hidden) yield* run(`INSERT INTO memory_hidden_keys (owner_id, key_id, kind, memory_id, drawer, state, created_at) VALUES (?, ?, ?, ?, ?, 'new', ?) ON CONFLICT (owner_id, key_id) DO NOTHING`,
      userId, h.id, h.type, memoryId, drawer, now);
  });
}

export interface HiddenKeysReport { total: number; drawers: Array<{ drawer: string; count: number; memories: number; kinds: Record<string, number> }>; keyIds: string[] }

/** The keys hidden since the owner last answered (state 'new'). */
export async function hiddenKeysReport(userId: string): Promise<HiddenKeysReport> {
  const rows = await sql().tx(function* () { yield* ensureTable(); return yield* all<{ key_id: string; kind: string; memory_id: string | null; drawer: string }>("SELECT key_id, kind, memory_id, drawer FROM memory_hidden_keys WHERE owner_id = ? AND state = 'new' ORDER BY created_at", userId); });
  const by = new Map<string, { drawer: string; count: number; memories: Set<string>; kinds: Record<string, number> }>();
  for (const r of rows) {
    const d = by.get(r.drawer) ?? { drawer: r.drawer, count: 0, memories: new Set<string>(), kinds: {} };
    d.count++; if (r.memory_id) d.memories.add(r.memory_id);
    const k = keyKindLabel(r.kind); d.kinds[k] = (d.kinds[k] ?? 0) + 1;
    by.set(r.drawer, d);
  }
  return { total: rows.length, drawers: [...by.values()].map((d) => ({ drawer: d.drawer, count: d.count, memories: d.memories.size, kinds: d.kinds })), keyIds: rows.map((r) => r.key_id) };
}

/** The owner's answer to the Needs you row: keep them hidden here, or move them to Connections. */
export async function answerHiddenKeys(userId: string, answer: 'keep' | 'move', drawer?: string): Promise<{ answered: number; moved: number }> {
  const scoped = (await sql().tx(function* () {
    yield* ensureTable();
    return drawer ? yield* all<{ key_id: string }>("SELECT key_id FROM memory_hidden_keys WHERE owner_id = ? AND state = 'new' AND drawer = ?", userId, drawer)
      : yield* all<{ key_id: string }>("SELECT key_id FROM memory_hidden_keys WHERE owner_id = ? AND state = 'new'", userId);
  })).map((r) => r.key_id);
  const moved = answer === 'move' ? await moveKeysToConnections(userId, scoped) : 0;
  await sql().tx(function* () { for (const id of scoped) yield* run("UPDATE memory_hidden_keys SET state = ? WHERE owner_id = ? AND key_id = ?", answer === 'move' ? 'moved' : 'kept', userId, id); });
  return { answered: scoped.length, moved };
}

/**
 * The one-time run over memories saved before this rule (plain-text rows):
 * every key found is hidden and reported. Returns how many memories changed.
 * Safe to run again: a memory without keys is left untouched.
 */
export async function hideKeysInSavedMemories(userId: string, opts: { limit?: number } = {}): Promise<{ memories: number; keys: number }> {
  const rows = await sql().read(all<{ id: string; content: string; drawer_kind: string | null; drawer_key: string | null }>(
    "SELECT id, content, drawer_kind, drawer_key FROM memories WHERE user_id = ? AND content IS NOT NULL AND content <> '' ORDER BY created_at LIMIT ?", userId, opts.limit ?? 100_000));
  let memories = 0, keys = 0;
  for (const r of rows) {
    if (typeof r.content !== 'string' || !redactImportText(r.content).total) continue;
    const drawer = r.drawer_kind === 'project' || r.drawer_kind === 'task' || r.drawer_kind === 'people' ? `${r.drawer_kind}:${r.drawer_key}` : (r.drawer_kind ?? 'owner');
    const out = await hideKeysInText(userId, r.content, drawer);
    if (out.text === r.content) continue;
    const changed = await sql().tx(function* () {
      const still = yield* one<{ content: string }>('SELECT content FROM memories WHERE user_id = ? AND id = ?', userId, r.id);
      if (!still || still.content !== r.content) return false; // changed meanwhile: the next run takes it
      yield* run('UPDATE memories SET content = ? WHERE user_id = ? AND id = ?', out.text, userId, r.id);
      return true;
    }, { immediate: true });
    if (!changed) continue;
    await recordHiddenKeys(userId, r.id, drawer, out.hidden);
    memories++; keys += out.hidden.length;
  }
  return { memories, keys };
}

/** For tests and the backfill: the count of hidden keys kept as memory keys. */
export async function hiddenKeyCount(userId: string): Promise<number> {
  await storeReady();
  return (await getCredentialManager().list(userId)).filter((c) => c.userId === userId && c.skillId === MEMORY_SECRET_SKILL && NAME_RE.test(c.name)).length;
}
