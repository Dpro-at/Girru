/**
 * Promotion path (STORE-MAP-01 P9, M2): a lesson that keeps coming back in
 * the experience drawer becomes reusable knowledge, but only as a PROPOSAL.
 * The owner approves; nothing here changes what agents do by itself.
 *
 * Once a week (memory job 'quality', GIRRU_STORE_P9 only) the current
 * experience memories are grouped by their content words (Jaccard >=
 * SAME_LESSON). A group of at least LESSON_REPEATS memories is one repeated
 * lesson, proposed as
 *
 *   a rule   when it is an instruction ("always ...", "never ...", "make sure
 *            ...", "دائما", "لا ت...", "immer", "nie"): a suggested rule in
 *            Agents › Rules (services/agent-rules.ts; never sent before the
 *            owner accepts it);
 *   a skill  otherwise (a how-to or a finding): a memory proposal that adds a
 *            `skill` memory to the experience drawer (Needs you; reason
 *            'lesson-promotion').
 *
 * Each lesson is proposed once: its key (`lesson:<hash of the group's oldest
 * memory>`) is kept in the proposal's reasons, so a dismissed or rejected
 * proposal is not made again. Rule-based: no model, no network.
 */

import { createHash } from 'node:crypto';
import { all, one, sql } from '../repositories/sql-steps.js';
import { drawerSqlFilter, type DrawerRef } from './drawers.js';
import { lexicalTokens } from './text-normalize.js';
import { NOT_REPLACED_SQL } from './validity.js';
import { createChangeProposal, MemoryFileError, resolveFileAgent } from './memory-files.js';
import { RuleInputError, RULE_CHARS, suggestRule } from '../services/agent-rules.js';

export const LESSON_REPEATS = 3;
/** Content-word overlap at or above this means "the same lesson". */
export const SAME_LESSON = 0.5;
/** Newest experience memories looked at per run. */
const MAX_SCAN = 2000;
/** Proposals made per run at most (the owner's queue stays short). */
export const MAX_PROPOSALS_PER_RUN = 5;
const MIN_WORDS = 3;
const ACTOR = 'system:lessons';
const EXPERIENCE: DrawerRef = { kind: 'experience' };

const INSTRUCTION = /^\s*(always|never|do not|don't|dont|avoid|make sure|must|should|prefer|use|run|check|keep)\b|\b(must|should|always|never)\b|^\s*(دائما|دائماً|ابدا|أبداً|أبدا|لا ت|يجب|تأكد|استخدم)|^\s*(immer|nie|niemals|nicht|vermeide|stelle sicher|muss|soll)\b/iu;

export interface Lesson { key: string; kind: 'rule' | 'skill'; text: string; memoryIds: string[] }

interface Row { id: string; content: string; created_at: string }

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both || 1);
}

/** Pure: the repeated lessons among these memories (oldest first). */
export function findLessons(rows: readonly Row[]): Lesson[] {
  const items = [...rows]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .map((r) => ({ ...r, tokens: new Set(lexicalTokens(r.content)) }))
    .filter((r) => r.tokens.size >= MIN_WORDS);
  const groups: Array<typeof items> = [];
  for (const it of items) {
    // The group whose first lesson is closest (each memory joins one group).
    let best: (typeof items) | null = null;
    let bestScore = SAME_LESSON;
    for (const g of groups) {
      const s = jaccard(g[0].tokens, it.tokens);
      if (s >= bestScore) { best = g; bestScore = s; }
    }
    if (best) best.push(it);
    else groups.push([it]);
  }
  return groups
    .filter((g) => g.length >= LESSON_REPEATS)
    .map((g) => {
      // The shortest wording says it most plainly.
      const text = [...g].sort((a, b) => a.content.length - b.content.length || a.id.localeCompare(b.id))[0].content.replace(/\s+/g, ' ').trim();
      return {
        key: `lesson:${createHash('sha256').update(g[0].id).digest('hex').slice(0, 16)}`,
        kind: INSTRUCTION.test(text) ? 'rule' as const : 'skill' as const,
        text: [...text].slice(0, RULE_CHARS).join(''),
        memoryIds: g.map((x) => x.id),
      };
    });
}

/** True when this lesson was proposed before (any outcome). */
async function proposedBefore(userId: string, key: string): Promise<boolean> {
  const like = `%${key}%`;
  const rule = await sql().read(one('SELECT id FROM agent_rules WHERE reason LIKE ? LIMIT 1', like));
  if (rule) return true;
  return !!(await sql().read(one('SELECT id FROM memory_file_proposals WHERE user_id = ? AND reasons LIKE ? LIMIT 1', userId, like)));
}

export interface LessonProposal { key: string; kind: 'rule' | 'skill'; id: string; repeats: number }

/** Propose each new repeated lesson (owner accounts; the caller checks). */
export async function promoteLessons(userId: string): Promise<LessonProposal[]> {
  const f = drawerSqlFilter([EXPERIENCE]);
  const rows = await sql().read(all<Row>(`
    SELECT id, content, created_at FROM memories
     WHERE user_id = ? AND ${f.sql} AND COALESCE(status, 'active') = 'active' AND ${NOT_REPLACED_SQL}
     ORDER BY created_at DESC, id DESC LIMIT ?`, userId, ...f.params, MAX_SCAN));
  const out: LessonProposal[] = [];
  for (const l of findLessons(rows)) {
    if (out.length >= MAX_PROPOSALS_PER_RUN) break;
    if (await proposedBefore(userId, l.key)) continue;
    const why = `Repeated lesson: ${l.memoryIds.length} similar memories in the experience drawer (${l.key})`;
    try {
      if (l.kind === 'rule') {
        const rule = await suggestRule({ text: l.text, when: null, projectId: null, who: 'all', targets: [], paused: false }, null, why);
        out.push({ key: l.key, kind: 'rule', id: rule.id, repeats: l.memoryIds.length });
      } else {
        const agentId = await resolveFileAgent().catch(() => '(none)');
        const p = await createChangeProposal({
          userId, agentId, drawer: EXPERIENCE, source: 'learning', createdBy: ACTOR, note: why,
          changes: [{ op: 'add', after: { type: 'skill', importance: 6, content: l.text } }],
          reasons: ['lesson-promotion', l.key, ...l.memoryIds.slice(0, 10).map((id) => `lesson-from:${id}`)],
        });
        out.push({ key: l.key, kind: 'skill', id: p.id, repeats: l.memoryIds.length });
      }
    } catch (err) {
      // A full queue or a refused text waits for the next run.
      if (err instanceof RuleInputError || err instanceof MemoryFileError) break;
      throw err;
    }
  }
  return out;
}
