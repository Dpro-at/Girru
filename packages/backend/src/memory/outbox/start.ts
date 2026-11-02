/**
 * STORE-MAP-01 pilot start-up: when GIRRU_STORE_PILOT names a project, its
 * memory drawer keeps a change log and the brief-file projection worker runs.
 * Without the variable nothing is enabled and nothing runs.
 */

import { q } from '../../repositories/sql-steps.js';
import { findProject } from '../../repositories/chat-conversations.js';
import { enableScope } from './events.js';
import { pilotProjectId } from './pilot.js';
import { runBriefProjection, startProjectionWorker } from './projection.js';

export async function startStorePilot(): Promise<{ scope: string } | null> {
  const id = pilotProjectId();
  if (!id) return null;
  const row = await q.one<{ user_id: string }>('SELECT user_id FROM chat_projects WHERE id = ?', id);
  const project = row ? await findProject(row.user_id, id) : undefined;
  if (!row || !project) {
    console.warn('[Store pilot] GIRRU_STORE_PILOT names no project; the pilot stays off');
    return null;
  }
  const scope = await enableScope(row.user_id, project);
  startProjectionWorker();
  void runBriefProjection(scope).catch((err) => console.warn('[Store pilot] first projection failed:', (err as Error)?.message));
  console.log(`[Store pilot] change log and brief projection on for ${scope}`);
  return { scope };
}
