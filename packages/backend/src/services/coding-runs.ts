/**
 * Coding-app work in a chat (CHAT-GAPS-01, Mohamed 2026-10-28): when an agent hands a part
 * to Claude Code, Codex or Gemini (ask_coding_app), the chat's Team shows it as its own row
 * with Stop. Kept in memory only, while it runs; Stop in the chat ends all of them.
 */
import { randomUUID } from 'node:crypto';
import { q } from '../repositories/sql-steps.js';
import { currentChatRun } from './chat-run-context.js';

export type CodingRunView = { id: string; app: string; agentId: string | null; about: string; startedAt: string };
type CodingRun = CodingRunView & { controller: AbortController };

const runs = new Map<string, Map<string, CodingRun>>();
const ID = /^[a-f0-9]{32}$/;

/** The first line of the request, short, as the row's "what it does". */
const aboutOf = (request: string) => {
  const line = request.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
};

export type CodingRunOutcome = 'complete' | 'stopped' | 'error';

/** Registers one coding-app run of a chat; call done() when it ends. RUNS-01: also kept in coding_app_runs (best effort). */
export function startCodingRun(sessionId: string, app: string, agentId: string | null | undefined, request: string) {
  const run: CodingRun = { id: randomUUID().replace(/-/g, ''), app, agentId: agentId ?? null, about: aboutOf(request), startedAt: new Date().toISOString(), controller: new AbortController() };
  let set = runs.get(sessionId);
  if (!set) runs.set(sessionId, set = new Map());
  set.set(run.id, run);
  const parent = currentChatRun()?.runId;
  const saved = q.run('INSERT INTO coding_app_runs (id, session_id, user_id, agent_id, app, about, started_at, parent_run_id) VALUES (?, ?, (SELECT user_id FROM chat_sessions WHERE id = ?), ?, ?, ?, ?, ?)',
    run.id, sessionId, sessionId, run.agentId, app, run.about, Date.parse(run.startedAt), parent ? `chat:${parent}` : null).catch(() => undefined);
  return {
    id: run.id,
    signal: run.controller.signal,
    done: (outcome: CodingRunOutcome = 'complete', errorCode: string | null = null) => {
      const s = runs.get(sessionId); s?.delete(run.id); if (s && !s.size) runs.delete(sessionId);
      void saved.then(() => q.run('UPDATE coding_app_runs SET state = ?, error_code = ?, ended_at = ? WHERE id = ?', outcome, outcome === 'error' ? errorCode : null, Date.now(), run.id)).catch(() => undefined);
    },
  };
}

/** Every coding-app run working now, with its chat (for Runs). */
export function liveCodingRuns(): Array<CodingRunView & { sessionId: string }> {
  return [...runs.entries()].flatMap(([sessionId, set]) => [...set.values()].map(({ controller: _c, ...view }) => ({ ...view, sessionId })));
}

/** The coding apps working in this chat now (oldest first). */
export function codingRunsFor(sessionId: string): CodingRunView[] {
  return [...(runs.get(sessionId)?.values() ?? [])].map(({ controller: _c, ...view }) => view);
}

/** Stops one coding-app run of this chat; false when it is not running here. */
export function stopCodingRun(sessionId: string, id: unknown): boolean {
  if (typeof id !== 'string' || !ID.test(id)) return false;
  const run = runs.get(sessionId)?.get(id);
  if (!run) return false;
  run.controller.abort();
  return true;
}

/** Stops every coding-app run of this chat; returns how many. */
export function stopCodingRuns(sessionId: string): number {
  const set = runs.get(sessionId);
  if (!set) return 0;
  for (const r of set.values()) r.controller.abort();
  return set.size;
}
