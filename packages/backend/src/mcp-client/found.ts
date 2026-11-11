/**
 * MCP-ONE-01 "Found, not added": every MCP server set up in another place, merged into one list.
 *
 * Places: the coding apps' own MCP lists (Claude Code, Claude Desktop, Codex, Gemini CLI,
 * Antigravity; LocalMcpImport reads them), and the Store apps Girru installed that bring MCP
 * servers in their manifest (`mcpServers`, same shape as Claude's). Entries with the same program
 * or address are one row with several sources. A row whose server is already in the registry is
 * linked to it (its sources are recorded, nothing else changes). The list is read again on every
 * visit, so nothing has to be scanned by hand, and "Don't show again" is kept by launch key.
 *
 * Reading never starts a program, never contacts a server and never changes the other files.
 * Secret values stay where they are; only their names are shown.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LocalMcpImport, LocalMcpError, launchKey, normalizeEntry, type FoundMcp } from './local-import.js';
import { listServerRows, parseList } from './store.js';
import { createServer } from './service.js';
import { hiddenKeys, linkSource, setHidden } from './sources.js';
import { installedAppsRoot } from '../config/backend-root.js';
import { discoveryFs, isolatedReadRegularFile } from '../services/discovery-fs.js';
import { listProjects } from '../repositories/chat-conversations.js';
import { q } from '../repositories/sql-steps.js';
import { redactImportText } from '../memory/import/redact.js';
import { SERVER_NAME as MEMORY_SERVER } from '../memory/bridge/clients.js';

export const STORE_ORIGIN = 'Store app';
export interface FoundSource { origin: string; file: string; key: string; project: string | null; appId: string | null; appName: string | null; issue: string | null }
export interface FoundRow {
  /** sha-256 launch key (same program or address = same key); for an entry Girru cannot read safely, a key of its place. */
  key: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse' | null;
  /** The command line or the address, as written (no secret values). */
  target: string | null;
  secretNames: string[];
  sources: FoundSource[];
  state: 'new' | 'added' | 'manual' | 'hidden';
  serverId: string | null;
  issue: string | null;
}
export interface GirruRow { name: string; title: string; apps: string[] }
export interface FoundList { rows: FoundRow[]; girru: GirruRow[]; skipped: number }

type Entry = FoundMcp & { appId?: string; appName?: string };
const digest = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const object = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const APP_ID = /^[a-z0-9][a-z0-9._@:-]{0,127}$/i;

/** MCP servers Store apps bring: `mcpServers` in each installed app's agentplayer.plugin.json. */
export async function storeAppServers(root = installedAppsRoot()): Promise<{ servers: Entry[]; skipped: number }> {
  const servers: Entry[] = []; let skipped = 0;
  let dirs: string[] = [];
  try { dirs = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.isSymbolicLink() && APP_ID.test(d.name)).map((d) => d.name).slice(0, 200); } catch { return { servers, skipped }; }
  for (const id of dirs) {
    const file = path.join(root, id, 'agentplayer.plugin.json');
    let manifest: any;
    try { manifest = JSON.parse((await isolatedReadRegularFile(file, 256 * 1024, { root })).data.toString('utf8')); } catch { continue; }
    if (!object(manifest) || !object(manifest.mcpServers)) continue;
    const appName = typeof manifest.name === 'string' ? redactImportText(manifest.name).text.slice(0, 100) : id;
    for (const [key, raw] of Object.entries(manifest.mcpServers).slice(0, 20)) {
      if (servers.length >= 200) { skipped++; continue; }
      const entry: Entry = { name: redactImportText(key).text.slice(0, 100), origin: STORE_ORIGIN, file, key, appId: id, appName };
      try { if (!object(raw)) throw Error(); entry.input = normalizeEntry(raw, key); entry.hash = digest(entry.input); }
      catch (e) { entry.issue = e instanceof LocalMcpError ? e.code : 'invalid_configuration'; }
      servers.push(entry);
    }
  }
  return { servers, skipped };
}

function target(i: NonNullable<FoundMcp['input']>): string | null {
  if (i.transport === 'stdio') return [i.command, ...((i.args as string[] | undefined) ?? [])].filter((x) => typeof x === 'string').join(' ').slice(0, 1000);
  return typeof i.url === 'string' ? i.url.slice(0, 2000) : null;
}
const sourceOf = (e: Entry): FoundSource => ({ origin: e.origin, file: e.file, key: e.key, project: e.project ?? null, appId: e.appId ?? null, appName: e.appName ?? null, issue: e.issue ?? null });

export class McpFoundList {
  constructor(readonly home = os.homedir(), readonly appsRoot?: string) {}
  private local() { return new LocalMcpImport(this.home); }

