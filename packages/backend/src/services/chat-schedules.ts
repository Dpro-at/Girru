import {reportCalendar,nextReportOccurrence,type ReportCadence} from './report-calendar.js';
/**
 * Chats that run on a schedule (CHAT-BUILD-01 stage 4, CH8 Place › Schedule).
 * One schedule per chat: at the chosen time the owner's saved message is sent
 * to the chat again, exactly as if the owner had typed it (same owner gates,
 * same Mode). Runs only while the background is on (AGENT_PLAYER_BACKGROUND),
 * once a minute; a chat that is still answering is tried at the next tick.
 */
import { q } from '../repositories/sql-steps.js';

export type Every = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly';
export interface ChatSchedule { calendar?:ReportCadence; every: Every; at: string; weekday: number | null; message: string; paused: boolean; nextRun: string; lastRun: string | null }
interface Row { calendar_json?:string|null; session_id: string; user_id: string; every: Every; at_time: string; weekday: number | null; message: string; paused: number; next_run: string; last_run: string | null }

export class ScheduleInputError extends Error {}
export const SCHEDULE_MESSAGE_CHARS = 4000;
const AT = /^([01]\d|2[0-3]):([0-5]\d)$/;

const toSchedule = (r: Row): ChatSchedule => ({ every: r.every, at: r.at_time, weekday: r.weekday ?? null, message: r.message, paused: !!r.paused, nextRun: r.next_run, lastRun: r.last_run,...(r.calendar_json?{calendar:reportCalendar(JSON.parse(r.calendar_json))}:{}) });

/** The next run after `from` (local time of this computer). */
export function nextRun(every: Every, at: string, weekday: number | null, from: Date = new Date()): Date {
  if(every==='monthly'||every==='yearly')throw new ScheduleInputError('Calendar and timezone required');
  const [h, m] = at.split(':').map(Number);
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  if (every === 'hourly') {
    t.setMinutes(m);
    if (t <= from) t.setHours(t.getHours() + 1);
    return t;
  }
  t.setHours(h, m, 0, 0);
  if (every === 'daily') { if (t <= from) t.setDate(t.getDate() + 1); return t; }
  const add = ((weekday ?? 0) - t.getDay() + 7) % 7;
  t.setDate(t.getDate() + add);
  if (t <= from) t.setDate(t.getDate() + 7);
  return t;
}

export function checkSchedule(input: unknown): { every: Every; at: string; weekday: number | null; message: string; paused: boolean; calendar?:ReportCadence } {
  const v = input as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some((k) => !['every', 'at', 'weekday', 'message', 'paused','calendar'].includes(k))) throw new ScheduleInputError('A schedule is { every, at, weekday?, message, paused? }');
  if (!['hourly', 'daily', 'weekly','monthly','yearly'].includes(String(v.every))) throw new ScheduleInputError('every must be hourly, daily or weekly');
  if (typeof v.at !== 'string' || !AT.test(v.at)) throw new ScheduleInputError('at must be a time like 09:00');
  const weekday = v.every === 'weekly' ? Number(v.weekday) : null;
  if (v.every === 'weekly' && !(Number.isInteger(weekday) && weekday! >= 0 && weekday! <= 6)) throw new ScheduleInputError('weekday must be 0 (Sunday) to 6');
  if (typeof v.message !== 'string' || !v.message.trim() || v.message.length > SCHEDULE_MESSAGE_CHARS) throw new ScheduleInputError(`The message is 1-${SCHEDULE_MESSAGE_CHARS} characters`);
  if (v.paused !== undefined && typeof v.paused !== 'boolean') throw new ScheduleInputError('paused must be true or false');
  let calendar:ReportCadence|undefined;try{if(v.calendar!==undefined)calendar=reportCalendar(v.calendar);}catch{throw new ScheduleInputError('Invalid calendar');}
  if(calendar&&(calendar.every!==v.every||calendar.at!==v.at||(calendar.weekday??null)!==weekday)||!calendar&&['monthly','yearly'].includes(String(v.every)))throw new ScheduleInputError('Calendar mismatch');
  return { every: v.every as Every, at: v.at, weekday, message: v.message.trim(), paused: v.paused === true,...(calendar?{calendar}:{}) };
}

