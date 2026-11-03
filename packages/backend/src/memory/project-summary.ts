/**
 * Periodic, versioned project summary (STORE-MAP-01 P9, M7).
 *
 * Retention summarises finished tasks only; a long project also needs a short
 * picture of itself, so the brief stays small while every detail stays
 * searchable. Once a week (memory job 'quality', GIRRU_STORE_P9 only) each
 * project drawer with at least MIN_MEMORIES current memories gets one summary
 * memory under the topic key PROJECT_SUMMARY_TOPIC:
 *
 *   how many memories, by type; its standing topics; the most important
 *   memories (one line each); what changed in the last CHANGE_DAYS days.
 *
 * Rule-based: no model, no network. The text is built from the drawer's own
 * memories, so it lives in the same drawer under the same access and
 * "Stays on this computer" rules. A new summary REPLACES the previous one
 * (valid_to + superseded_by; the old one stays in History), so every
 * version can be read back; nothing is written when nothing changed. The
 * summary is never a standing topic of every prompt (context/pack.ts skips
 * it); it is found by search and listed in the coding tools' topic index.
 */

import { createHash } from 'node:crypto';
import { all, sql } from '../repositories/sql-steps.js';
import { drawerId, drawerSqlFilter, type DrawerRef } from './drawers.js';
import { getMemoryStorage, listDrawersStep } from './storage.js';
import { NOT_REPLACED_SQL } from './validity.js';
import type { Memory } from './types.js';

export const PROJECT_SUMMARY_TOPIC = 'project-summary';
export const MIN_MEMORIES = 5;
export const CHANGE_DAYS = 30;
const MAX_IMPORTANT = 8;
const MAX_TOPICS = 12;
const LINE_CHARS = 160;
/** Characters of the whole summary. */
export const SUMMARY_CHARS = 2000;
const SUMMARY_IMPORTANCE = 5;
const ACTOR = 'system:project-summary';

interface Row { id: string; type: string; content: string; importance_score: number | null; topic_key: string | null; created_at: string }

const oneLine = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > LINE_CHARS ? `${t.slice(0, LINE_CHARS - 1)}…` : t;
};
const hashOf = (s: string) => createHash('sha256').update(s).digest('hex');

/** The summary body of one project drawer (no date line), or null below MIN_MEMORIES. */
export async function buildProjectSummary(userId: string, drawer: DrawerRef, now = new Date()): Promise<string | null> {
  const f = drawerSqlFilter([drawer]);
  const rows = await sql().read(all<Row>(`
    SELECT id, type, content, importance_score, topic_key, created_at FROM memories
     WHERE user_id = ? AND ${f.sql} AND COALESCE(status, 'active') = 'active' AND ${NOT_REPLACED_SQL}
       AND (expiry_timestamp IS NULL OR expiry_timestamp > ?) AND (topic_key IS NULL OR topic_key <> ?)
     ORDER BY importance_score DESC, created_at ASC, id ASC`,
    userId, ...f.params, now.getTime(), PROJECT_SUMMARY_TOPIC));
  if (rows.length < MIN_MEMORIES) return null;
  const since = new Date(now.getTime() - CHANGE_DAYS * 86_400_000).toISOString();
  const changes = await sql().read(all<{ change: string; n: number }>(`
    SELECT change, COUNT(*) AS n FROM memory_versions
     WHERE user_id = ? AND drawer_kind = ? AND drawer_key = ? AND created_at >= ? AND change IN ('create', 'update', 'delete')
       AND created_by <> ? GROUP BY change ORDER BY change`,
    userId, drawer.kind, drawer.key || '', since, ACTOR));
  const byType = new Map<string, number>();
  for (const r of rows) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
  const n = (c: string) => Number(changes.find((x) => x.change === c)?.n ?? 0);
  const topics = rows.filter((r) => r.topic_key).map((r) => r.topic_key!).sort().slice(0, MAX_TOPICS);
  const lines = [
    `${rows.length} memories: ${[...byType].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, c]) => `${t} ${c}`).join(', ')}.`,
    `Last ${CHANGE_DAYS} days: new ${n('create')}, changed ${n('update')}, deleted ${n('delete')}.`,
    ...(topics.length ? [`Standing topics: ${topics.join(', ')}.`] : []),
    'Most important:',
    ...rows.slice(0, MAX_IMPORTANT).map((r) => `- ${oneLine(r.content)}`),
  ];
  let text = '';
  for (const l of lines) {
    if (text.length + l.length + 1 > SUMMARY_CHARS) break;
    text += (text ? '\n' : '') + l;
  }
  return text;
}

export interface ProjectSummaryResult { drawer: string; memoryId: string; version: number; replaced: string | null }

/**
 * Write a new summary version for every project drawer whose picture changed.
 * Returns what was written (an unchanged drawer is left out).
 */
export async function runProjectSummaries(userId: string, now = new Date()): Promise<ProjectSummaryResult[]> {
  const storage = getMemoryStorage();
  const { newMemory, replaceVersioned, saveVersioned } = await import('./learning.js');
  const out: ProjectSummaryResult[] = [];
  const drawers = (await sql().read(listDrawersStep(userId))).filter((d) => d.kind === 'project' && d.key);
  for (const d of drawers) {
    const drawer: DrawerRef = { kind: 'project', key: d.key };
    const body = await buildProjectSummary(userId, drawer, now);
    if (!body) continue;
    const prev: Memory | null = await storage.getByTopicKey(userId, drawer, PROJECT_SUMMARY_TOPIC);
    const prevMeta = (prev?.metadata ?? {}) as Record<string, unknown>;
    const summaryHash = hashOf(body);
    if (prev && prevMeta.summaryHash === summaryHash) continue;
    const version = (typeof prevMeta.summaryVersion === 'number' ? prevMeta.summaryVersion : prev ? 1 : 0) + 1;
    const content = `Project summary (version ${version}, as of ${now.toISOString().slice(0, 10)})\n${body}`;
    const entry = { type: 'context', importance: SUMMARY_IMPORTANCE, content };
    const mem = newMemory(userId, drawer, entry, { source: 'system', kind: 'project-summary', summaryVersion: version, summaryHash }, PROJECT_SUMMARY_TOPIC);
    // Summaries do not expire like working memories: the next version replaces them.
    mem.expiryTimestamp = null;
    mem.memoryLayer = 'factual';
    if (prev) await replaceVersioned(prev, mem, ACTOR, 'project-summary');
    else await saveVersioned(mem, ACTOR, 'project-summary');
    out.push({ drawer: drawerId(drawer), memoryId: mem.id, version, replaced: prev?.id ?? null });
  }
  return out;
}

/** Every version of a project's summary, newest first (current and replaced). */
export async function projectSummaryVersions(userId: string, drawer: DrawerRef): Promise<Array<{ id: string; content: string; current: boolean; createdAt: string }>> {
  const f = drawerSqlFilter([drawer]);
  const rows = await sql().read(all<{ id: string; content: string; status: string | null; created_at: string }>(`
    SELECT id, content, status, created_at FROM memories WHERE user_id = ? AND ${f.sql} AND topic_key = ?
     ORDER BY created_at DESC, id DESC LIMIT 100`, userId, ...f.params, PROJECT_SUMMARY_TOPIC));
  return rows.map((r) => ({ id: r.id, content: r.content, current: (r.status ?? 'active') !== 'replaced', createdAt: r.created_at }));
}
