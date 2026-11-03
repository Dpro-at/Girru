/**
 * TASKLOG-01: the format of a project's task file (.girru/tasks.md).
 *
 *   ## T-7 · Fix the sign-in timeout
 *   - State: In progress
 *   - Department: Development
 *   - Agent: Backend Lead
 *   - Priority: High
 *   - Worked on by: Claude Code 2026-10-29, Codex 2026-10-29
 *   ### Done
 *   - one line per item
 *   ### Left
 *   ### Next
 *   ### Log
 *   - 2026-10-29 15:40 · Codex · test added
 *
 * One `##` block per task. Text before the first block is the file's own and is
 * never changed. A block that breaks the format is reported with its line and is
 * left as it is. Writing replaces one block and keeps the rest byte for byte.
 * Pure functions, no file access (services/task-file.ts reads and writes).
 */

export const TASK_HEADER = '# Tasks\n\n<!-- girru:tasks · one file for every agent and app working in this project. Keep this format: one "## T-<number> · <title>" block per task. Finished tasks move to tasks-done.md. -->\n';
export const DONE_HEADER = '# Finished tasks\n\n<!-- girru:tasks-done · tasks moved here from tasks.md when they were done. Nobody needs to read this file unless asked. -->\n';
export const MAX_FILE = 256 * 1024;
export const MAX_TITLE = 200;
export const MAX_ITEM = 300;
export const MAX_ITEMS = 30;
/** How many Log lines the board shows (the file keeps them all; Girru never drops an agent's line). */
export const SHOW_LOG = 5;

export type Part = 'done' | 'left' | 'next' | 'log';
export interface WorkedOn { app: string; date: string }
export interface TaskBlock {
  no: string; title: string; state: string; department: string; agent: string; priority: string;
  workedOn: WorkedOn[]; done: string[]; left: string[]; next: string[]; log: string[];
}
/**
 * STORE-MAP-01 P6: Girru's hidden line under a task heading,
 *   <!-- girru:id=<card id> v=<card version> -->
 * names the board card (T5: a renamed or renumbered task keeps its card) and
 * the version the block was written from (version stamp). Kept outside
 * TaskBlock, so the stored copy of a task is the same with or without it.
 */
export interface ReadTask { task: TaskBlock; start: number; end: number; line: number; problem: string | null; id?: string | null; v?: number | null; idAt?: { start: number; end: number } | null }
export interface Stamp { id: string; v: number }
const HIDDEN = /^<!--\s*girru:id=([A-Za-z0-9_-]{1,64})(?:\s+v=(\d{1,9}))?\s*-->$/;
export const stampLine = (s: Stamp) => `<!-- girru:id=${s.id} v=${s.v} -->`;
export interface FileProblem { no: string | null; line: number; message: string }
export interface ReadFile { tasks: ReadTask[]; problems: FileProblem[] }

const HEAD = /^##\s+(T-(\d{1,6}))\s*[·:\-–—]\s*(\S.*?)\s*$/;
const FIELDS: Record<string, 'state' | 'department' | 'agent' | 'priority' | 'workedOn'> = { state: 'state', department: 'department', agent: 'agent', priority: 'priority', 'worked on by': 'workedOn' };
const PARTS: Record<string, Part> = { done: 'done', left: 'left', next: 'next', log: 'log' };
// eslint-disable-next-line no-control-regex
const oneLine = (s: string, max: number) => s.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
export const emptyTask = (no: string, title: string): TaskBlock => ({ no, title, state: '', department: '', agent: '', priority: '', workedOn: [], done: [], left: [], next: [], log: [] });
export const taskNumber = (no: string) => Number(no.slice(2));

/** "Claude Code 2026-10-29, Codex 2026-10-29" (a date is optional). */
export function readWorkedOn(v: string): WorkedOn[] {
  const out: WorkedOn[] = [];
  for (const part of v.split(',')) {
    const m = part.trim().match(/^(.*?)(?:\s+(\d{4}-\d{2}-\d{2}))?$/);
    const app = oneLine(m?.[1] ?? '', 40);
    if (app && !out.some((w) => w.app.toLowerCase() === app.toLowerCase())) out.push({ app, date: m?.[2] ?? '' });
    if (out.length >= 10) break;
  }
  return out;
}

