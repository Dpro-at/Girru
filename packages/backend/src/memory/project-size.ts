/**
 * A project's size in tokens (MEM-READ-01 MR7): its memories, key files, other
 * documents and summaries, and how much an agent loads per reply. Estimates
 * (≈), from stored lengths only: no file is opened and no model is asked.
 */

import { all, one, sql } from '../repositories/sql-steps.js';
import { CHARS_PER_TOKEN } from './context/budget.js';
import { PACK_MEMORY_CHARS } from './context/pack.js';
import { NOT_REPLACED_SQL } from './validity.js';

/** Files every coding app reads (MR6 Key files): CLAUDE.md, AGENTS.md, GEMINI.md, HANDOFF, BACKLOG, TASKS, DECISIONS, README, Copilot and Cursor rules. */
export const KEY_FILE = /(?:^|\/)(?:CLAUDE(?:\.local)?|AGENTS|GEMINI|HANDOFF|BACKLOG|TASKS|DECISIONS|README)\.md$|(?:^|\/)\.github\/copilot-instructions\.md$|(?:^|\/)\.cursor\/rules\/[^/]+\.mdc?$/i;

const tok = (chars: number) => Math.round(Math.max(0, chars) / CHARS_PER_TOKEN);

export interface ProjectSize {
  memories: { count: number; tokens: number };
  keyFiles: { count: number; tokens: number };
  documents: { count: number; tokens: number };
  summaries: { count: number; tokens: number };
  total: number;
  perReply: number;
  biggest: { name: string; tokens: number } | null;
}

export async function projectSize(ownerId: string, slug: string): Promise<ProjectSize> {
  return sql().read((function* () {
    const m = yield* one<{ n: number; c: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS c FROM memories WHERE user_id = ? AND drawer_kind = 'project' AND drawer_key = ? AND ${NOT_REPLACED_SQL}`, ownerId, slug);
    let files: Array<{ path: string; bytes: number }> = [];
    try {
      files = yield* all<{ path: string; bytes: number }>(`SELECT f.display_path AS path, f.bytes AS bytes FROM doc_index_files f JOIN doc_index_sources s ON s.id = f.source_id
        WHERE s.owner_id = ? AND s.kind = 'project' AND s.ref_id = ? AND f.status = 'ok' LIMIT 2000`, ownerId, slug);
    } catch { files = []; }
    let summaries = { n: 0, c: 0 };
    try { summaries = (yield* one<{ n: number; c: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(text)), 0) AS c FROM memory_project_summaries WHERE owner_id = ? AND slug = ?", ownerId, slug)) ?? summaries; } catch { /* MR6 table not there yet */ }
    const key = files.filter((f) => KEY_FILE.test(f.path)), other = files.filter((f) => !KEY_FILE.test(f.path));
    const sum = (l: typeof files) => l.reduce((a, f) => a + Number(f.bytes || 0), 0);
    const memTokens = tok(Number(m?.c ?? 0));
    const big = [...files].sort((a, b) => Number(b.bytes) - Number(a.bytes))[0];
    const size: ProjectSize = {
      memories: { count: Number(m?.n ?? 0), tokens: memTokens },
      keyFiles: { count: key.length, tokens: tok(sum(key)) },
      documents: { count: other.length, tokens: tok(sum(other)) },
      summaries: { count: Number(summaries.n), tokens: tok(Number(summaries.c)) },
      total: 0,
      // The budget picks the most useful memories per reply; the rest stay on disk.
      perReply: Math.min(memTokens, tok(PACK_MEMORY_CHARS)),
      biggest: big ? { name: big.path, tokens: tok(Number(big.bytes)) } : null,
    };
    size.total = size.memories.tokens + size.keyFiles.tokens + size.documents.tokens + size.summaries.tokens;
    return size;
  })());
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/** Who reads a project and how (Read only / Read + write), from the same access rules as Settings › Memory › Access. */
export async function projectReaders(ownerId: string, slug: string, limit = 40): Promise<Array<{ agentId: string; name: string; write: boolean }>> {
  const { effectiveAccess } = await import('./scopes/access.js');
  const agents = await sql().read(all<{ id: string }>('SELECT id FROM agents_config ORDER BY name LIMIT ?', limit));
  const out: Array<{ agentId: string; name: string; write: boolean }> = [];
  for (const a of agents) {
    const e = await effectiveAccess(ownerId, a.id, slug).catch(() => null) as { agentName: string; kinds: { project: { read: boolean; write: boolean } } } | null;
    if (e?.kinds.project.read) out.push({ agentId: a.id, name: e.agentName, write: e.kinds.project.write });
  }
  return out;
}

/** MR7 for agents (MCP project_brief): what loading this project means, and who reads it. */
export async function projectLoadText(ownerId: string, slug: string): Promise<{ text: string; size: ProjectSize; readers: Array<{ agentId: string; name: string; write: boolean }> }> {
  const [size, readers] = await Promise.all([projectSize(ownerId, slug), projectReaders(ownerId, slug)]);
  const lines = ['### This project in Girru',
    `- Memory ≈ ${k(size.total)} tokens (memories ≈ ${k(size.memories.tokens)}, key files ≈ ${k(size.keyFiles.tokens)}, other documents ≈ ${k(size.documents.tokens)}); an agent loads ≈ ${k(size.perReply)} per reply.`,
    `- Read by: ${readers.length ? readers.map((r) => `${r.name} (${r.write ? 'read + write' : 'read only'})`).join(', ') : 'no agent yet'}.`];
  return { text: lines.join('\n'), size, readers };
}
