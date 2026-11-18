import {assertMemoryFilesystemAccess} from '../../memory/encryption/protected-filesystem.js';
/**
 * Read Tool
 *
 * Read a file from the agent's workspace (S1.6 sandbox: per-agent
 * `.data/workspaces/<agentId>/`, or an explicit read root set by server
 * code; realpath containment, always-deny list, size limit).
 *
 * CHAT-LIVE-01: big files are read in parts (`offset`/`limit` lines or the
 * last `tail` lines), a folder lists its entries, and `pattern` searches a
 * file or a folder. Every answer is capped, so one call never floods the
 * model; the cap is said in the answer.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Tool, ToolResult } from '../types.js';
import { FileSandboxError, denyReason, readRootFor, resolveReadPath, sandboxedReadText } from './file-sandbox.js';

/** Most text one call returns (characters). */
export const READ_OUTPUT_CHARS = 16_000;
/** Lines returned when a big file is read without a range. */
export const DEFAULT_LINES = 300;
const MAX_LIST = 300;
const MAX_HITS = 60;
const MAX_SCAN_ENTRIES = 4000;
/** A folder search reads at most this much text in total, files up to SEARCH_FILE_BYTES each, for at most SEARCH_MS. */
const SEARCH_BYTES = 64 * 1024 * 1024, SEARCH_FILE_BYTES = 4 * 1024 * 1024, SEARCH_MS = 5000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.cache', '__pycache__', '.venv', 'venv']);

const cut = (text: string): { text: string; cut: boolean } => text.length > READ_OUTPUT_CHARS ? { text: text.slice(0, READ_OUTPUT_CHARS), cut: true } : { text, cut: false };
const intOr = (v: unknown, d: number | undefined, min: number, max: number) => {
  if (v === undefined || v === null || v === '') return d;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < min) throw new FileSandboxError(`must be a whole number from ${min}`, 'invalid_path');
  return Math.min(n, max);
};

