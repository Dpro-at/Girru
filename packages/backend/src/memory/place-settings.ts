/**
 * STORE-MAP-01 P6 (D23, PRIV2): per Memory place, whether it stays on this
 * computer (migration 177). The places are the Memory window's own:
 *
 *   owner, people, experience, tasks, company, project:<key>
 *
 * A place without a row uses the default: People stays on this computer,
 * every other place does not. Only the switch is stored and shown here; the
 * reply paths read it through `localOnlyPlaces` (see placeOfDrawer for how a
 * drawer maps to its place).
 */
import { q } from '../repositories/sql-steps.js';
import { listProjects } from '../repositories/chat-conversations.js';
import { projectKeyOf } from './project-keys.js';
import type { DrawerRef } from './drawers.js';

export const FIXED_PLACES = ['owner', 'people', 'experience', 'tasks', 'company'] as const;
const LOCAL_BY_DEFAULT: ReadonlySet<string> = new Set(['people']);
const PROJECT_PLACE = /^project:[a-z0-9][a-z0-9_-]{0,63}$/;

export class PlaceSettingsError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'bad_place') { super(message); }
}

export const isPlace = (place: unknown): place is string =>
  typeof place === 'string' && ((FIXED_PLACES as readonly string[]).includes(place) || PROJECT_PLACE.test(place));

/** The place a memory drawer belongs to ('task' drawers are the Tasks place). */
export function placeOfDrawer(d: Pick<DrawerRef, 'kind' | 'key'>): string {
  if (d.kind === 'project') return `project:${d.key ?? ''}`;
  if (d.kind === 'task') return 'tasks';
  return d.kind;
}

async function stored(ownerId: string): Promise<Map<string, boolean>> {
  const rows = await q.all<{ place: string; stays_local: number }>('SELECT place, stays_local FROM memory_place_settings WHERE owner_id = ?', ownerId);
  return new Map(rows.map((r) => [r.place, Number(r.stays_local) === 1]));
}

/** Every place of the owner (the fixed ones and one per project) with its switch. */
export async function placeSettings(ownerId: string): Promise<{ places: Record<string, { staysLocal: boolean }> }> {
  const rows = await stored(ownerId);
  const keys: string[] = [...FIXED_PLACES, ...(await listProjects(ownerId)).map((p) => `project:${projectKeyOf(p)}`).filter((k) => PROJECT_PLACE.test(k))];
  for (const k of rows.keys()) if (!keys.includes(k)) keys.push(k);
  const places: Record<string, { staysLocal: boolean }> = {};
  for (const k of keys) places[k] = { staysLocal: rows.get(k) ?? LOCAL_BY_DEFAULT.has(k) };
  return { places };
}

export async function setPlaceSetting(ownerId: string, place: unknown, staysLocal: unknown): Promise<{ place: string; staysLocal: boolean }> {
  if (!isPlace(place)) throw new PlaceSettingsError('place must be owner, people, experience, tasks, company or project:<key>');
  if (typeof staysLocal !== 'boolean') throw new PlaceSettingsError('staysLocal must be true or false', 400, 'invalid_request');
  await q.run(`INSERT INTO memory_place_settings (owner_id, place, stays_local, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (owner_id, place) DO UPDATE SET stays_local = excluded.stays_local, updated_at = excluded.updated_at`,
  ownerId, place, staysLocal ? 1 : 0, new Date().toISOString());
  return { place, staysLocal };
}

/** The places that stay on this computer (what a reply for an online model leaves out). */
export async function localOnlyPlaces(ownerId: string): Promise<Set<string>> {
  const rows = await stored(ownerId);
  const out = new Set<string>();
  for (const k of LOCAL_BY_DEFAULT) if (rows.get(k) !== false) out.add(k);
  for (const [k, v] of rows) if (v) out.add(k);
  return out;
}
