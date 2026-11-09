import {selectedMemoryExecution} from '../encryption/execution-context.js';
import type {EncryptedOpenQuestion} from '../encryption/questions-gateway.js';
/**
 * What the owner sees of the memory quality engine (STORE-MAP-01 P9b screens,
 * boards P9b-1 to P9b-3; GIRRU_STORE_P9B). Read and act on the records the
 * engine keeps (trust.ts, usage.ts, pipeline.ts); no new tables.
 *
 *   trust        "How sure" per memory: one of three levels (verified, heard
 *                once, not checked), who it was heard from (kinds and agent ids,
 *                never text), how often replies used it.
 *   verify       the owner says a memory is right: an owner source
 *                (OWNER_VERIFIED) is added, so it becomes high and verified at
 *                once; unverify takes exactly that source away again (Undo).
 *                Owner only: agents never verify (no tool does this).
 *   corrected    memories the owner corrected after a reply had used them
 *                (flag corrected-after-use): what it said before and now, and
 *                the replies that used the old text. "Mark as checked" adds
 *                CHECKED_FLAG (the corrected flag stays, so the weekly job does
 *                not raise it again); Undo takes it away.
 *   questions    the questions an agent asked once because nothing reliable
 *                was stored (MD8): answer (saved as the owner's own fact, which
 *                resolves it), or forget it (kept for Undo for UNDO_MS).
 */

import { v4 as uuidv4 } from 'uuid';
import { all, one, run, sql, tableExists, type Step } from '../../repositories/sql-steps.js';
import { storeP9bEnabled } from '../../services/store-p9b.js';
import { CORRECTED_FLAG } from './usage.js';
import { OPEN_QUESTION_DAYS, QUESTION_KEEP_DAYS } from './pipeline.js';
import { bandOf, contentHash, corroborateStep, legacyConfidence, trustOf, trustTablesReady, type TrustKind } from './trust.js';

export class TrustViewError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
const notFound = () => new TrustViewError('Not found', 404, 'not_found');

/** The source key of the owner's "Mark as verified" (Undo removes exactly this one). */
export const OWNER_VERIFIED = 'owner:verified';
/** The owner looked at a corrected-after-use memory. */
export const CHECKED_FLAG = 'corrected-checked';
/** How long a forgotten question can be brought back with Undo. */
export const UNDO_MS = 10 * 60_000;

export type TrustLevel = 'verified' | 'heard-once' | 'not-checked';
export interface TrustView {
  id: string;
  level: TrustLevel;
  /** True when the owner marked it verified by hand (Undo can take that back). */
  byOwner: boolean;
  /** Who it was heard from, first first: kinds and agent ids only. */
  heardFrom: Array<{ kind: TrustKind | 'you'; agentId?: string }>;
  uses: number;
  lastUsedAt: string | null;
}

