/**
 * Undo what an agent changed (CHAT-BUILD-01 stage 5, CH10). Before and after
 * a reply in a git folder, the folder is snapshotted into a git tree through a
 * temporary index (no commit, no change to the real index or branch). Undo
 * puts the files the reply changed back to the "before" tree; Redo to the
 * "after" tree. Either refuses when one of those files changed since.
 */
import { execFile } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { minimalChildEnv } from '../tools/exec-policy.js';

const TREE = /^[0-9a-f]{40,64}$/;
/** git's empty tree: attributes are read from it, so a repository's .gitattributes cannot name a filter program. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export class CheckpointError extends Error {}

/** A project's own git config never makes these calls start a program (fsmonitor, hooks, filters, pagers). */
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false', '-c', 'core.pager=cat', '-c', 'core.attributesFile=/dev/null', '-c', 'diff.external=', '--no-pager'];
/** Files a snapshot never copies into git's object store (keys and secrets that are not ignored). */
const NEVER = ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*', 'secrets.env', 'credentials*', '.credentials.json', '.npmrc', '.netrc', '.git-credentials', '.pgpass', 'auth.json'];
function git(folder: string, args: string[], index?: string): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', [...SAFE, ...args], {
    cwd: folder, timeout: 20_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    // No system or global config, no attributes (so no filter or textconv programs).
    env: minimalChildEnv({ ...(index ? { GIT_INDEX_FILE: index } : {}), GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_SOURCE: EMPTY_TREE, GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }),
  }, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))));
}
const literal = (p: string) => `:(literal)${p}`;
let version: Promise<[number, number] | null> | null = null;
/** True when the installed git is at least major.minor (GIT_ATTR_SOURCE needs 2.40). */
async function gitAtLeast(major: number, minor: number): Promise<boolean> {
  version ??= git(tmpdir(), ['--version']).then((v) => { const m = /(\d+)\.(\d+)/.exec(v); return m ? [Number(m[1]), Number(m[2])] as [number, number] : null; }, () => null);
  const v = await version;
  return !!v && (v[0] > major || (v[0] === major && v[1] >= minor));
}

/** The project folder's files as a git tree, or null when there is none (see snapshotState). */
export async function snapshot(folder: string): Promise<string | null> {
  const s = await snapshotState(folder);
  return s === 'blocked' ? null : s;
}

/** The project folder's files as a git tree; null when it is not a git folder (or git fails); 'blocked' when git
 * here could start a program (no undo then). Only the chosen folder (not the rest of its repository) and never
 * secret-looking files. */
