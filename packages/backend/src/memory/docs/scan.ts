/**
 * Finding documents (KNOW-INDEX-01). Read only; never follows a link.
 *
 * A root is a folder the owner chose (a project's folders) or an agent's
 * knowledge folder. The walk:
 *   - starts at the root's real path (realpath) and never leaves it: every
 *     entry is lstat'ed, links (files or folders) are skipped, a file is read
 *     through readRegularFile with the root as its confinement (no link, the
 *     same inode as inspected, inside the root) and must have one name only
 *     (nlink 1: a hard link could reach a file outside)
 *   - skips hidden entries (.git, .env, .ssh, …), dependency and build
 *     folders, and anything whose name says secret, credential, password,
 *     token or private key, and key files (*.pem, *.key, id_rsa…)
 *   - takes .md / .markdown / .txt / .pdf and (MEM-READ-01 MR8) .docx .xlsx .pptx .odt .ods
 *     .odp .csv .rtf .html .json .yaml, with size caps; old .doc/.xls/.ppt and archives are
 *     listed as not read, with the reason
 *   - stops at MAX_FILES files, MAX_ENTRIES entries or MAX_DEPTH levels
 *     (the result says it was limited)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { readRegularFile } from '../../services/read-regular-file.js';
import { libraryDirName } from '../import/library-folders.js';
import { NOT_READ_EXT, OFFICE_EXT, type OfficeKind } from './office-text.js';

export const MAX_FILES = 500;
export const MAX_ENTRIES = 20_000;
export const MAX_DEPTH = 8;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

export type DocKind = 'md' | 'txt' | 'pdf' | OfficeKind | 'notread';

const SKIP_DIRS = /^(?:node_modules|bower_components|vendor|dist|build|out|coverage|target|venv|env|__pycache__|site-packages|Pods|DerivedData|tmp|temp|logs?)$/i;
const SECRET_NAME = /(?:^|[._ -])(?:secrets?|credentials?|passwords?|passwd|tokens?|private[-_ ]?keys?|api[-_ ]?keys?|\.?env)(?:[._ -]|$)/i;
const KEY_FILE = /(?:^id_(?:rsa|dsa|ecdsa|ed25519)|\.(?:pem|key|p12|pfx|keystore|jks|kdbx|asc|gpg))$/i;

export function docKindOf(name: string): DocKind | null {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'md';
  if (ext === '.txt') return 'txt';
  if (ext === '.pdf') return 'pdf';
  if (OFFICE_EXT[ext]) return OFFICE_EXT[ext];
  if (NOT_READ_EXT[ext]) return 'notread';
  return null;
}

/** True for a name that must never be read (hidden, secret-looking, key file). */
export function skippedName(name: string): boolean {
  return name.startsWith('.') || SECRET_NAME.test(name) || KEY_FILE.test(name);
}

/** Size cap per kind: PDFs and zip-based office files up to 20 MB, text up to 2 MB. */
export const maxBytes = (k: DocKind) => (k === 'pdf' || k === 'docx' || k === 'xlsx' || k === 'pptx' || k === 'odt' || k === 'ods' || k === 'odp' ? MAX_PDF_BYTES : k === 'notread' ? Number.MAX_SAFE_INTEGER : MAX_TEXT_BYTES);

export interface FoundFile { root: string; rel: string; kind: DocKind; bytes: number; mtimeMs: number }
export interface ScanResult { root: string | null; files: FoundFile[]; limited: boolean; missingRoot: boolean }

/** The documents under one root (real path), in a stable order. */
export async function scanRoot(rootInput: string): Promise<ScanResult> {
  let root: string;
  try {
    root = await fs.realpath(rootInput);
    const st = await fs.stat(root);
    if (!st.isDirectory() || root === path.parse(root).root) return { root: null, files: [], limited: false, missingRoot: true };
  } catch { return { root: null, files: [], limited: false, missingRoot: true }; }
  const files: FoundFile[] = [];
  let entries = 0;
  let limited = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let items: import('node:fs').Dirent[];
    try { items = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const it of items) {
      if (++entries > MAX_ENTRIES || files.length >= MAX_FILES) { limited = true; return; }
      if (it.isSymbolicLink() || skippedName(it.name)) continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (SKIP_DIRS.test(it.name) || libraryDirName(it.name, dir)) continue;
        if (depth >= MAX_DEPTH) { limited = true; continue; }
        await walk(full, depth + 1);
        continue;
      }
      if (!it.isFile()) continue;
      const kind = docKindOf(it.name);
      if (!kind) continue;
      let st: import('node:fs').Stats;
      try { st = await fs.lstat(full); } catch { continue; }
      if (!st.isFile() || st.nlink !== 1) continue;
      if (st.size > maxBytes(kind)) { limited = true; continue; }
      files.push({ root, rel: path.relative(root, full), kind, bytes: st.size, mtimeMs: Math.floor(st.mtimeMs) });
    }
  };
  await walk(root, 0);
  return { root, files, limited, missingRoot: false };
}

/** Read one found file, confined to its root. Null when it changed into something unsafe. */
export async function readFound(f: FoundFile): Promise<Buffer | null> {
  const full = path.join(f.root, f.rel);
  const rel = path.relative(f.root, path.resolve(full));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    if (f.kind === 'notread') return Buffer.alloc(0);
    const r = await readRegularFile(full, maxBytes(f.kind), { root: f.root });
    if (r.stat.nlink !== 1) return null;
    return Buffer.from(r.data);
  } catch { return null; }
}
