/**
 * STORE-MAP-01 P6 start-up: the pilot's change log and brief projection for
 * every project whose owner turned its memory files on (the brief file is
 * written into the project folder only where the owner allowed files). The
 * projection worker is debounced per project (T6) and is the only writer of
 * the files (DB2-8: never inside a database transaction). Off without
 * GIRRU_STORE_P6.
 */

import { q } from '../../repositories/sql-steps.js';
import { findProject } from '../../repositories/chat-conversations.js';
import { storeP6Enabled } from '../../services/store-p6.js';
import { disableScope, enableScope, projectScope } from './events.js';
import { pilotProjectId } from './pilot.js';
import { setProjectionDebounce, startProjectionWorker } from './projection.js';

/** Bring the change-log scopes in line with the owners' file switches. Returns the enabled scopes. */
export async function syncP6Scopes(): Promise<string[]> {
  const rows = await q.all<{ owner_id: string; project_id: string; files_enabled: number }>(
    'SELECT f.owner_id, f.project_id, f.files_enabled FROM memory_bridge_folders f JOIN chat_projects p ON p.id = f.project_id AND p.user_id = f.owner_id');
  const on: string[] = [];
  for (const r of rows) {
    const project = await findProject(r.owner_id, r.project_id);
    if (!project?.folder) continue;
    if (Number(r.files_enabled) === 1) on.push(await enableScope(r.owner_id, project));
    else if (project.id !== pilotProjectId()) await disableScope(projectScope(project));
  }
  return on;
}

let rescan: NodeJS.Timeout | null = null;

export async function startStoreP6(): Promise<{ scopes: number } | null> {
  if (!storeP6Enabled()) return null;
  const scopes = await syncP6Scopes();
  setProjectionDebounce(true);
  startProjectionWorker(400);
  // A file switch turned on or off later is picked up within a minute.
  rescan ??= setInterval(() => { void syncP6Scopes().catch(() => undefined); }, 60_000);
  rescan.unref?.();
  console.log(`[Store P6] change log and debounced file sync on for ${scopes.length} project(s)`);
  return { scopes: scopes.length };
}

export function stopStoreP6(): void {
  if (rescan) clearInterval(rescan);
  rescan = null;
  setProjectionDebounce(false);
}