/** Every block in the file, with where it starts and ends (offsets into the text) and what is wrong with it. */
export function readTasks(text: string): ReadFile {
  const tasks: ReadTask[] = [], problems: FileProblem[] = [];
  const lines = text.split('\n');
  let offset = 0, cur: ReadTask | null = null, part: Part | null = null;
  const close = (end: number) => { if (cur) { cur.end = end; tasks.push(cur); cur = null; } };
  const flag = (line: number, message: string) => {
    if (cur) { cur.problem ??= `Line ${line}: ${message}`; } else problems.push({ no: null, line, message });
  };
  for (const [i, raw] of lines.entries()) {
    const n = i + 1, l = raw.replace(/\r$/, ''), start = offset;
    offset += raw.length + 1;
    if (/^##(?!#)/.test(l)) {
      close(start);
      part = null;
      const m = l.match(HEAD);
      if (!m) { problems.push({ no: null, line: n, message: 'A task heading needs a number and a title: "## T-1 · Title"' }); continue; }
      cur = { task: emptyTask(`T-${Number(m[2])}`, oneLine(m[3], MAX_TITLE)), start, end: start, line: n, problem: null };
      if (tasks.some((t) => t.task.no === cur!.task.no)) cur.problem = `Line ${n}: the number ${cur.task.no} is used twice`;
      continue;
    }
    if (!cur) continue; // the file's own text before the first task
    const c: ReadTask = cur;
    if (!l.trim()) continue;
    const hidden = l.trim().match(HIDDEN);
    if (hidden) {
      if (c.idAt) flag(n, 'a task has one hidden Girru id line, not two');
      else { c.id = hidden[1]; c.v = hidden[2] ? Number(hidden[2]) : null; c.idAt = { start, end: start + raw.length + 1 }; }
      continue;
    }
    const sub = l.match(/^###\s+(.+?)\s*$/);
    if (sub) {
      const p = PARTS[sub[1].toLowerCase()];
      if (!p) flag(n, `"${oneLine(sub[1], 40)}" is not a part of a task (Done, Left, Next, Log)`);
      part = p ?? null;
      continue;
    }
    const item = l.match(/^\s*[-*]\s+(.*)$/);
    if (!item) { flag(n, 'this line is not in the task format'); continue; }
    if (part) {
      const list = c.task[part];
      if (list.length < (part === 'log' ? 200 : MAX_ITEMS)) { const v = oneLine(item[1], MAX_ITEM); if (v) list.push(v); }
      continue;
    }
    const field = item[1].match(/^([A-Za-z ]+?)\s*:\s*(.*)$/);
    const key = field ? FIELDS[field[1].trim().toLowerCase()] : undefined;
    if (!field || !key) { flag(n, 'a task line needs a known name: State, Department, Agent, Priority or Worked on by'); continue; }
    if (key === 'workedOn') c.task.workedOn = readWorkedOn(field[2]);
    else c.task[key] = oneLine(field[2], key === 'state' ? 40 : 120);
  }
  close(text.length);
  return { tasks, problems };
}

/**
 * P6: the file with Girru's hidden line set on every task that has a stamp
 * (added under the heading, or replaced in place); nothing else changes.
 */
export function stampTasks(text: string, stamps: ReadonlyMap<string, Stamp>): string {
  const tasks = readTasks(text).tasks.filter((t) => stamps.has(t.task.no)).sort((a, b) => b.start - a.start);
  let out = text;
  for (const t of tasks) {
    const line = `${stampLine(stamps.get(t.task.no)!)}\n`;
    if (t.idAt) { if (out.slice(t.idAt.start, t.idAt.end) !== line) out = out.slice(0, t.idAt.start) + line + out.slice(t.idAt.end); continue; }
    const eol = out.indexOf('\n', t.start);
    const at = eol < 0 ? out.length : eol + 1;
    out = out.slice(0, at) + (eol < 0 ? '\n' : '') + line + out.slice(at);
  }
  return out;
}

/** One block as Girru writes it (sections always present, so every app knows where to write). */
export function writeTask(t: TaskBlock): string {
  const items = (list: string[]) => list.map((x) => `- ${oneLine(x, MAX_ITEM)}`).filter((x) => x !== '- ').join('\n');
  const worked = t.workedOn.map((w) => (w.date ? `${w.app} ${w.date}` : w.app)).join(', ');
  return [
    `## ${t.no} · ${oneLine(t.title, MAX_TITLE)}`,
    `- State: ${oneLine(t.state, 40)}`,
    `- Department: ${oneLine(t.department, 120)}`,
    `- Agent: ${oneLine(t.agent, 120)}`,
    `- Priority: ${oneLine(t.priority, 40)}`,
    `- Worked on by: ${worked}`,
    '### Done', items(t.done), '### Left', items(t.left), '### Next', items(t.next), '### Log', items(t.log),
  ].filter((x) => x !== '').join('\n') + '\n';
}

/** The file with one block replaced (by number) or added at the end; nothing else changes. */
export function withTask(text: string, t: TaskBlock): string {
  const base = text.trim() ? text : TASK_HEADER;
  const found = readTasks(base).tasks.find((x) => x.task.no === t.no);
  if (found) return base.slice(0, found.start) + writeTask(t) + (found.end < base.length ? '\n' : '') + base.slice(found.end).replace(/^\n+/, '');
  return `${base.replace(/\s*$/, '')}\n\n${writeTask(t)}`;
}
/** The file without one block (it moved to tasks-done.md). */
export function withoutTask(text: string, no: string): string {
  const found = readTasks(text).tasks.find((x) => x.task.no === no);
  if (!found) return text;
  const before = text.slice(0, found.start).replace(/\n+$/, '\n'), after = text.slice(found.end).replace(/^\n+/, '');
  return after ? `${before}\n${after}` : before;
}
/** A finished task (and log lines no longer kept in tasks.md) added to tasks-done.md. */
export function withDone(text: string, t: TaskBlock): string {
  const base = text.trim() ? text : DONE_HEADER;
  return `${base.replace(/\s*$/, '')}\n\n${writeTask(t)}`;
}
/** "2026-10-29 15:40 · Codex · test added" */
export interface LogLine { at: string; app: string; what: string }
export function readLog(line: string): LogLine | null {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?)\s*[·|-]\s*([^·|]{1,40}?)\s*[·|-]\s*(.+)$/);
  return m ? { at: m[1], app: m[2].trim(), what: m[3].trim() } : null;
}
export const logLine = (at: Date, app: string, what: string) => `${at.toISOString().slice(0, 16).replace('T', ' ')} · ${oneLine(app, 40)} · ${oneLine(what, MAX_ITEM - 40)}`;
/** The next free number: one more than the highest in either file or already linked. */
export function nextNumber(...used: Array<readonly string[]>): string {
  let max = 0;
  for (const list of used) for (const no of list) { const n = taskNumber(no); if (Number.isInteger(n) && n > max) max = n; }
  return `T-${max + 1}`;
}

const PRIORITY: Record<string, 'low' | 'normal' | 'high' | 'urgent'> = { low: 'low', normal: 'normal', medium: 'normal', high: 'high', urgent: 'urgent' };
export const priorityOf = (v: string) => PRIORITY[v.trim().toLowerCase()];
export const priorityName = (p: string) => (p ? p[0].toUpperCase() + p.slice(1) : '');
/** Same task, same meaning (the stored copy and the file's copy). */
export const sameTask = (a: TaskBlock, b: TaskBlock) => JSON.stringify(a) === JSON.stringify(b);
