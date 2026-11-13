// HANDOFF-PERIOD-01: handoff notes grouped by when they were written (memory/handoff/periods.ts).
//  - a note belongs to the narrowest group it fits, so it appears once;
//  - the boundaries are the owner's own calendar: midnight, Monday, the 1st, 1 January;
//  - empty groups are left out, newest group and newest note first, and no note is changed.
// Pure: no database, no clock of its own (`now` is passed in).
// Run: node --import tsx --test test/handoff-periods.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.JWT_SECRET ||= 'x'.repeat(64);
const { groupByPeriod, periodOf, periodSummary, HANDOFF_PERIODS } = await import(pathToFileURL(join(process.cwd(), 'src/memory/handoff/periods.ts')).href);

// A Wednesday, 13:00 local time. The week runs from Monday the 12th.
const NOW = new Date(2026, 10, 18, 13, 0);
const at = (...a) => new Date(...a);

test('a note belongs to the narrowest group it fits', () => {
  assert.equal(periodOf(at(2026, 10, 18, 0, 0), NOW), 'today', 'just after midnight today');
  assert.equal(periodOf(at(2026, 10, 18, 23, 59), NOW), 'today', 'later today still counts as today');
  assert.equal(periodOf(at(2026, 10, 17, 23, 59), NOW), 'week', 'yesterday is this week, not today');
  assert.equal(periodOf(at(2026, 10, 16, 0, 0), NOW), 'week', 'Monday is the start of this week');
  assert.equal(periodOf(at(2026, 10, 15, 23, 59), NOW), 'month', 'Sunday before is this month');
  assert.equal(periodOf(at(2026, 10, 1, 0, 0), NOW), 'month', 'the 1st is the start of this month');
  assert.equal(periodOf(at(2026, 9, 31, 23, 59), NOW), 'year', 'last month is this year');
  assert.equal(periodOf(at(2026, 0, 1, 0, 0), NOW), 'year', '1 January is the start of this year');
  assert.equal(periodOf(at(2025, 11, 31, 23, 59), NOW), 'older', 'last year is older');
});

test('a date that cannot be read is never called recent', () => {
  assert.equal(periodOf('not a date', NOW), 'older');
  assert.equal(periodOf('', NOW), 'older');
});

test('groups come newest first, newest note first inside, and empty ones are left out', () => {
  const notes = [
    { id: 'old', createdAt: at(2024, 4, 2).toISOString() },
    { id: 'today-early', createdAt: at(2026, 10, 18, 8).toISOString() },
    { id: 'this-week', createdAt: at(2026, 10, 16, 9).toISOString() },
    { id: 'today-late', createdAt: at(2026, 10, 18, 12).toISOString() },
    { id: 'this-year', createdAt: at(2026, 2, 3).toISOString() },
  ];
  const groups = groupByPeriod(notes, NOW);
  assert.deepEqual(groups.map((g) => g.period), ['today', 'week', 'year', 'older'], 'no "month" group, since nothing is in it');
  assert.deepEqual(groups[0].items.map((n) => n.id), ['today-late', 'today-early'], 'newest first');
  assert.deepEqual(groups.map((g) => g.label), ['Today', 'Earlier this week', 'Earlier this year', 'Older']);
  // Every note appears exactly once, and none was changed.
  const seen = groups.flatMap((g) => g.items.map((n) => n.id));
  assert.equal(seen.length, notes.length);
  assert.equal(new Set(seen).size, notes.length);
  assert.deepEqual(groups[0].items[0], notes.find((n) => n.id === 'today-late'));
});

test('no notes gives no groups, and the summary is one line', () => {
  assert.deepEqual(groupByPeriod([], NOW), []);
  assert.equal(periodSummary([], NOW), '');
  assert.equal(periodSummary([{ createdAt: at(2026, 10, 18, 8).toISOString() }, { createdAt: at(2026, 10, 16).toISOString() }], NOW),
    'Today: 1 · Earlier this week: 1');
  assert.deepEqual([...HANDOFF_PERIODS], ['today', 'week', 'month', 'year', 'older']);
});

test('the first day of a year and of a week are not mixed up', () => {
  // 1 January 2027 is a Friday: that week began on Monday 28 December 2026.
  const newYear = new Date(2027, 0, 1, 10, 0);
  assert.equal(periodOf(at(2026, 11, 28, 9), newYear), 'week', 'the Monday of this week, though last year');
  assert.equal(periodOf(at(2026, 11, 27, 9), newYear), 'older', 'the Sunday before is last year, so older');
  assert.equal(periodOf(at(2027, 0, 1, 0, 0), newYear), 'today');
});
