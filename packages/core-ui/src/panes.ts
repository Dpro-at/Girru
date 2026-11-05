import type { OfficePayload } from './office-content';
import { mediaKind } from './file-content';
import type { SessionClient } from './session';
import { panePath } from './conversation-contract.js';
import type { WireChanges, WireDiff, WireFile, WireTree } from './conversation-contract.js';

export type PaneName = 'details' | 'changes' | 'files' | 'terminal';
/** CH4/CH8: a diff in one column ("unified") or old beside new ("split"); kept per person with the side panel's layout. */
export type DiffView = 'unified' | 'split';
export const DIFF_VIEW_PATH = '/api/chat/panel';
/** Below this pane width Side by side shows as one column; the choice is kept. */
export const SPLIT_MIN_WIDTH = 520;
/** CHAT-CONTENT-01: a PDF's pages as text (or why it cannot be shown). */
export type WireMedia = { path: string; size: number; mime?: string; base64?: string; reason?: string };
export type WirePdf = { path: string; pageCount: number; pages: { page: number; text: string }[] } | { path: string; reason: string };
type Load<T> = { phase: 'loading' } | { phase: 'ready'; data: T } | { phase: 'error'; message: string };
export type PanesState = Readonly<{
  projectId: string | null;
  changes?: Load<WireChanges>;
  /** Open diffs, by file path. */
  diffs: Readonly<Record<string, Load<WireDiff>>>;
  /** Loaded folder levels, by relative path ("" is the project folder). */
  tree: Readonly<Record<string, Load<WireTree>>>;
  expanded: readonly string[];
  file?: { path: string; load: Load<WireFile>; pdf?: Load<WirePdf>; media?: Load<WireMedia>; office?: Load<OfficePayload>; diff?: Load<WireDiff>; mark?: string };
  diffView: DiffView;
}>;

const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const reason = (status: number, body: unknown) => record(body) && body.code === 'no_folder' ? 'This project has no folder.' : status === 404 ? 'Not found.' : status === 400 ? 'That path cannot be opened.' : 'Could not load it.';

