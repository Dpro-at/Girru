/**
 * HANDOFF-PERIOD-01: handoff notes grouped by when they were written — today, this week, this month,
 * this year, older.
 *
 * A project that has run for months has dozens of notes, and a flat newest-first list buries "what
 * happened this week" under "what happened in March". Grouping is done when the notes are read, so
 * nothing new is stored and no note is ever rewritten or condensed: every one stays exactly as its
 * agent left it. A note belongs to the NARROWEST group it fits, so each appears once.
 *
 * Pure, and in the reader's own time zone: a note written at 23:00 is "today" until midnight where the
 * owner is, not where a server is.
 */

export const HANDOFF_PERIODS = ['today', 'week', 'month', 'year', 'older'] as const;
export type HandoffPeriod = (typeof HANDOFF_PERIODS)[number];

export interface PeriodGroup<T> {
  period: HandoffPeriod;
  /** For a person to read: "Today", "Earlier this week", … */
  label: string;
  items: T[];
}

const LABELS: Record<HandoffPeriod, string> = {
  today: 'Today',
  week: 'Earlier this week',
  month: 'Earlier this month',
  year: 'Earlier this year',
  older: 'Older',
};

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** Monday, as the week starts in the owner's calendar. */
const startOfWeek = (d: Date): Date => {
  const day = startOfDay(d);
  const back = (day.getDay() + 6) % 7; // Sunday (0) is 6 days after Monday
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - back);
};
const startOfMonth = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), 1);
const startOfYear = (d: Date): Date => new Date(d.getFullYear(), 0, 1);

/** Which group a time belongs to, narrowest first. */
export function periodOf(at: Date | string, now: Date = new Date()): HandoffPeriod {
  const t = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(t.getTime())) return 'older'; // an unreadable date never claims to be recent
  if (t >= startOfDay(now)) return 'today';
  if (t >= startOfWeek(now)) return 'week';
  if (t >= startOfMonth(now)) return 'month';
  if (t >= startOfYear(now)) return 'year';
  return 'older';
}

/**
 * Group notes by when they were written, newest group first and newest note first inside it. Empty
 * groups are left out, and the notes themselves are untouched.
 */
export function groupByPeriod<T extends { createdAt: string | Date }>(items: readonly T[], now: Date = new Date()): Array<PeriodGroup<T>> {
  const by = new Map<HandoffPeriod, T[]>();
  for (const item of items) {
    const p = periodOf(item.createdAt, now);
    const list = by.get(p);
    if (list) list.push(item); else by.set(p, [item]);
  }
  const time = (x: T) => new Date(x.createdAt).getTime() || 0;
  return HANDOFF_PERIODS
    .filter((p) => by.has(p))
    .map((p) => ({ period: p, label: LABELS[p], items: by.get(p)!.sort((a, b) => time(b) - time(a)) }));
}

/** One line per group for a reply: "Today: 2 · Earlier this week: 5 · Older: 11". */
export const periodSummary = <T extends { createdAt: string | Date }>(items: readonly T[], now: Date = new Date()): string =>
  groupByPeriod(items, now).map((g) => `${g.label}: ${g.items.length}`).join(' · ');
