/**
 * Where the work stands (MEM-READ-01 MR6): Today, This week and This month for one
 * project, made from the handoffs its agents and coding apps left (done · left ·
 * next). No new writing for anyone and no model: the lines are joined as they
 * are (newest first, duplicates dropped). A period with no handoff makes no row.
 * Night work (MR9) can store a written summary later; this is the live one.
 */

import { all, one, sql } from '../repositories/sql-steps.js';
import { redactImportText } from './import/redact.js';
import { chatProjectKeyColumn } from './project-keys.js';

export type Period = 'today' | 'week' | 'month';
export interface PeriodSummary {
  period: Period; label: string; from: string; sessions: number; sources: string[];
  done: string[]; left: string[]; next: string[];
  handoffs: Array<{ from: string; at: string; done: string[]; left: string[]; next: string[] }>;
}

const CLIENTS: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', 'gemini-cli': 'Gemini CLI', cursor: 'Cursor', copilot: 'Copilot' };
const list = (v: unknown): string[] => { try { const a = JSON.parse(String(v ?? '[]')); return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string').map((x) => redactImportText(x).text.replace(/\s+/g, ' ').trim()).filter(Boolean) : []; } catch { return []; } };

/** Start of today, of this week (Monday) and of this month, in local time, as ISO. */
export function periodStarts(now = new Date()): Record<Period, Date> {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week = new Date(day); week.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return { today: day, week, month: new Date(now.getFullYear(), now.getMonth(), 1) };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ts = (s: string) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);

export async function projectSummaries(ownerId: string, slug: string, now = new Date()): Promise<PeriodSummary[]> {
  const starts = periodStarts(now);
  const since = starts.month < starts.week ? starts.month : starts.week; // a week can begin in the month before
  const sinceIso = since.toISOString().replace('T', ' ').slice(0, 19);
  const rows = await sql().read((function* () {
    // The chat project behind this memory project (its id is the key with P3, else the one with this slug).
    const chat = yield* one<{ id: string }>(`SELECT id FROM chat_projects WHERE user_id = ? AND ${chatProjectKeyColumn()} = ?`, ownerId, slug);
    const projectId = chat?.id ?? slug;
    const own = yield* all<{ at: string; who: string | null; agent: string; done: string; remaining: string; next_steps: string }>(
      `SELECT h.created_at AS at, a.name AS who, h.agent_id AS agent, h.done, h.remaining, h.next_steps FROM agent_handoffs h LEFT JOIN agents_config a ON a.id = h.agent_id
        WHERE h.owner_id = ? AND h.project_id = ? AND h.created_at >= ? ORDER BY h.created_at DESC LIMIT 500`, ownerId, projectId, sinceIso);
    let apps: Array<{ at: string; client: string; done: string; remaining: string; next_steps: string }> = [];
    try {
      apps = yield* all(`SELECT created_at AS at, client, done, remaining, next_steps FROM memory_bridge_handoffs WHERE owner_id = ? AND project_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 500`, ownerId, projectId, sinceIso);
    } catch { apps = []; }
    return [...own.map((r) => ({ at: r.at, from: r.who || r.agent, done: r.done, remaining: r.remaining, next_steps: r.next_steps })),
      ...apps.map((r) => ({ at: r.at, from: CLIENTS[r.client] ?? r.client, done: r.done, remaining: r.remaining, next_steps: r.next_steps }))]
      .sort((a, b) => ts(b.at) - ts(a.at));
  })());
  const out: PeriodSummary[] = [];
  const label: Record<Period, string> = { today: 'Today', week: 'This week', month: MONTHS[now.getMonth()] };
  for (const period of ['today', 'week', 'month'] as Period[]) {
    const inside = rows.filter((r) => ts(r.at) >= starts[period].getTime() && ts(r.at) <= now.getTime() + 60_000);
    if (!inside.length) continue;
    const uniq = (pick: (r: typeof inside[number]) => string[], max: number) => [...new Set(inside.flatMap(pick))].slice(0, max);
    out.push({
      period, label: label[period], from: starts[period].toISOString(), sessions: inside.length,
      sources: [...new Set(inside.map((r) => r.from))].slice(0, 6),
      done: uniq((r) => list(r.done), 6), left: uniq((r) => list(r.remaining), 4), next: uniq((r) => list(r.next_steps), 4),
      handoffs: inside.slice(0, 20).map((r) => ({ from: r.from, at: r.at, done: list(r.done), left: list(r.remaining), next: list(r.next_steps) })),
    });
  }
  // A month row that only repeats this week adds nothing.
  const week = out.find((s) => s.period === 'week'), month = out.find((s) => s.period === 'month');
  if (week && month && week.sessions === month.sessions) out.splice(out.indexOf(month), 1);
  const today = out.find((s) => s.period === 'today');
  if (today && week && today.sessions === week.sessions) out.splice(out.indexOf(week), 1);
  return out;
}

/** The same for agents: "Where the work stands" lines for project_brief / latest_handoff. */
export function summariesText(list: PeriodSummary[]): string {
  if (!list.length) return '';
  const lines = ['### Where the work stands'];
  for (const s of list) {
    const parts = [s.done.length && `Done: ${s.done.slice(0, 3).join('; ')}.`, s.left.length && `Left: ${s.left.slice(0, 2).join('; ')}.`, s.next.length && `Next: ${s.next.slice(0, 2).join('; ')}.`].filter(Boolean);
    lines.push(`- ${s.label} (${s.sessions} session${s.sessions === 1 ? '' : 's'} · ${s.sources.join(', ')}): ${parts.join(' ') || 'work without notes.'}`);
  }
  return lines.join('\n');
}