export async function getSchedule(userId: string, sessionId: string): Promise<ChatSchedule | null> {
  const r = await q.one<Row>('SELECT * FROM chat_schedules WHERE session_id = ? AND user_id = ?', sessionId, userId);
  return r ? toSchedule(r) : null;
}

/** Schedules of the user's chats, for the sidebar (next run per chat). */
export async function schedulesByChat(userId: string): Promise<Map<string, ChatSchedule>> {
  const rows = await q.all<Row>('SELECT * FROM chat_schedules WHERE user_id = ?', userId).catch(() => [] as Row[]);
  return new Map(rows.map((r) => [r.session_id, toSchedule(r)]));
}

export async function setSchedule(userId: string, sessionId: string, input: unknown, now: Date = new Date()): Promise<ChatSchedule> {
  if(await q.one('SELECT id FROM display_reports WHERE owner_id=? AND session_id=?',userId,sessionId))throw new ScheduleInputError('Manage this schedule in Reports');
  const s = checkSchedule(input);
  const next = (s.calendar?nextReportOccurrence(s.calendar,now):nextRun(s.every,s.at,s.weekday,now)).toISOString();
  await q.run(`INSERT INTO chat_schedules (session_id, user_id, every, at_time, weekday, message, paused, next_run, calendar_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (session_id) DO UPDATE SET every = excluded.every, at_time = excluded.at_time, weekday = excluded.weekday, message = excluded.message, paused = excluded.paused, next_run = excluded.next_run, calendar_json=excluded.calendar_json, updated_at = CURRENT_TIMESTAMP`,
    sessionId, userId, s.every, s.at, s.weekday, s.message, s.paused ? 1 : 0, next, s.calendar?JSON.stringify(s.calendar):null);
  return (await getSchedule(userId, sessionId))!;
}

export async function deleteSchedule(userId: string, sessionId: string): Promise<boolean> {
  if(await q.one('SELECT id FROM display_reports WHERE owner_id=? AND session_id=?',userId,sessionId))throw new ScheduleInputError('Manage this schedule in Reports');
  return (await q.run('DELETE FROM chat_schedules WHERE session_id = ? AND user_id = ?', sessionId, userId)).changes > 0;
}

/**
 * One tick: every due, unpaused schedule sends its message through `send`.
 * The next run is set before sending, so a failed or busy send never repeats in a loop.
 */
export async function runDueSchedules(send: (userId: string, sessionId: string, message: string, runKey: string) => Promise<boolean>, now: Date = new Date()): Promise<number> {
  const due = await q.all<Row>('SELECT * FROM chat_schedules WHERE paused = 0 AND next_run <= ?', now.toISOString());
  let sent = 0;
  for (const r of due) {
    let next:string;
    try{next=(r.calendar_json?nextReportOccurrence(reportCalendar(JSON.parse(r.calendar_json)),now):nextRun(r.every,r.at_time,r.weekday,now)).toISOString();}
    catch{await q.run("UPDATE chat_schedules SET paused=1,last_result='failed',last_reason='invalid_calendar' WHERE session_id=? AND next_run=?",r.session_id,r.next_run);continue;}
    const claimed = await q.run('UPDATE chat_schedules SET next_run = ?, last_run = ? WHERE session_id = ? AND next_run = ? AND paused=0', next, now.toISOString(), r.session_id, r.next_run);
    if (!claimed.changes) continue;
    // RUNS-01: each fire records its result, so Runs can say why a time was skipped and open the run it made.
    const runKey = `schedule-${r.session_id.slice(0, 36)}-${now.getTime()}`;
    let result: ['started' | 'skipped' | 'failed', string | null, string | null] = ['skipped', 'busy', null];
    try { if (await send(r.user_id, r.session_id, r.message, runKey)) { sent++; result = ['started', null, runKey.slice(0, 128)]; } }
    catch (err) { result = ['failed', 'error', null]; console.warn('[ChatSchedules] could not send', { sessionId: r.session_id, name: (err as Error)?.name ?? 'Error' }); }
    await q.run('UPDATE chat_schedules SET last_result = ?, last_reason = ?, last_run_id = ? WHERE session_id = ?', ...result, r.session_id).catch(() => undefined);
  }
  return sent;
}
