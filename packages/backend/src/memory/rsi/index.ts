/**
 * Evidence-gated, self-retiring lessons (MEM-RSI-01): a lessons layer on top
 * of memory. A lesson exists only with a cue, an action and >= 1 confirmed
 * evidence row; it is extracted deterministically from closed task runs;
 * support is reversible, so a lesson retires when its support reaches zero and
 * is restored when it climbs back; three modes (off / shadow / inject) decide
 * whether, and how, lessons reach a prompt. Owner-only, like the memory graph.
 */

export * from './types.js';
export { rsiMode, rsiLessonsOn, RSI_LESSONS_ENV } from './mode.js';
export {
  rsiTablesExist,
  resetRsiTableCache,
  recordEvidence,
  setSourceDisposition,
  forgetSource,
  getLesson,
  listLessons,
  listEvidence,
  logUsage,
  usageCount,
  type RecordResult,
  type ListLessonsOptions,
  type EvidenceRow,
} from './store.js';
export {
  deriveLessonsFromRun,
  extractLessons,
  extractLessonsForRun,
  onRunFinished,
  rsiExtractionIdle,
  type RunOutcome,
} from './extract.js';
export {
  selectLessons,
  buildLessonInjection,
  type Injection,
} from './inject.js';
export {
  lessonApplies,
  renderLessonBlock,
  requestTokens,
  BLOCK_HEADER,
  MATCH_RATIO,
} from './render.js';
export {
  ACTION_TEMPLATES,
  reasonCodeForRun,
} from './derive.js';
