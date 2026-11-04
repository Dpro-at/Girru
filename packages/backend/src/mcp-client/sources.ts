/**
 * Where each registry MCP server came from (MCP-ONE-01): the app, its config file and the entry
 * key inside it. One server can have several sources (the same program in Claude and Codex).
 * Only where the entry is is kept; the other app's file is never changed and no secret is stored.
 */
import { q } from '../repositories/sql-steps.js';

export interface SourceLink { origin: string; file: string; key: string; project?: string | null; appId?: string | null }
export interface SourceView { origin: string; file: string; key: string; project: string | null; appId: string | null; seenAt: string }

type Row = { server_id: string; origin: string; file: string; entry_key: string; project: string; app_id: string | null; seen_at: string };
const view = (r: Row): SourceView => ({ origin: r.origin, file: r.file, key: r.entry_key, project: r.project || null, appId: r.app_id, seenAt: r.seen_at });
const clip = (x: string, n: number) => x.slice(0, n);

/** Record (or refresh) that this server is also in `link`. */
export async function linkSource(serverId: string, link: SourceLink): Promise<void> {
  await q.run(
    `INSERT INTO mcp_server_sources (server_id, origin, file, entry_key, project, app_id, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id, file, entry_key, project) DO UPDATE SET origin = excluded.origin, app_id = excluded.app_id, seen_at = excluded.seen_at`,
    serverId, clip(link.origin, 80), clip(link.file, 2048), clip(link.key, 200), clip(link.project ?? '', 2048), link.appId ?? null, new Date().toISOString(),
  );
}

/** Forget one source of a server (its app removed the entry, or a Store app was removed). */
export async function unlinkSource(serverId: string, file: string, key: string, project = ''): Promise<void> {
  await q.run('DELETE FROM mcp_server_sources WHERE server_id = ? AND file = ? AND entry_key = ? AND project = ?', serverId, file, key, project);
}

/** Forget every source a Store app brought. The servers stay (off or on as the owner left them). */
export async function unlinkApp(appId: string): Promise<number> {
  return (await q.run('DELETE FROM mcp_server_sources WHERE app_id = ?', appId)).changes;
}

/** Every server's sources, by server id. */
export async function allSources(): Promise<Map<string, SourceView[]>> {
  const out = new Map<string, SourceView[]>();
  for (const r of await q.all<Row>('SELECT * FROM mcp_server_sources ORDER BY origin, file, entry_key')) {
    const list = out.get(r.server_id) ?? [];
    list.push(view(r));
    out.set(r.server_id, list);
  }
  return out;
}

export async function sourcesOf(serverId: string): Promise<SourceView[]> {
  return (await q.all<Row>('SELECT * FROM mcp_server_sources WHERE server_id = ? ORDER BY origin, file, entry_key', serverId)).map(view);
}

/** "Don't show again" for a found server, by its launch key. */
export async function setHidden(launchKey: string, hidden: boolean): Promise<void> {
  if (hidden) await q.run('INSERT INTO mcp_found_hidden (launch_key, hidden_at) VALUES (?, ?) ON CONFLICT(launch_key) DO NOTHING', launchKey, new Date().toISOString());
  else await q.run('DELETE FROM mcp_found_hidden WHERE launch_key = ?', launchKey);
}

export async function hiddenKeys(): Promise<Set<string>> {
  return new Set((await q.all<{ launch_key: string }>('SELECT launch_key FROM mcp_found_hidden')).map((r) => r.launch_key));
}
