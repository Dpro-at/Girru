/**
 * Weekly "what I learned" summary (CORE-05).
 *
 * A deterministic digest per drawer from the version history of the last
 * 7 days: memories in the drawer now, new / changed / deleted items with a
 * short preview, and proposals waiting for review. Stored per user in
 * `memory_weekly_summaries` and read through GET /api/memory/weekly-summary.
 *
 * No paid calls. A local model (Ollama, through `src/llm/model-call.ts`) only rewrites
 * the digest as prose when MEMORY_SUMMARY_MODEL=ollama is set (or a
 * summarizer is passed in, as tests do); without it, or when the model
 * fails, the deterministic text is the summary.
 */

import { all, one, run, sql } from '../repositories/sql-steps.js';
import { orderedId } from '../repositories/ordered-id.js';
import { listDrawersStep } from './storage.js';
import { drawerId, normalizeDrawer, type DrawerRef } from './drawers.js';
import { modelCall } from '../llm/model-call.js';

export const SUMMARY_DAYS = 7;
const MAX_ITEMS_PER_DRAWER = 20;
const PREVIEW = 120;

export interface DigestItem { memoryId: string; change: 'create' | 'update' | 'delete'; preview: string | null; at: string }
export interface DrawerDigest {
  drawerId: string;
  total: number;
  created: number;
  updated: number;
  deleted: number;
  /** Forgotten completely (CORE-07): counted, never shown. */
  forgotten: number;
  pending: number;
  items: DigestItem[];
}
export interface WeeklyDigest {
  userId: string;
  periodStart: string;
  periodEnd: string;
  drawers: DrawerDigest[];
  totals: { total: number; created: number; updated: number; deleted: number; forgotten: number; pending: number };
}

export type Summarizer = (digestText: string) => Promise<{ text: string; model: string } | null>;

function preview(s: string | null | undefined): string | null {
  if (typeof s !== 'string') return null;
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > PREVIEW ? `${one.slice(0, PREVIEW)}...` : one;
}

function drawerOf(kind: string, key: string): DrawerRef | null {
  try { return normalizeDrawer(key ? { kind, key } : { kind }); } catch { return null; }
}

/** Build the digest for one user (no writes). */
export interface WeeklyDigestInputRows {
 drawers:ReadonlyArray<DrawerRef & {count:number}>;
 rows:ReadonlyArray<{memory_id:string;drawer_kind:string;drawer_key:string;change:'create'|'update'|'delete'|'forget';created_at:string;current:string|null}>;
 pending:ReadonlyArray<{drawer_kind:string;drawer_key:string;n:number}>;
}
export async function buildWeeklyDigest(userId:string,now=new Date(),days=SUMMARY_DAYS):Promise<WeeklyDigest>{
 const end=now.toISOString(),start=new Date(now.getTime()-days*24*60*60*1000).toISOString();
 const drawers=await sql().read(listDrawersStep(userId));
  const rows = await sql().read(all<{ memory_id: string; drawer_kind: string; drawer_key: string; change: 'create' | 'update' | 'delete' | 'forget'; created_at: string; current: string | null }>(`
    SELECT v.memory_id, v.drawer_kind, v.drawer_key, v.change, v.created_at, m.content AS current
      FROM memory_versions v LEFT JOIN memories m ON m.id = v.memory_id AND m.user_id = v.user_id
     WHERE v.user_id = ? AND v.created_at >= ? AND v.created_at <= ? AND v.change IN ('create', 'update', 'delete', 'forget')
     ORDER BY v.created_at ASC, v.memory_id, v.version
  `, userId, start, end));
  const pending = await sql().read(all<{ drawer_kind: string; drawer_key: string; n: number }>(`
    SELECT drawer_kind, drawer_key, COUNT(*) AS n FROM memory_file_proposals
     WHERE user_id = ? AND status = 'pending' GROUP BY 1, 2
  `, userId));
 return buildWeeklyDigestFromRows(userId,now,days,{drawers,rows,pending});
}
export function buildWeeklyDigestFromRows(userId:string,now:Date,days:number,data:WeeklyDigestInputRows):WeeklyDigest {
  const end = now.toISOString();
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const byDrawer = new Map<string, DrawerDigest>();
  const get = (d: DrawerRef) => {
    const id = drawerId(d);
    let entry = byDrawer.get(id);
    if (!entry) { entry = { drawerId: id, total: 0, created: 0, updated: 0, deleted: 0, forgotten: 0, pending: 0, items: [] }; byDrawer.set(id, entry); }
    return entry;
  };

  for (const d of data.drawers) {
    get(d.key ? { kind: d.kind, key: d.key } : { kind: d.kind }).total = d.count;
  }

  const rows=data.rows;
  for (const r of rows) {
    const d = drawerOf(r.drawer_kind, r.drawer_key);
    if (!d) continue;
    const e = get(d);
    if (r.change === 'forget') { e.forgotten++; e.items = e.items.filter((i) => i.memoryId !== r.memory_id); continue; }
    if (r.change === 'create') e.created++;
    else if (r.change === 'update') e.updated++;
    else e.deleted++;
    // One line per memory: its latest change. Deleted items show no text.
    e.items = e.items.filter((i) => i.memoryId !== r.memory_id);
    e.items.push({ memoryId: r.memory_id, change: r.change, preview: r.change === 'delete' ? null : preview(r.current), at: r.created_at });
  }

  const pending=data.pending;
  for (const p of pending) {
    const d = drawerOf(p.drawer_kind, p.drawer_key);
    if (d) get(d).pending = p.n;
  }

  const drawers = [...byDrawer.values()]
    .map((d) => ({ ...d, items: d.items.slice(-MAX_ITEMS_PER_DRAWER) }))
    .sort((a, b) => a.drawerId.localeCompare(b.drawerId));
  const totals = drawers.reduce((t, d) => ({
    total: t.total + d.total, created: t.created + d.created, updated: t.updated + d.updated,
    deleted: t.deleted + d.deleted, forgotten: t.forgotten + d.forgotten, pending: t.pending + d.pending,
  }), { total: 0, created: 0, updated: 0, deleted: 0, forgotten: 0, pending: 0 });
  return { userId, periodStart: start, periodEnd: end, drawers, totals };
}