  /** Project `.mcp.json` files: the chat projects' folders and the folders the owner allowed for "This computer". */
  private async projectFiles(userId?: string): Promise<{ origin: string; file: string }[]> {
    if (!userId) return [];
    const folders = new Set<string>();
    for (const p of await listProjects(userId).catch(() => [])) if (p.folder && path.isAbsolute(p.folder)) folders.add(p.folder);
    for (const r of await q.all<{ root: string }>('SELECT root FROM discovery_computer_roots WHERE user_id = ? LIMIT 500', userId).catch(() => [])) if (path.isAbsolute(r.root)) folders.add(r.root);
    const out: { origin: string; file: string }[] = [];
    for (const folder of [...folders].slice(0, 300)) {
      const file = path.join(folder, '.mcp.json');
      if ((await discoveryFs.lstat(file).catch(() => null))?.isFile()) out.push({ origin: 'Project', file });
    }
    return out;
  }

  private async entries(userId?: string): Promise<{ entries: Entry[]; skipped: number }> {
    const [local, store] = await Promise.all([this.projectFiles(userId).then((extra) => this.local().found(extra)), storeAppServers(this.appsRoot)]);
    return { entries: [...local.servers, ...store.servers], skipped: local.skipped + store.skipped };
  }

  /** The merged list. Rows already in the registry get their sources recorded on the way. */
  async list(userId?: string): Promise<FoundList & { byKey: Map<string, Entry[]> }> {
    const { entries, skipped } = await this.entries(userId);
    const rows = await listServerRows();
    const registry = new Map(rows.map((r) => [launchKey({ transport: r.transport, command: r.command, args: parseList(r.args), url: r.url }), r.id]));
    const hidden = await hiddenKeys();
    const groups = new Map<string, Entry[]>();
    const girru = new Map<string, Set<string>>();
    for (const e of entries) {
      if (e.name === MEMORY_SERVER && e.origin !== STORE_ORIGIN) { const s = girru.get(MEMORY_SERVER) ?? new Set(); s.add(e.origin); girru.set(MEMORY_SERVER, s); continue; }
      const key = e.input ? launchKey({ transport: e.input.transport as string, command: (e.input.command as string) ?? null, args: (e.input.args as string[]) ?? [], url: (e.input.url as string) ?? null }) : digest(['manual', e.file, e.project ?? '', e.key]);
      const list = groups.get(key) ?? [];
      list.push(e); groups.set(key, list);
    }
    const out: FoundRow[] = [];
    for (const [key, list] of groups) {
      const ok = list.find((e) => e.input);
      const serverId = registry.get(key) ?? null;
      if (serverId) for (const e of list) await linkSource(serverId, { origin: e.origin, file: e.file, key: e.key, project: e.project ?? null, appId: e.appId ?? null }).catch(() => {});
      const input = ok?.input;
      out.push({
        key, name: (ok ?? list[0]).name, transport: (input?.transport as FoundRow['transport']) ?? null, target: input ? target(input) : null,
        secretNames: [...new Set(list.flatMap((e) => Object.keys((e.input?.env as object) ?? {}).concat(Object.keys((e.input?.headers as object) ?? {}))))].slice(0, 32),
        sources: list.map(sourceOf), serverId,
        state: serverId ? 'added' : hidden.has(key) ? 'hidden' : ok ? 'new' : 'manual',
        issue: ok ? null : list[0].issue ?? 'invalid_configuration',
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return {
      rows: out, skipped, byKey: groups,
      girru: [...girru].map(([name, apps]) => ({ name, title: 'Girru memory', apps: [...apps].sort() })),
    };
  }

  /** Add a found row to the registry, switched off; every place it was found becomes one of its sources. */
  async add(owner: string, key: string, keepSecrets: boolean): Promise<{ id: string; duplicate: boolean }> {
    const { byKey } = await this.list(owner);
    const list = byKey.get(key);
    const pick = list?.find((e) => e.input && e.origin !== STORE_ORIGIN) ?? list?.find((e) => e.input);
    if (!list || !pick) throw new LocalMcpError(list ? (list[0].issue ?? 'unsupported_configuration') : 'source_not_found', list ? 400 : 404);
    let result: { id: string; duplicate: boolean };
    if (pick.origin === STORE_ORIGIN) {
      const existing = (await listServerRows()).find((r) => launchKey({ transport: r.transport, command: r.command, args: parseList(r.args), url: r.url }) === key);
      if (existing) result = { id: existing.id, duplicate: true };
      else {
        const input = pick.input!;
        if ((await listServerRows()).some((r) => r.name === input.name)) throw new LocalMcpError('name_conflict', 409);
        const { env: _e, headers: _h, ...bare } = input;
        result = { id: (await createServer(keepSecrets ? input : bare, owner, { dormantImport: true })).id, duplicate: false };
      }
    } else result = await this.local().importFound(owner, pick, pick.hash ?? '', keepSecrets);
    for (const e of list) await linkSource(result.id, { origin: e.origin, file: e.file, key: e.key, project: e.project ?? null, appId: e.appId ?? null });
    await setHidden(key, false);
    return result;
  }

  async hide(key: string, hidden: boolean): Promise<void> { await setHidden(key, hidden); }
}

