#!/usr/bin/env node
/**
 * Entry of the dpro-memory MCP server (MEM-BRIDGE-01), started by a CLI:
 *   node mcp-stdio.js --client claude-code|codex|gemini-cli|antigravity
 * Environment (set by Girru's registration: paths only, never a secret; plus, from Girru's launcher only):
 *   AGENT_PLAYER_CONFIG_DIR  folder of instance.json;  AGENT_PLAYER_URL  the local backend
 *   GIRRU_SESSION_CAPABILITY  only in a process Girru's launcher started (STORE-MAP-01 pilot): its session
 *   capability, a secret that is never logged and never written to a config file
 * stdout carries only MCP messages; diagnostics go to stderr and never hold the token.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { cliConfigDir } from '../../services/instance-identity.js';
import { createBridgeMcpServer, httpBackend } from './mcp-server.js';

const CLIENTS = new Set(['claude-code', 'codex', 'gemini-cli', 'antigravity']);

async function main(): Promise<void> {
  const i = process.argv.indexOf('--client');
  const client = i >= 0 ? process.argv[i + 1] : '';
  if (!CLIENTS.has(client)) throw new Error('--client must be claude-code, codex, gemini-cli or antigravity');
  const backend = httpBackend({
    client, cwd: process.cwd(), configDir: cliConfigDir(),
    backendUrl: process.env.AGENT_PLAYER_URL || 'http://127.0.0.1:41522',
    capability: process.env.GIRRU_SESSION_CAPABILITY || null,
  });
  // A session Girru started (P6) also gets the five verbs of the one memory contract.
  await createBridgeMcpServer(backend, { verbs: !!process.env.GIRRU_SESSION_CAPABILITY }).connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`dpro-memory: failed to start: ${err instanceof Error ? err.message : 'unknown error'}\n`);
  process.exit(1);
});