export async function snapshotState(folder: string): Promise<string | 'blocked' | null> {
  let dir: string | undefined;
  try {
    if ((await git(folder, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') return null;
    const top = (await git(folder, ['rev-parse', '--show-toplevel'])).trim();
    const rel = path.relative(realpathSync(top), realpathSync(folder)).split(path.sep).join('/');
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    // Fail closed: git too old to read attributes from the empty tree, a filter defined in the repository's own
    // config, or an info/attributes file that names one (found the way git finds it, also in worktrees and submodules).
    if (!(await gitAtLeast(2, 40))) return 'blocked';
    if ((await git(top, ['config', '--local', '--get-regexp', '^filter\\.']).catch((e: { code?: number }) => (e?.code === 1 ? '' : 'unknown'))).trim()) return 'blocked';
    const attributes = path.resolve(top, (await git(top, ['rev-parse', '--git-path', 'info/attributes'])).trim());
    try { if (/filter/i.test(readFileSync(attributes, 'utf8'))) return 'blocked'; }
    catch (err) { if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return 'blocked'; }
    dir = mkdtempSync(path.join(tmpdir(), 'girru-ckpt-'));
    const index = path.join(dir, 'index');
    // Start from the real index (fast), then add every file git sees in the folder; the real index is never touched.
    // The copy keeps the real index's times: git then still re-reads files changed in the same second (racily clean).
    try { const real = path.resolve(top, (await git(top, ['rev-parse', '--git-path', 'index'])).trim()); const t = statSync(real); copyFileSync(real, index); utimesSync(index, t.atime, t.mtime); }
    catch { try { unlinkSync(index); } catch { /* an empty index works too */ } }
    const scope = rel || '.';
    await git(top, ['add', '-A', '--', scope, ...NEVER.map((n) => `:(exclude,glob)${rel ? `${rel}/` : ''}**/${n}`)], index);
    const tree = (await git(top, ['write-tree'], index)).trim();
    return TREE.test(tree) ? `${top}\u0000${tree}\u0000${rel}` : null;
  } catch { return null; }
  finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
}

const split = (ckpt: string) => { const [top, tree, rel = ''] = ckpt.split('\u0000'); if (!top || !TREE.test(tree ?? '')) throw new CheckpointError('Bad checkpoint'); return { top, tree, rel }; };

/** Files of the project folder that differ between two snapshots: status A (added), D (deleted) or M. */
export async function changedFiles(before: string, after: string): Promise<{ status: string; path: string }[]> {
  const a = split(before), b = split(after);
  if (a.top !== b.top || a.rel !== b.rel) throw new CheckpointError('Different folders');
  const out = await git(a.top, ['diff', '--no-renames', '--name-status', '-z', a.tree, b.tree, '--', ...(a.rel ? [literal(a.rel)] : [])]);
  const parts = out.split('\u0000').filter(Boolean);
  const files: { status: string; path: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i][0], path: parts[i + 1] });
  return files;
}

/** Lines added and removed between two snapshots of the same folder (binary files count as none). */
export async function lineCounts(before: string, after: string): Promise<{ added: number; removed: number }> {
  const a = split(before), b = split(after);
  if (a.top !== b.top || a.rel !== b.rel) throw new CheckpointError('Different folders');
  const out = await git(a.top, ['diff', '--no-renames', '--numstat', '-z', a.tree, b.tree, '--', ...(a.rel ? [literal(a.rel)] : [])]);
  let added = 0, removed = 0;
  for (const row of out.split('\u0000')) {
    const m = /^(\d+)\t(\d+)\t/.exec(row);
    if (m) { added += Number(m[1]); removed += Number(m[2]); }
  }
  return { added, removed };
}

/** TASKPAGE-02: each changed file with its line counts and its changed lines (short, for the task page; binary files have none). */
export interface FileDiff { path: string; status: string; added: number; removed: number; lines: string[]; more: boolean }
export async function fileDiffs(before: string, after: string, opts: { files?: number; lines?: number } = {}): Promise<FileDiff[]> {
  const a = split(before), b = split(after);
  if (a.top !== b.top || a.rel !== b.rel) throw new CheckpointError('Different folders');
  const scope = a.rel ? [literal(a.rel)] : [];
  const counts = new Map<string, { added: number; removed: number }>();
  for (const row of (await git(a.top, ['diff', '--no-renames', '--numstat', '-z', a.tree, b.tree, '--', ...scope])).split('\u0000')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(row);
    if (m) counts.set(m[3], { added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]) });
  }
  const out: FileDiff[] = [];
  for (const f of (await changedFiles(before, after)).slice(0, opts.files ?? 20)) {
    // --no-ext-diff and --no-textconv: no program the repository names ever runs for the text.
    const text = await git(a.top, ['diff', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', '-U2', a.tree, b.tree, '--', literal(f.path)]).catch(() => '');
    const body = text.split('\n').filter((l) => /^[+\- ]/.test(l) && !l.startsWith('+++') && !l.startsWith('---'));
    const max = opts.lines ?? 60;
    out.push({ path: f.path, status: f.status, ...(counts.get(f.path) ?? { added: 0, removed: 0 }), lines: body.slice(0, max).map((l) => l.slice(0, 300)), more: body.length > max });
  }
  return out;
}

/** Puts the files changed between `from` and `to` back to `to` (Undo: from=after, to=before). */
export async function restore(from: string, to: string): Promise<number> {
  const files = await changedFiles(to, from);
  if (!files.length) return 0;
  const { top, rel } = split(from);
  const now = await snapshot(rel ? path.join(top, rel) : top);
  if (!now) throw new CheckpointError('The folder is not available');
  const moved = await git(top, ['diff', '--no-renames', '--name-only', '-z', split(from).tree, split(now).tree, '--', ...files.map((f) => literal(f.path))]);
  if (moved.replace(/\u0000/g, '').trim()) throw new CheckpointError('Some of these files changed since; nothing was undone');
  const inside = path.resolve(top, rel);
  for (const f of files) {
    const abs = path.resolve(top, f.path);
    if (abs !== inside && !abs.startsWith(inside + path.sep)) continue;
    // A file the change added (status A between to→from) is removed; the others come back from `to`.
    if (f.status === 'A') { try { unlinkSync(abs); } catch { /* already gone */ } }
    else await git(top, ['restore', `--source=${split(to).tree}`, '--worktree', '--', literal(f.path)]);
  }
  return files.length;
}


/** Per-reply review uses immutable checkpoint trees, never the current working folder's changes. */
export async function checkpointChanges(before:string,after:string){
 const a=split(before),b=split(after);if(a.top!==b.top||a.rel!==b.rel)throw new CheckpointError('Different folders');
 const counts=new Map<string,{added:number|null;removed:number|null}>();
 for(const row of (await git(a.top,['diff','--no-renames','--numstat','-z',a.tree,b.tree,'--',...(a.rel?[literal(a.rel)]:[])])).split('\0')){
  const match=/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row);if(match)counts.set(match[3],{added:match[1]==='-'?null:Number(match[1]),removed:match[2]==='-'?null:Number(match[2])});
 }
 const files=await changedFiles(before,after);return{branch:null,notGit:false,truncated:files.length>1000,changes:files.slice(0,1000).map(file=>({path:a.rel?path.posix.relative(a.rel,file.path):file.path,status:file.status==='A'?'added':file.status==='D'?'deleted':'modified',...(counts.get(file.path)??{added:null,removed:null})}))};
}
export async function checkpointFileDiff(before:string,after:string,rel:string){
 const a=split(before),b=split(after);if(a.top!==b.top||a.rel!==b.rel||!rel||rel.length>1024||rel.includes('\0')||rel.includes('\\')||path.posix.isAbsolute(rel)||rel.split('/').some(part=>!part||part==='.'||part==='..'))throw new CheckpointError('Invalid file');
 const file=a.rel?path.posix.join(a.rel,rel):rel;
 if(!(await changedFiles(before,after)).some(item=>item.path===file))throw new CheckpointError('File not in reply');
 const hidden=rel.split('/').some(name=>/^\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$|^id_(?:rsa|ed25519|ecdsa)|^credentials|^(?:secrets\.env|\.credentials\.json|\.npmrc|\.netrc|\.git-credentials|\.pgpass|auth\.json)$/i.test(name));
 if(hidden)return{path:rel,diff:'',hidden:true,binary:false,truncated:false};
 const diff=await git(a.top,['diff','--no-renames','--no-color','--no-ext-diff','--no-textconv','-U3',a.tree,b.tree,'--',literal(file)]);
 return{path:rel,diff:diff.slice(0,400000),hidden:false,binary:/^Binary files /m.test(diff),truncated:diff.length>400000};
}

