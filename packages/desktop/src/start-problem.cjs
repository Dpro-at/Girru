'use strict';
// STORE-MAP-01 P3 (OPS1, OPS2): the backend prints one line
// `GIRRU_START_PROBLEM {json}` when it cannot start for a reason people can act on
// (packages/backend/src/db/layout.ts). This turns it into the start page's words.

const MARK = 'GIRRU_START_PROBLEM ';
const KINDS = new Set(['layout_newer', 'migration_failed']);
const text = (v, max = 80) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '');

/** The newest start problem in the backend's last log lines, or null. */
function startProblemOf(lines) {
  for (const line of [...(lines || [])].reverse()) {
    const i = typeof line === 'string' ? line.indexOf(MARK) : -1;
    if (i < 0) continue;
    try {
      const v = JSON.parse(line.slice(i + MARK.length));
      if (v && typeof v === 'object' && KINDS.has(v.kind)) return v;
    } catch { /* not ours */ }
  }
  return null;
}

/** Query values for failed.html (plain strings only; the page shows them as text). */
function failedParams(problem) {
  const p = { kind: problem.kind, thisVersion: text(problem.thisVersion, 40) };
  if (problem.kind === 'layout_newer') p.writtenBy = text(problem.writtenBy, 40);
  if (problem.kind === 'migration_failed') { p.step = text(problem.step, 80); p.errorId = text(problem.errorId, 16); }
  return p;
}

module.exports = { startProblemOf, failedParams };