/** Readable digest text (deterministic). */
export function renderDigest(d: WeeklyDigest): string {
  const lines = [
    `What I learned this week (${d.periodStart.slice(0, 10)} to ${d.periodEnd.slice(0, 10)})`,
    `New ${d.totals.created}, changed ${d.totals.updated}, deleted ${d.totals.deleted}, forgotten ${d.totals.forgotten ?? 0}; ${d.totals.pending} waiting for your approval; ${d.totals.total} memories in total.`,
  ];
  for (const dr of d.drawers) {
    if (!dr.created && !dr.updated && !dr.deleted && !dr.forgotten && !dr.pending) continue;
    lines.push('', `## ${dr.drawerId}: ${dr.total} memories; new ${dr.created}, changed ${dr.updated}, deleted ${dr.deleted}, forgotten ${dr.forgotten ?? 0}, waiting ${dr.pending}`);
    for (const i of dr.items) {
      const label = i.change === 'create' ? 'new' : i.change === 'update' ? 'changed' : 'deleted';
      lines.push(`- ${label}: ${i.preview ?? '(removed)'}`);
    }
  }
  return lines.join('\n');
}

/**
 * Local summarizer (only used when MEMORY_SUMMARY_MODEL=ollama). R2.2: a
 * background call, so it goes through the model-call choke point (local
 * model only: no paid model provider is configured for this purpose).
 */
export const ollamaSummarizer: Summarizer = async (digestText) => {
  const r = await modelCall({ actor: 'weekly-summary' }, {
    purpose: 'weekly_summary',
    prompt: `Rewrite this weekly memory digest as a short, friendly summary for the owner. Keep every number. Do not add facts.\n\n${digestText}`,
    timeoutMs: 120_000,
  });
  const text = r.ok ? r.text.trim() : '';
  return text ? { text: text.slice(0, 20_000), model: `${r.provider}:${r.model}` } : null;
};

function configuredSummarizer(): Summarizer | null {
  return (process.env.MEMORY_SUMMARY_MODEL || '').trim().toLowerCase() === 'ollama' ? ollamaSummarizer : null;
}

export interface WeeklySummaryRecord {
  id: string;
  userId: string;
  periodStart: string;
  periodEnd: string;
  digest: WeeklyDigest;
  text: string;
  modelText: string | null;
  model: string | null;
  createdBy: string;
  createdAt: string;
}

function rowToRecord(row: any): WeeklySummaryRecord {
  return {
    id: row.id, userId: row.user_id, periodStart: row.period_start, periodEnd: row.period_end,
    digest: JSON.parse(row.digest), text: row.text, modelText: row.model_text ?? null, model: row.model ?? null,
    createdBy: row.created_by, createdAt: row.created_at,
  };
}

/** Build, (optionally) summarize and store this week's summary for a user. */
export async function runWeeklySummary(userId: string, opts: { now?: Date; summarizer?: Summarizer | null; actor?: string } = {}): Promise<WeeklySummaryRecord> {
  const digest = await buildWeeklyDigest(userId, opts.now ?? new Date());
  const text = renderDigest(digest);
  const summarizer = opts.summarizer === undefined ? configuredSummarizer() : opts.summarizer;
  let model: { text: string; model: string } | null = null;
  if (summarizer) {
    try { model = await summarizer(text); } catch { model = null; }
  }
  // Time-ordered id: it breaks created_at ties (was rowid) on both drivers.
  const id = orderedId();
  await sql().read(run(`
    INSERT INTO memory_weekly_summaries (id, user_id, period_start, period_end, digest, text, model_text, model, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, id, userId, digest.periodStart, digest.periodEnd, JSON.stringify(digest), text, model?.text ?? null, model?.model ?? null, opts.actor ?? 'scheduler'));
  return (await latestWeeklySummary(userId))!;
}

export async function latestWeeklySummary(userId: string): Promise<WeeklySummaryRecord | null> {
  const row = await sql().read(one(
    'SELECT * FROM memory_weekly_summaries WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', userId));
  return row ? rowToRecord(row) : null;
}

export async function listWeeklySummaries(userId: string, limit = 12): Promise<WeeklySummaryRecord[]> {
  return (await sql().read(all(
    'SELECT * FROM memory_weekly_summaries WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', userId, Math.max(1, Math.min(52, limit)))))
    .map(rowToRecord);
}
