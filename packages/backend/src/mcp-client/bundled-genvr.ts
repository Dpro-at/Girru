/**
 * GenVR's own local MCP server ships with Girru and is on by default (Mohamed, 2026-11-04).
 *
 * Other stdio MCP servers start host processes and stay behind AGENT_EXEC_TOOLS. This one is
 * trusted without that switch, but only in its exact bundled form: Girru's own Node, the pinned
 * entry inside the app (its bytes are checked by hash when Node loads it), under the name
 * genvr-local, with no environment beyond its two folders. Any other command, arguments or
 * environment is an ordinary stdio server again. The owner's launch approval, the per-agent tool
 * grants and the approvals for tools that change things are unchanged.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinnedEntryArgs } from './pinned-entry.js';
import type { McpServerRow } from './store.js';

export const GENVR_MCP_NAME = 'genvr-local';
export const GENVR_MCP_DESCRIPTION = 'Bundled GenVR local authoring';
export const GENVR_PACKAGE_HASH = '4d209c9e8fc7028ed5dbcba8b0d38c59a299f433afc3bb69af7d3f75d80afbab';
export const GENVR_ENV_NAMES: readonly string[] = Object.freeze(['GENVR_STUDIO_CONNECTION', 'GENVR_WORLD_DIR']);

/** The bundled GenVR MCP entry inside this app. */
export const genvrMcpEntry = () => fileURLToPath(new URL('../../../core-ui/vendor/genvr/package/dist/mcp.js', import.meta.url));
/** The one launch that is trusted: Girru's Node with the hash-pinned bundled entry. */
export const genvrLaunch = () => ({ command: process.execPath, args: pinnedEntryArgs(genvrMcpEntry(), GENVR_PACKAGE_HASH) });

const list = (raw: string | null): unknown[] => { try { const v = JSON.parse(raw ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

/** True only for the exact bundled GenVR launch (see above); never for anything an owner or agent edited. */
export function isTrustedBundledLaunch(row: Pick<McpServerRow, 'name' | 'transport' | 'command' | 'args' | 'env_names' | 'description'>): boolean {
  if (row.name !== GENVR_MCP_NAME || row.transport !== 'stdio' || row.description !== GENVR_MCP_DESCRIPTION) return false;
  const launch = genvrLaunch();
  if (row.command !== launch.command || !path.isAbsolute(launch.command)) return false;
  if (JSON.stringify(list(row.args)) !== JSON.stringify(launch.args)) return false;
  const names = list(row.env_names);
  return names.length <= GENVR_ENV_NAMES.length && names.every(name => typeof name === 'string' && GENVR_ENV_NAMES.includes(name));
}