async function ready(): Promise<boolean> {
  return storeP9bEnabled() && (await trustTablesReady());
}
const ids = (list: readonly unknown[]) => [...new Set(list.filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9_.@:-]{1,200}$/.test(x)))].slice(0, 200);
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');
const parseFlags = (s: string | null | undefined): string[] => { try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; } };
const parseMeta = (s: string | null | undefined): Record<string, unknown> => { try { const v = JSON.parse(s ?? '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

/** A memory's level from its confidence and verification (pure). */
export function levelOf(t: { confidence: number; verified: boolean }): TrustLevel {
  if (t.verified) return 'verified';
  return bandOf(t.confidence) === 'low' ? 'not-checked' : 'heard-once';
}

/** "How sure" for these memories of the owner (missing ids are left out). */
export async function trustView(userId: string, memoryIds: readonly unknown[]): Promise<TrustView[]> {
  const list = ids(memoryIds);
  if (!list.length || !(await ready())) return [];
  return sql().read((function* (): Step<TrustView[]> {
    const mems = yield* all<{ id: string; content: string; metadata: string | null; source_agent_id: string | null }>(
      `SELECT id, content, metadata, source_agent_id FROM memories WHERE user_id = ? AND id IN (${marks(list.length)})`, userId, ...list);
    const trust = new Map((yield* all<{ memory_id: string; content_hash: string; confidence: number; verified: number }>(
      `SELECT memory_id, content_hash, confidence, verified FROM memory_trust WHERE user_id = ? AND memory_id IN (${marks(list.length)})`, userId, ...list)).map((r) => [r.memory_id, r]));
    const sources = yield* all<{ memory_id: string; source_key: string; kind: TrustKind; content_hash: string }>(
      `SELECT memory_id, source_key, kind, content_hash FROM memory_trust_sources WHERE user_id = ? AND memory_id IN (${marks(list.length)}) ORDER BY at, source_key`, userId, ...list);
    const uses = new Map((yield* all<{ memory_id: string; n: number; last: string | null }>(
      `SELECT memory_id, COUNT(*) AS n, MAX(created_at) AS last FROM memory_recall_uses WHERE user_id = ? AND memory_id IN (${marks(list.length)}) GROUP BY memory_id`, userId, ...list)).map((r) => [r.memory_id, r]));
    return mems.map((m) => {
      const hash = contentHash(m.content);
      const t = trust.get(m.id);
      const current = t && t.content_hash === hash;
      const judged = current ? { confidence: Number(t.confidence), verified: Number(t.verified) === 1 } : legacyConfidence({ metadata: parseMeta(m.metadata), sourceAgentId: m.source_agent_id });
      const own = current ? sources.filter((s) => s.memory_id === m.id && s.content_hash === hash) : [];
      const heardFrom: TrustView['heardFrom'] = [];
      for (const s of own) {
        const kind = s.kind === 'owner' || s.kind === 'approved' ? 'you' as const : s.kind;
        const agentId = s.source_key.startsWith('agent:') ? s.source_key.slice(6, 134) : undefined;
        if (!heardFrom.some((h) => h.kind === kind && h.agentId === agentId)) heardFrom.push(agentId ? { kind, agentId } : { kind });
      }
      if (!own.length && m.source_agent_id) heardFrom.push({ kind: 'agent', agentId: m.source_agent_id });
      const u = uses.get(m.id);
      return { id: m.id, level: levelOf(judged), byOwner: own.some((s) => s.source_key === OWNER_VERIFIED), heardFrom: heardFrom.slice(0, 8), uses: Number(u?.n) || 0, lastUsedAt: u?.last ?? null };
    });
  })());
}

/** The first source a memory written before P9b gets when the owner verifies it (so its history is not lost). */
function legacyKind(meta: Record<string, unknown>, agent: string | null): TrustKind {
  const s = String(meta.source ?? '');
  if (s === 'outsider') return 'channel';
  if (s === 'extraction') return 'chat';
  if (agent || s === 'agent') return 'agent';
  return 'system';
}

/** Mark as verified (owner only): the memory becomes high and verified at once. */
export async function markVerified(userId: string, memoryId: string): Promise<TrustView> {
  if (!(await ready())) throw notFound();
  const at = new Date().toISOString();
  await sql().tx(function* (): Step<void> {
    const m = yield* one<{ id: string; user_id: string; content: string; metadata: string | null; source_agent_id: string | null }>(
      `SELECT id, user_id, content, metadata, source_agent_id FROM memories WHERE id = ? AND user_id = ? AND (status IS NULL OR status = 'active')`, memoryId, userId);
    if (!m) throw notFound();
    const mem = { id: m.id, userId: m.user_id, content: m.content };
    const t = yield* one<{ content_hash: string }>('SELECT content_hash FROM memory_trust WHERE memory_id = ? AND user_id = ?', m.id, userId);
    if (!t || t.content_hash !== contentHash(m.content)) {
      const kind = legacyKind(parseMeta(m.metadata), m.source_agent_id);
      yield* corroborateStep(mem, { kind, key: m.source_agent_id ? `agent:${m.source_agent_id}` : `legacy:${kind}` }, 'legacy', at);
    }
    yield* corroborateStep(mem, { kind: 'owner', key: OWNER_VERIFIED }, 'owner', at);
  });
  return (await trustView(userId, [memoryId]))[0];
}

/** Undo of Mark as verified: exactly the owner's verify source goes; the rest is judged again. */
export async function unmarkVerified(userId: string, memoryId: string): Promise<TrustView> {
  if (!(await ready())) throw notFound();
  await sql().tx(function* (): Step<void> {
    const t = yield* one<{ memory_id: string }>('SELECT memory_id FROM memory_trust WHERE memory_id = ? AND user_id = ?', memoryId, userId);
    if (!t) throw notFound();
    yield* run('DELETE FROM memory_trust_sources WHERE memory_id = ? AND user_id = ? AND source_key = ?', memoryId, userId, OWNER_VERIFIED);
    const rows = yield* all<{ source_key: string; kind: TrustKind }>('SELECT source_key, kind FROM memory_trust_sources WHERE memory_id = ? AND user_id = ? ORDER BY at, source_key', memoryId, userId);
    const next = trustOf(rows.map((r) => ({ key: r.source_key, kind: r.kind })));
    yield* run('UPDATE memory_trust SET confidence = ?, verified = ?, updated_at = ? WHERE memory_id = ? AND user_id = ?', next.confidence, next.verified ? 1 : 0, new Date().toISOString(), memoryId, userId);
  });
  const out = (await trustView(userId, [memoryId]))[0];
  if (!out) throw notFound();
  return out;
}

// ---------------------------------------------------------------- corrected after use

export interface CorrectedReply { runId: string; sessionId: string | null; title: string | null; agentId: string | null; at: string }
export interface CorrectedItem {
  memoryId: string;
  /** Where the memory is kept (drawer id, e.g. project:alpha). */
  drawer: string;
  /** The memory that holds the text now (the newer fact when it was replaced). */
  nowId: string;
  was: string;
  now: string;
  changedAt: string | null;
  how: 'edited' | 'replaced';
  checked: boolean;
  replies: CorrectedReply[];
  replyCount: number;
}

const clip = (s: unknown, n = 2000) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The memories the owner corrected after replies used them, unchecked first, then newest. */
export async function correctedList(userId: string, limit = 50): Promise<CorrectedItem[]> {
  if (!(await ready())) return [];
  return sql().read((function* (): Step<CorrectedItem[]> {
    const flagged = yield* all<{ memory_id: string; flags: string | null; updated_at: string }>(
      'SELECT memory_id, flags, updated_at FROM memory_trust WHERE user_id = ? AND flags LIKE ? ORDER BY updated_at DESC, memory_id LIMIT ?', userId, `%${CORRECTED_FLAG}%`, Math.min(200, limit * 2));
    const titled = yield* tableExists('chat_sessions');
    const out: CorrectedItem[] = [];
    for (const f of flagged) {
      const flags = parseFlags(f.flags);
      if (!flags.includes(CORRECTED_FLAG)) continue;
      const m = yield* one<{ id: string; content: string; superseded_by: string | null; valid_to: string | null; drawer_kind: string | null; drawer_key: string | null }>(
        'SELECT * FROM memories WHERE id = ? AND user_id = ?', f.memory_id, userId);
      if (!m) continue;
      const drawer = m.drawer_kind ? (m.drawer_key ? `${m.drawer_kind}:${m.drawer_key}` : m.drawer_kind) : 'owner';
      let item: Omit<CorrectedItem, 'replies' | 'replyCount' | 'checked' | 'drawer'> | null = null;
      if (m.superseded_by && m.valid_to) {
        const n = yield* one<{ id: string; content: string }>('SELECT id, content FROM memories WHERE id = ? AND user_id = ?', m.superseded_by, userId);
        if (n) item = { memoryId: m.id, nowId: n.id, was: clip(m.content), now: clip(n.content), changedAt: m.valid_to, how: 'replaced' };
      }
      if (!item) {
        const v = yield* one<{ version: number; created_at: string }>(
          `SELECT version, created_at FROM memory_versions WHERE memory_id = ? AND user_id = ? AND change = 'update' AND created_by = ? ORDER BY version DESC LIMIT 1`, m.id, userId, userId);
        const before = v ? yield* one<{ content: string | null }>('SELECT content FROM memory_versions WHERE memory_id = ? AND user_id = ? AND version < ? ORDER BY version DESC LIMIT 1', m.id, userId, v.version) : undefined;
        if (v && before?.content != null) item = { memoryId: m.id, nowId: m.id, was: clip(before.content), now: clip(m.content), changedAt: v.created_at, how: 'edited' };
      }
      if (!item) continue;
      const cutoff = item.changedAt ?? new Date().toISOString();
      const total = yield* one<{ n: number }>('SELECT COUNT(*) AS n FROM memory_recall_uses WHERE user_id = ? AND memory_id = ? AND created_at < ?', userId, m.id, cutoff);
      const uses = yield* all<{ run_id: string; agent_id: string | null; created_at: string; session_id: string | null; title: string | null }>(
        `SELECT u.run_id, u.agent_id, u.created_at, t.session_id, ${titled ? 's.title' : 'NULL'} AS title
           FROM memory_recall_uses u
           LEFT JOIN memory_recall_traces t ON t.run_id = u.run_id AND t.user_id = u.user_id
           ${titled ? 'LEFT JOIN chat_sessions s ON s.id = t.session_id AND s.user_id = u.user_id' : ''}
          WHERE u.user_id = ? AND u.memory_id = ? AND u.created_at < ?
          ORDER BY u.created_at, u.run_id LIMIT 20`, userId, m.id, cutoff);
      out.push({
        ...item, drawer, checked: flags.includes(CHECKED_FLAG), replyCount: Number(total?.n) || uses.length,
        replies: uses.map((u) => ({ runId: u.run_id, sessionId: u.session_id ?? null, title: u.title ? clip(u.title, 200) : null, agentId: u.agent_id ?? null, at: u.created_at })),
      });
      if (out.length >= limit) break;
    }
    return out.sort((a, b) => Number(a.checked) - Number(b.checked));
  })());
}

/** Mark as checked (or, for Undo, not checked) one corrected-after-use memory. */
export async function setCorrectedChecked(userId: string, memoryId: string, checked: boolean): Promise<{ memoryId: string; checked: boolean }> {
  if (!(await ready())) throw notFound();
  await sql().tx(function* (): Step<void> {
    const t = yield* one<{ flags: string | null }>('SELECT flags FROM memory_trust WHERE memory_id = ? AND user_id = ?', memoryId, userId);
    const flags = parseFlags(t?.flags);
    if (!t || !flags.includes(CORRECTED_FLAG)) throw notFound();
    const next = checked ? [...new Set([...flags, CHECKED_FLAG])] : flags.filter((x) => x !== CHECKED_FLAG);
    yield* run('UPDATE memory_trust SET flags = ?, updated_at = ? WHERE memory_id = ? AND user_id = ?', JSON.stringify(next.slice(-10)), new Date().toISOString(), memoryId, userId);
  });
  return { memoryId, checked };
}

// ---------------------------------------------------------------- open questions

export interface OpenQuestion {
  id: string; question: string; agentId: string | null;
  status: 'open' | 'resolved' | 'expired';
  askedAt: string; resolvedAt: string | null; resolvedMemoryId: string | null;
  /** When an open question ends if nobody answers it. */
  endsAt: string;
}
const questionOf = (r: any): OpenQuestion => ({
  id: r.id, question: clip(r.question, 300), agentId: r.agent_id ?? null, status: r.status, askedAt: r.asked_at, resolvedAt: r.resolved_at ?? null,
  resolvedMemoryId: r.resolved_memory_id ?? null, endsAt: new Date(new Date(r.asked_at).getTime() + OPEN_QUESTION_DAYS * 86_400_000).toISOString(),
});

const selectedQuestionOf=(value:EncryptedOpenQuestion):OpenQuestion=>questionOf({id:value.id,question:value.question,agent_id:value.agentId,status:value.status,asked_at:value.askedAt,resolved_at:value.resolvedAt,resolved_memory_id:value.resolvedMemoryId});

/** The questions of the last QUESTION_KEEP_DAYS days: waiting first, then newest (questions past their time read "expired"). */
export async function openQuestions(userId: string): Promise<OpenQuestion[]> {
 const selected=selectedMemoryExecution();if(selected){const since=Date.now()-QUESTION_KEEP_DAYS*86400000,expired=Date.now()-OPEN_QUESTION_DAYS*86400000;return(await selected.questions(userId)).filter(row=>Date.parse(row.askedAt)>=since).sort((a,b)=>b.askedAt.localeCompare(a.askedAt)||a.id.localeCompare(b.id)).slice(0,200).map(row=>selectedQuestionOf(row.status==='open'&&Date.parse(row.askedAt)<expired?{...row,status:'expired'}:row)).sort((a,b)=>Number(a.status!=='open')-Number(b.status!=='open'));}
  if (!(await ready())) return [];
  const since = new Date(Date.now() - QUESTION_KEEP_DAYS * 86_400_000).toISOString();
  const expired = new Date(Date.now() - OPEN_QUESTION_DAYS * 86_400_000).toISOString();
  const rows = await sql().read(all<any>(
    'SELECT * FROM memory_open_questions WHERE user_id = ? AND asked_at >= ? ORDER BY asked_at DESC, id LIMIT 200', userId, since));
  return rows.map((r) => questionOf(r.status === 'open' && r.asked_at < expired ? { ...r, status: 'expired' } : r))
    .sort((a, b) => Number(a.status !== 'open') - Number(b.status !== 'open'));
}

async function question(userId: string, id: string): Promise<OpenQuestion> {
 const selected=selectedMemoryExecution();if(selected){const rows=await selected.questions(userId,id);if(rows.length!==1)throw notFound();return selectedQuestionOf(rows[0]);}
  const r = await sql().read(one<any>('SELECT * FROM memory_open_questions WHERE id = ? AND user_id = ?', id, userId));
  if (!r) throw notFound();
  return questionOf(r);
}

/** The answer was saved as memory `memoryId`: the question is resolved by it. */
export async function resolveQuestion(userId: string, id: string, memoryId: string): Promise<OpenQuestion> {
 const selected=selectedMemoryExecution();if(selected){const result=await selected.mutateQuestion(userId,id,'resolve',memoryId);if(!('question'in result))throw notFound();return selectedQuestionOf(result);}
  if (!(await ready())) throw notFound();
  const q = await question(userId, id);
  // Saving the answer may already have resolved it by its words (pipeline.ts): then it is resolved by the same memory.
  if (q.status === 'resolved' && q.resolvedMemoryId === memoryId) return q;
  if (q.status !== 'open') throw new TrustViewError('This question is not waiting any more', 409, 'not_open');
  await sql().read(run(`UPDATE memory_open_questions SET status = 'resolved', resolved_memory_id = ?, resolved_at = ? WHERE id = ? AND user_id = ?`, memoryId, new Date().toISOString(), id, userId));
  return question(userId, id);
}

/** An open question, or a TrustViewError (answering needs one that still waits). */
export async function waitingQuestion(userId: string, id: string): Promise<OpenQuestion> {
  if (!selectedMemoryExecution()&&!(await ready())) throw notFound();
  const q = await question(userId, id);
  if (q.status !== 'open' || q.endsAt < new Date().toISOString()) throw new TrustViewError('This question is not waiting any more', 409, 'not_open');
  return q;
}

const forgotten = new Map<string, { at: number; row: Record<string, unknown> }>();
const undoKey = (userId: string, id: string) => `${userId}\u0000${id}`;

/** Forget a question (no confirmation; Undo brings it back for UNDO_MS). */
export async function forgetQuestion(userId: string, id: string): Promise<{ id: string; undo: true }> {
 const selected=selectedMemoryExecution();if(selected){const result=await selected.mutateQuestion(userId,id,'delete');if(!('undo'in result))throw notFound();return result;}
  if (!(await ready())) throw notFound();
  const row = await sql().read(one<Record<string, unknown>>('SELECT * FROM memory_open_questions WHERE id = ? AND user_id = ?', id, userId));
  if (!row) throw notFound();
  await sql().read(run('DELETE FROM memory_open_questions WHERE id = ? AND user_id = ?', id, userId));
  const now = Date.now();
  for (const [k, v] of forgotten) if (now - v.at > UNDO_MS) forgotten.delete(k);
  forgotten.set(undoKey(userId, id), { at: now, row });
  return { id, undo: true };
}

/** Undo of forgetQuestion (within UNDO_MS, same account). */
export async function restoreQuestion(userId: string, id: string): Promise<OpenQuestion> {
 const selected=selectedMemoryExecution();if(selected){const result=await selected.mutateQuestion(userId,id,'restore');if(!('question'in result))throw notFound();return selectedQuestionOf(result);}
  if (!(await ready())) throw notFound();
  const k = undoKey(userId, id);
  const kept = forgotten.get(k);
  if (!kept || Date.now() - kept.at > UNDO_MS) { forgotten.delete(k); throw new TrustViewError('This can no longer be undone', 410, 'gone'); }
  const r = kept.row as any;
  await sql().read(run(`INSERT INTO memory_open_questions (id, user_id, agent_id, question_hash, question, status, resolved_memory_id, asked_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, r.id, r.user_id, r.agent_id ?? null, r.question_hash, r.question, r.status, r.resolved_memory_id ?? null, r.asked_at, r.resolved_at ?? null));
  forgotten.delete(k);
  return question(userId, id);
}

/** What waits for the owner (the Needs you badge): unchecked corrections and open questions. */
export async function trustWaiting(userId: string): Promise<{ corrected: number; questions: number }> {
  if (!(await ready())) return { corrected: 0, questions: 0 };
  const [c, q] = await Promise.all([correctedList(userId, 200), openQuestions(userId)]);
  return { corrected: c.filter((x) => !x.checked).length, questions: q.filter((x) => x.status === 'open').length };
}

/** The owner's answer as a lasting fact (like Remember with importance 8). */
export function answerDraft(text: string, drawer: { kind: string; key?: string }) {
  return {
    id: uuidv4(), type: 'fact', content: text, importance: 8, memoryLayer: 'factual', importanceScore: 0.8, consolidationStatus: 'pending',
    expiryTimestamp: null, status: 'active', metadata: { source: 'owner', answers: 'open-question' }, createdAt: new Date(), lastAccessedAt: Date.now(), accessCount: 0, drawer,
  };
}