function listFolder(real: string, rel: string): ToolResult {
  assertMemoryFilesystemAccess(real);
  const rows: string[] = [];
  let total = 0;
  for (const e of fs.readdirSync(real, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
    const childRel = rel ? path.join(rel, e.name) : e.name;
    if (denyReason(childRel, path.join(real, e.name))) continue;
    total++;
    if (rows.length >= MAX_LIST) continue;
    if (e.isDirectory()) rows.push(`${e.name}/`);
    else if (e.isFile()) { let size = 0; try { size = fs.statSync(path.join(real, e.name)).size; } catch { /* gone */ } rows.push(`${e.name}  ${size} bytes`); }
  }
  const more = total > rows.length ? `\n… ${total - rows.length} more not shown` : '';
  return { content: [{ type: 'text', text: `Folder ${rel || '.'} (${total} entries):\n${rows.join('\n')}${more}` }], details: { path: rel || '.', kind: 'folder', entries: total } };
}

function searchText(pattern: string, real: string, rel: string, isDir: boolean): ToolResult {
  const needle = pattern.toLowerCase();
  const hits: string[] = [];
  const started = Date.now();
  let files = 0, entries = 0, bytes = 0, matches = 0, stopped: string | null = null;
  const scanFile = (abs: string, r: string, size: number) => {
    // Size first: a big or binary file is skipped before it is read (one named file may be up to the read limit).
    if (isDir && size > SEARCH_FILE_BYTES) return;
    if (bytes + size > SEARCH_BYTES) { stopped = 'the size budget'; return; }
    let text: string;
    try { text = sandboxedReadText(abs); } catch { return; }
    bytes += size; files++;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(needle)) continue;
      matches++;
      if (hits.length < MAX_HITS) hits.push(`${r}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
    }
  };
  if (!isDir) { let size = 0; try { size = fs.statSync(real).size; } catch { /* gone */ } scanFile(real, rel, size); }
  else {
    const walk = (abs: string, r: string) => {
      if (stopped) return;
      let list: fs.Dirent[];
      try { list = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        // Every entry counts against the limits, folders and skipped ones too.
        if (++entries > MAX_SCAN_ENTRIES) { stopped = `${MAX_SCAN_ENTRIES} entries`; return; }
        if (Date.now() - started > SEARCH_MS) { stopped = 'the time limit'; return; }
        if (stopped) return;
        const childRel = r ? path.join(r, e.name) : e.name, childAbs = path.join(abs, e.name);
        if (denyReason(childRel, childAbs)) continue;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(childAbs, childRel); }
        else if (e.isFile()) { let size = 0; try { size = fs.lstatSync(childAbs).size; } catch { continue; } scanFile(childAbs, childRel, size); }
      }
    };
    walk(real, rel);
  }
  const more = matches > hits.length ? `\n… ${matches - hits.length} more matches not shown; search a smaller folder or a longer pattern` : '';
  const note = stopped ? `\n(stopped at ${stopped}; search a smaller folder)` : '';
  const head = matches ? `${matches} matches for "${pattern}" in ${rel || '.'} (${files} files searched):` : `No match for "${pattern}" in ${rel || '.'} (${files} files searched).`;
  return { content: [{ type: 'text', text: cut(`${head}\n${hits.join('\n')}${more}${note}`).text }], details: { path: rel || '.', kind: 'search', matches, files } };
}

export const readTool: Tool = {
  name: 'read',
  description: `Read from your folder (the project's folder in a project chat; paths are relative to it). A file: the whole file when small; for a big file give offset (first line, 1-based) and limit (lines), or tail (last lines) — without them a big file returns its first ${DEFAULT_LINES} lines and its line count. A folder: lists its entries. With pattern: finds that text (any case) in the file or in every file under the folder, with line numbers. One answer is at most ${READ_OUTPUT_CHARS} characters. Environment files, keys, databases and credentials cannot be read.`,
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File or folder, relative to your folder ("." = the folder itself)' },
      offset: { type: 'number', description: 'First line to return (1-based)' },
      limit: { type: 'number', description: 'How many lines to return' },
      tail: { type: 'number', description: 'Return only the last N lines' },
      pattern: { type: 'string', description: 'Text to find in the file or folder' },
    },
    required: ['path'],
    examples: [
      { path: 'notes/meeting.md', description: 'Read a small file' },
      { path: 'docs/HANDOFF.md', tail: 40, description: 'The last 40 lines of a big file' },
      { path: 'docs/BACKLOG.md', pattern: 'CHAT-LIVE-01', description: 'Find a row in a big file' },
      { path: '.', description: 'List the folder' },
    ],
  },

  async execute(params, context): Promise<ToolResult> {
    const filePath = params?.path;
    try {
      let root = readRootFor(context);
      let rel = filePath;
      // CHAT-BUILD-01 stage 3: an absolute path inside the main folder or one of the project's added folders.
      if (typeof filePath === 'string' && path.isAbsolute(filePath)) {
        const hit = [root, ...(context?.extraReadRoots ?? [])].find((r) => { const x = path.relative(r, filePath); return !!x && !x.startsWith('..') && !path.isAbsolute(x); });
        if (hit) { root = hit; rel = path.relative(hit, filePath); }
      }
      const { real, rel: relPath } = resolveReadPath(root, rel);
      const st = fs.statSync(real);
      const pattern = typeof params?.pattern === 'string' && params.pattern.trim() ? params.pattern.trim().slice(0, 200) : null;
      if (pattern) return searchText(pattern, real, relPath, st.isDirectory());
      if (st.isDirectory()) return listFolder(real, relPath);
      if (!st.isFile()) throw new FileSandboxError('Not a regular file', 'not_a_file');
      const text = sandboxedReadText(real);
      const lines = text.split('\n');
      const tail = intOr(params?.tail, undefined, 1, 5000);
      const offset = intOr(params?.offset, undefined, 1, Number.MAX_SAFE_INTEGER);
      const limit = intOr(params?.limit, undefined, 1, 5000);
      const ranged = tail !== undefined || offset !== undefined || limit !== undefined;
      if (!ranged && text.length <= READ_OUTPUT_CHARS) {
        return { content: [{ type: 'text', text }], details: { path: relPath, size: st.size, modified: st.mtime, lines: lines.length } };
      }
      const from = tail !== undefined ? Math.max(1, lines.length - tail + 1) : (offset ?? 1);
      const count = tail !== undefined ? tail : (limit ?? DEFAULT_LINES);
      const part = lines.slice(from - 1, from - 1 + count);
      const to = from + part.length - 1;
      const body = cut(part.map((l, i) => `${from + i}\t${l}`).join('\n'));
      const head = `${relPath}: lines ${from}–${to} of ${lines.length}${body.cut ? ' (cut at the size limit; ask for fewer lines)' : ''}${!ranged ? '. Big file: give offset/limit, tail or pattern for other parts.' : ''}`;
      return { content: [{ type: 'text', text: `${head}\n${body.text}` }], details: { path: relPath, size: st.size, modified: st.mtime, lines: lines.length, from, to } };
    } catch (error: any) {
      const message = error instanceof FileSandboxError ? error.message : 'Failed to read file';
      if (!(error instanceof FileSandboxError)) console.error('[ReadTool] read failed:', error?.code ?? 'error');
      return {
        content: [{ type: 'text', text: `❌ ${message}` }],
        error: message,
      };
    }
  },
};
