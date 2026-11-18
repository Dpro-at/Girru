/**
 * CODE-OPEN-01: which file "Open in Code" may open (board C1–C3).
 *
 * One check for every place that names a file (the window's rows, the agents'
 * MCP tool): the path must be an absolute path to a regular file inside one of
 * the owner's projects (its main folder or an added folder) or inside Girru's
 * data folder. The real path is checked and links are not followed: a path
 * whose real path differs from the path given (inside its root) is refused, so
 * a link in a project cannot reach a file outside it. Keys, environment files
 * and databases are never opened.
 *
 * The answer names the root folder and the file relative to it, which is what
 * the desktop's Code page opens (it checks the same again), plus whether Girru
 * writes the file (its edits come back to Girru as a review).
 */

import fs from 'node:fs';
import path from 'node:path';
import { listProjects } from '../repositories/chat-conversations.js';
import { dataRoot } from '../config/data-root.js';
import { MANAGED_FILES } from '../memory/bridge/managed-files.js';
import { CURSOR_RULE } from '../memory/bridge/layout.js';
import { TASKS_FILE } from './task-file.js';

export class CodeOpenError extends Error {
  constructor(message: string, readonly status: number, readonly code: 'invalid' | 'outside' | 'not_found' | 'not_allowed') { super(message); }
}

export interface CodeTarget {
  /** The real root folder (a project folder or the data folder). */
  folder: string;
  /** The file relative to `folder` ('/' separated). */
  file: string;
  /** The absolute real path of the file. */
  path: string;
  line: number | null;
  /** Girru writes this file: edits come back to Girru as a review. */
  generated: boolean;
  where: 'project' | 'data';
  /** The project's name (where = project). */
  project: string | null;
}

export const MAX_LINE = 10_000_000;
/** Never opened, wherever they are (the desktop refuses the same names). */
const SECRET = /^\.env(?:\.|$)|\.(?:pem|key|p12|pfx|keystore|jks)$|^id_(?:rsa|ed25519|ecdsa|dsa)|^\.?secrets?(?:[.-]|$)|\.(?:db|sqlite|sqlite3|db-wal|db-shm)$/i;
const GENERATED = new Set<string>([...MANAGED_FILES, TASKS_FILE, CURSOR_RULE]);

const realDir = (p: string): string | null => {
  try { const r = fs.realpathSync.native(p); return fs.statSync(r).isDirectory() ? r : null; } catch { return null; }
};

/** `abs` inside `root` (given as it is stored and as its real path): the part below the root, or null. */
function below(abs: string, rawRoot: string, realRoot: string): string | null {
  for (const r of new Set([path.resolve(rawRoot), realRoot])) {
    const rel = path.relative(r, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return null;
}

/** The roots the owner may open files from: projects with a folder on this computer, then the data folder. */
async function roots(ownerId: string): Promise<Array<{ raw: string; real: string; where: 'project' | 'data'; project: string | null }>> {
  const out: Array<{ raw: string; real: string; where: 'project' | 'data'; project: string | null }> = [];
  for (const p of await listProjects(ownerId)) {
    for (const raw of [p.folder, ...p.folders.map((f) => f.path)]) {
      if (!raw || !path.isAbsolute(raw)) continue;
      const real = realDir(raw);
      if (real) out.push({ raw, real, where: 'project', project: p.name });
    }
  }
  const data = realDir(dataRoot());
  if (data) out.push({ raw: dataRoot(), real: data, where: 'data', project: null });
  return out;
}

/** Checks a path for "Open in Code"; throws CodeOpenError when it may not be opened. */
export async function codeTarget(ownerId: string, input: { path?: unknown; line?: unknown }): Promise<CodeTarget> {
  const raw = input.path;
  if (typeof raw !== 'string' || !raw || raw.length > 4096 || /[\x00-\x1f]/.test(raw) || !path.isAbsolute(raw)) throw new CodeOpenError('Give the full path of a file', 400, 'invalid');
  const line = input.line === undefined || input.line === null ? null : input.line;
  if (line !== null && (!Number.isSafeInteger(line) || (line as number) < 1 || (line as number) > MAX_LINE)) throw new CodeOpenError('The line must be a whole number from 1', 400, 'invalid');
  const abs = path.resolve(raw);
  let real: string;
  try { real = fs.realpathSync.native(abs); } catch { throw new CodeOpenError('This file is not on this computer', 404, 'not_found'); }
  for (const r of await roots(ownerId)) {
    const rel = below(abs, r.raw, r.real);
    if (rel === null) continue;
    // No links: inside its root the path must already be the real path.
    if (path.join(r.real, rel) !== real) throw new CodeOpenError('This file is outside your projects', 403, 'outside');
    let st: fs.Stats;
    try { st = fs.lstatSync(real); } catch { throw new CodeOpenError('This file is not on this computer', 404, 'not_found'); }
    if (!st.isFile()) throw new CodeOpenError('Only a file opens in Code', 422, 'not_allowed');
    const parts = rel ? rel.split(path.sep) : [];
    if (parts.some((x) => x === '..' || SECRET.test(x))) throw new CodeOpenError('Keys, environment files and databases do not open in Code', 403, 'not_allowed');
    const file = parts.join('/');
    const generated = r.where === 'data' ? /\.(?:md|json|txt)$/i.test(file) : GENERATED.has(file) || file.startsWith('.girru/');
    return { folder: r.real, file, path: real, line: line as number | null, generated, where: r.where, project: r.project };
  }
  throw new CodeOpenError('This file is outside your projects', 403, 'outside');
}
