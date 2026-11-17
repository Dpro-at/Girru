/**
 * Deriving lessons from finished runs (MEM-RSI-01) — pure, no DB, no model,
 * no network.
 *
 * SECURITY (stored prompt-injection defence): a run's free-text status_reason
 * can originate from tool or model output and is therefore UNTRUSTED. It is
 * used only to build the lesson's match key (the cue, which is never rendered
 * into a prompt). The lesson's action — the only text that can reach a prompt
 * — is a FIXED system template chosen by a bounded reason CODE, so no run text
 * ever becomes an injected instruction.
 */

import {
  normalizeCue,
  SOURCE_KIND_TASK_RUN,
  type LessonDraft,
  type Polarity,
  type ReasonCode,
} from './types.js';

/** The fields of a finished run extraction reads (none is encrypted). */
export interface RunOutcome {
  id: string;
  userId: string;
  status: 'completed' | 'failed' | 'cancelled';
  /** Untrusted, caller-written reason for the terminal state (task-runs.ts).
   * Used ONLY to build the match key; never rendered into a prompt. */
  statusReason: string | null;
}

/** The fixed action template and polarity each reason code carries. */
export const ACTION_TEMPLATES: Record<ReasonCode, { polarity: Polarity; action: string }> = {
  task_completed: {
    polarity: 'positive',
    action: 'A past task in a comparable situation completed successfully; the earlier approach is worth considering again.',
  },
  task_failed: {
    polarity: 'caution',
    action: 'A past task in a comparable situation did not succeed; review the approach before repeating it.',
  },
};

/** Map a terminal run status to a bounded reason code, or null (no lesson). */
export function reasonCodeForRun(status: RunOutcome['status']): ReasonCode | null {
  if (status === 'completed') return 'task_completed';
  if (status === 'failed') return 'task_failed';
  return null; // cancelled proves neither outcome
}

/**
 * The lessons a finished run proves. Deterministic: a lesson forms only when
 * the run carries a reason to key on (the cue). The action and polarity come
 * from the fixed template for the run's reason code — never from the reason
 * text itself.
 */
export function deriveLessonsFromRun(run: RunOutcome): LessonDraft[] {
  const code = reasonCodeForRun(run.status);
  if (!code) return [];
  const cue = normalizeCue(run.statusReason ?? '');
  if (!cue) return [];
  const t = ACTION_TEMPLATES[code];
  return [{
    cue,
    action: t.action,
    polarity: t.polarity,
    sourceKind: SOURCE_KIND_TASK_RUN,
    sourceId: run.id,
    disposition: 'confirmed',
    reasonCode: code,
  }];
}