/** CP10: the work between two snapshots as one binary-safe patch (paths relative to the repository) with each file's line counts. */
export async function checkpointPatch(before: string, after: string, maxBytes = 3 * 1024 * 1024): Promise<{ top: string; rel: string; patch: string; files: { path: string; added: number; removed: number }[] }> {
  const a = split(before), b = split(after);
  if (a.top !== b.top || a.rel !== b.rel) throw new CheckpointError('Different folders');
  const scope = ['--', ...(a.rel ? [literal(a.rel)] : [])];
  const stat = await git(a.top, ['diff', '--no-renames', '--numstat', '-z', a.tree, b.tree, ...scope]);
  const files: { path: string; added: number; removed: number }[] = [];
  for (const row of stat.split('\u0000')) { const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(row); if (m) files.push({ path: m[3], added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]) }); }
  if (!files.length) return { top: a.top, rel: a.rel, patch: '', files };
  const patch = await new Promise<string>((resolve, reject) => execFile('git', [...SAFE, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index', a.tree, b.tree, ...scope], {
    cwd: a.top, timeout: 30_000, maxBuffer: maxBytes + 1, windowsHide: true,
    env: minimalChildEnv({ GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_SOURCE: EMPTY_TREE, GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }),
  }, (err, stdout) => (err ? reject(new CheckpointError('too_large_or_failed')) : resolve(String(stdout)))));
  return { top: a.top, rel: a.rel, patch, files: files.slice(0, 500) };
}