/** Read-only views of the active project's folder: git changes, diffs, folders and files. */
export class PanesController {
  #state: PanesState = Object.freeze({ projectId: null, diffs: {}, tree: {}, expanded: [], diffView: 'unified' });
  #diffViewLoaded = false;
  #listeners = new Set<() => void>();
  #disposed = false;
  constructor(private readonly client: SessionClient) {}
  getSnapshot = () => this.#state;
  subscribe = (fn: () => void) => { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; };
  private publish(p: Partial<PanesState>) { if (this.#disposed) return; this.#state = Object.freeze({ ...this.#state, ...p }); this.#listeners.forEach(fn => fn()); }
  dispose() { this.#disposed = true; this.#listeners.clear(); }
  private async get<T>(path: string): Promise<Load<T>> {
    try {
      const r = await this.client.request({ method: 'GET', path } as never);
      return r.status === 200 && record(r.body) ? { phase: 'ready', data: r.body as T } : { phase: 'error', message: reason(r.status, r.body) };
    } catch { return { phase: 'error', message: 'No connection.' }; }
  }
  /** Switches to another project (or none): everything loaded before is dropped. */
  setProject(projectId: string | null) {
    if (projectId === this.#state.projectId) return;
    this.#state = Object.freeze({ projectId, diffs: {}, tree: {}, expanded: [], diffView: this.#state.diffView }); this.#listeners.forEach(fn => fn());
  }
  /** Reads the person's diff view once from the server (never browser storage). */
  async loadDiffView() {
    if (this.#diffViewLoaded) return; this.#diffViewLoaded = true;
    try { const r = await this.client.request({ method: 'GET', path: DIFF_VIEW_PATH } as never); const v = record(r.body) && record(r.body.panel) ? r.body.panel.diff : undefined;
      if (r.status === 200 && (v === 'split' || v === 'unified')) this.publish({ diffView: v }); } catch { /* one column */ }
  }
  /** Shows the choice at once and saves only this field; the panel order and folds stay as they are on the server. */
  setDiffView(v: DiffView) {
    if (v === this.#state.diffView) return; this.#diffViewLoaded = true; this.publish({ diffView: v });
    void this.client.request({ method: 'PUT', path: DIFF_VIEW_PATH, body: { diff: v } } as never).catch(() => undefined);
  }
  private current(id: string) { return !this.#disposed && this.#state.projectId === id; }

  async loadChanges() {
    const id = this.#state.projectId; if (!id) return;
    this.publish({ changes: { phase: 'loading' } });
    const r = await this.get<WireChanges>(`/api/chat/projects/${id}/changes`);
    if (this.current(id)) this.publish({ changes: r, diffs: {} });
  }
  async toggleDiff(path: string) {
    const id = this.#state.projectId; if (!id) return;
    if (this.#state.diffs[path]) { const { [path]: _gone, ...rest } = this.#state.diffs; this.publish({ diffs: rest }); return; }
    this.publish({ diffs: { ...this.#state.diffs, [path]: { phase: 'loading' } } });
    const r = await this.get<WireDiff>(panePath(id, 'diff', path));
    if (this.current(id) && this.#state.diffs[path]) this.publish({ diffs: { ...this.#state.diffs, [path]: r } });
  }
  async loadFolder(rel = '') {
    const id = this.#state.projectId; if (!id) return;
    this.publish({ tree: { ...this.#state.tree, [rel]: { phase: 'loading' } } });
    const r = await this.get<WireTree>(panePath(id, 'tree', rel));
    if (this.current(id)) this.publish({ tree: { ...this.#state.tree, [rel]: r } });
  }
  async toggleFolder(rel: string) {
    const open = this.#state.expanded.includes(rel);
    this.publish({ expanded: open ? this.#state.expanded.filter(x => x !== rel) : [...this.#state.expanded, rel] });
    if (!open && !this.#state.tree[rel]) await this.loadFolder(rel);
  }
  /** Opens a file in the viewer; a PDF opens as its pages, `mark` is text to find and mark (what the agent quoted). */
  async openFile(path: string, options: { mark?: string } = {}) {
    const id = this.#state.projectId; if (!id) return;
    const mark = options.mark?.trim().slice(0, 200) || undefined;
    this.publish({ file: { path, load: { phase: 'loading' }, ...(mark ? { mark } : {}) } });
    if (/\.(docx|xlsx|pptx)$/i.test(path)) {
      const office = await this.get<OfficePayload>(panePath(id, 'office', path));
      if (this.current(id) && this.#state.file?.path === path) this.publish({ file: { ...this.#state.file, load: { phase: 'ready', data: { path, text: null, size: 0, binary: true, hidden: office.phase === 'ready' && office.data.reason === 'hidden', truncated: false } }, office } });
      return;
    }
    if (mediaKind(path)) {
      const media = await this.get<WireMedia>(panePath(id, 'media', path));
      if (this.current(id) && this.#state.file?.path === path) this.publish({ file: { ...this.#state.file, load: { phase: 'ready', data: { path, text: null, size: media.phase === 'ready' ? media.data.size : 0, binary: true, hidden: media.phase === 'ready' && media.data.reason === 'hidden', truncated: false } }, media } });
      return;
    }
    if (/\.pdf$/i.test(path)) {
      const pdf = await this.get<WirePdf>(panePath(id, 'pdf', path));
      if (this.current(id) && this.#state.file?.path === path) this.publish({ file: { ...this.#state.file, load: { phase: 'ready', data: { path, text: null, size: 0, binary: true, hidden: false, truncated: false } as WireFile }, pdf } });
      return;
    }
    const r = await this.get<WireFile>(panePath(id, 'file', path));
    if (this.current(id) && this.#state.file?.path === path) this.publish({ file: { ...this.#state.file, load: r } });
  }
  /** The open file's changes (the viewer's Changes tab), from the same diff as the Changes pane. */
  async loadFileDiff() {
    const id = this.#state.projectId, f = this.#state.file; if (!id || !f || f.diff) return;
    this.publish({ file: { ...f, diff: { phase: 'loading' } } });
    const r = await this.get<WireDiff>(panePath(id, 'diff', f.path));
    if (this.current(id) && this.#state.file?.path === f.path) this.publish({ file: { ...this.#state.file, diff: r } });
  }
  closeFile() { this.publish({ file: undefined }); }
  /** Reloads what is open: the change list, the root folder and open folders. */
  async refresh() {
    this.publish({ tree: {} });
    await Promise.all([this.loadChanges(), this.loadFolder(''), ...this.#state.expanded.map(r => this.loadFolder(r))]);
  }
}

export type DiffLine = ReturnType<typeof diffLines>[number];
type SplitSide = { kind: 'ctx' | 'del' | 'add'; text: string; no: number };
export type SplitRow = { kind: 'hunk' | 'meta'; text: string } | { kind: 'pair'; left: SplitSide | null; right: SplitSide | null };
/** Side by side: context on both sides; a run of removed lines is paired with the added lines after it, the shorter side padded. */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const out: SplitRow[] = []; let del: SplitSide[] = [], add: SplitSide[] = [];
  const flush = () => { for (let i = 0; i < Math.max(del.length, add.length); i++) out.push({ kind: 'pair', left: del[i] ?? null, right: add[i] ?? null }); del = []; add = []; };
  for (const l of lines) {
    if (l.kind === 'del') { if (add.length) flush(); del.push({ kind: 'del', text: l.text, no: l.old! }); }
    else if (l.kind === 'add') add.push({ kind: 'add', text: l.text, no: l.new! });
    else { flush(); out.push(l.kind === 'ctx' ? { kind: 'pair', left: { kind: 'ctx', text: l.text, no: l.old! }, right: { kind: 'ctx', text: l.text, no: l.new! } } : { kind: l.kind, text: l.text }); }
  }
  flush(); return out;
}

/** Splits a unified diff into typed lines for display (hunk headers keep their line numbers). */
export function diffLines(diff: string): { kind: 'add' | 'del' | 'hunk' | 'meta' | 'ctx'; text: string; old?: number; new?: number }[] {
  const out: { kind: 'add' | 'del' | 'hunk' | 'meta' | 'ctx'; text: string; old?: number; new?: number }[] = [];
  let o = 0, n = 0, inHunk = false;
  for (const line of diff.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) { o = Number(h[1]); n = Number(h[2]); inHunk = true; out.push({ kind: 'hunk', text: line }); continue; }
    if (!inHunk) { if (line && !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename )/.test(line)) out.push({ kind: 'meta', text: line }); continue; }
    if (line.startsWith('+')) out.push({ kind: 'add', text: line.slice(1), new: n++ });
    else if (line.startsWith('-')) out.push({ kind: 'del', text: line.slice(1), old: o++ });
    else if (line.startsWith('\\')) out.push({ kind: 'meta', text: line });
    else if (line.startsWith(' ')) out.push({ kind: 'ctx', text: line.slice(1), old: o++, new: n++ });
    else if (line.startsWith('diff --git')) inHunk = false;
  }
  return out;
}
