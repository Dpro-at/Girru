import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { diffLines, splitRows, SPLIT_MIN_WIDTH } from './panes';
import type { DiffView as DiffViewName, PanesController } from './panes';
import { UiIcon } from './ui-icons';
import { ContextMenu, useMenu } from './desktop-ui';
import { OpenInCodeIcon, fileMenu } from './CodeOpen';
import { joinPath } from './code-open';
import { Markdown } from './markdown';
import { fileKind, mediaKind } from './file-content';
import { OfficeContent } from './OfficeContent';
import { MediaContent, JsonContent, CsvContent } from './FileContent';
type CodeRequester = Parameters<typeof fileMenu>[0];

/** Names that usually hold secrets: shown locked; Girru does not open them (the server checks again). */
const SECRET = /^\.env(\..*)?$|\.(pem|key|p12|pfx)$|^id_(rsa|ed25519|ecdsa)/i;
const STATUS: Record<string, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U' };
const size = (b: number | null) => b === null ? '' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB` : `${(b / 1048576).toFixed(1)} MB`;

/** Uncommitted changes per file; a file opens its diff in place. */
export function ChangesPane({ panes, client, folder }: { panes: PanesController; client?: CodeRequester; folder?: string | null }) {
  const s = useSyncExternalStore(panes.subscribe, panes.getSnapshot, panes.getSnapshot);
  // CODE-OPEN-01: each changed file opens in Code at its first changed line (when its diff is loaded); right-click for the same.
  const [said, say] = useState<string | null>(null);
  const fm = useMenu();
  const firstLine = (p: string) => { const d = s.diffs[p]; if (d?.phase !== 'ready' || !d.data.diff) return null; return diffLines(d.data.diff).find(l => l.kind === 'add' || l.kind === 'del')?.new ?? diffLines(d.data.diff).find(l => l.kind === 'del')?.old ?? null; };
  useEffect(() => { if (s.projectId && !s.changes) void panes.loadChanges(); }, [panes, s.projectId, s.changes]);
  useEffect(() => { void panes.loadDiffView(); }, [panes]);
  // Side by side needs room: a narrow pane shows one column and keeps the choice.
  const box = useRef<HTMLDivElement>(null); const [width, setWidth] = useState(Infinity);
  useEffect(() => { const b = box.current; if (!b || typeof ResizeObserver === 'undefined') return; const o = new ResizeObserver(() => setWidth(b.clientWidth || Infinity)); o.observe(b); setWidth(b.clientWidth || Infinity); return () => o.disconnect(); }, [s.projectId]);
  const narrow = width < SPLIT_MIN_WIDTH, view: DiffViewName = s.diffView === 'split' && !narrow ? 'split' : 'unified';
  useEffect(()=>{if(s.focusPath){const row=Array.from(box.current?.querySelectorAll<HTMLElement>('[data-reply-path]')??[]).find(row=>row.dataset.replyPath===s.focusPath);row?.scrollIntoView?.({block:'nearest'});}},[s.focusPath,s.diffs]);
  if (!s.projectId&&!s.reply) return <p className="pane-empty">Pick a project with a folder to see its changes.</p>;
  const c = s.changes;
  const data = c?.phase === 'ready' ? c.data : null;
  const total = data?.changes.reduce((t, x) => [t[0] + (x.added ?? 0), t[1] + (x.removed ?? 0)], [0, 0]);
  return <div className="pane" aria-label="Changes" ref={box} data-diff={view}>
    <div className="pane-head">
      {s.reply&&<span className="pane-branch">Changes in this reply</span>}
      {/* CH4: the branch on the left, the line counts on the right. */}
      {data?.branch && <span className="pane-branch" dir="ltr" title={`${data.changes.length} ${data.changes.length === 1 ? 'file' : 'files'} changed`}><UiIcon name="branch" size={13}/>{data.branch}</span>}
      {data && total && data.changes.length > 0 && <span className="pane-sum"><span className="plus">+{total[0]}</span> <span className="minus">−{total[1]}</span></span>}
      {data && data.changes.length > 0 && <span className="dk-segmented diff-switch" role="radiogroup" aria-label="Diff view" title={narrow && s.diffView === 'split' ? 'Side by side needs a wider pane; showing one column.' : undefined}>
        {([['unified', 'One column'], ['split', 'Side by side']] as const).map(([v, t]) => <button type="button" key={v} role="radio" aria-checked={s.diffView === v} aria-pressed={s.diffView === v} onClick={() => panes.setDiffView(v)}>{t}</button>)}
      </span>}
      <button type="button" className="row-tool pane-refresh" aria-label="Reload changes" title="Reload" onClick={() => void panes.loadChanges()}><UiIcon name="refresh" size={12}/></button>
    </div>
    {!c || c.phase === 'loading' ? <p className="pane-empty">Loading…</p>
      : c.phase === 'error' ? <p className="pane-empty error">{c.message}</p>
      : c.data.notGit ? <p className="pane-empty">This folder is not a git repository.</p>
      : !c.data.changes.length ? <p className="pane-empty">No uncommitted changes.</p>
      : <ul className="change-list">{c.data.changes.map(f => {
        const d = s.diffs[f.path]; const slash = f.path.lastIndexOf('/');
        const abs = client && folder && f.status !== 'deleted' ? joinPath(folder, f.path) : null;
        return <li key={f.path} data-reply-path={f.path} data-open={d ? true : undefined} className="dk-file-row" onContextMenu={abs ? e => fm.at(e, fileMenu(client!, abs, firstLine(f.path), say)) : undefined}>
          <button type="button" className="change-row" aria-expanded={!!d} onClick={() => void panes.toggleDiff(f.path)} title={f.from ? `${f.from} → ${f.path}` : f.path}>
            <UiIcon name="chevron" size={11}/>
            <span className="change-status" data-status={f.status} aria-label={f.status}>{STATUS[f.status]}</span>
            <span className="change-name" dir="ltr">{f.path.slice(slash + 1)}</span>
            <span className="change-dir" dir="ltr">{slash > 0 ? f.path.slice(0, slash) : ''}</span>
            <span className="change-count">{f.added !== null && <span className="plus">+{f.added}</span>}{f.removed !== null && <span className="minus">−{f.removed}</span>}</span>
          </button>
          {abs && <OpenInCodeIcon client={client!} path={abs} line={firstLine(f.path)} say={say}/>}
          {d && <DiffView load={d} view={view}/>}
        </li>;
      })}</ul>}
    {data?.truncated && <p className="pane-empty">Only the first 1000 files are listed.</p>}
    {said && <p className="pane-empty" role="status">{said}</p>}
    <ContextMenu menu={fm.menu} onClose={fm.close}/>
  </div>;
}

function DiffView({ load, view }: { load: NonNullable<ReturnType<PanesController['getSnapshot']>['diffs'][string]>; view: DiffViewName }) {
  if (load.phase === 'loading') return <p className="pane-empty">Loading diff…</p>;
  if (load.phase === 'error') return <p className="pane-empty error">{load.message}</p>;
  const d = load.data;
  if (d.hidden) return <p className="pane-empty">Hidden: this file may hold secrets.</p>;
  if (d.binary) return <p className="pane-empty">Binary file.</p>;
  if (!d.diff) return <p className="pane-empty">{d.truncated ? 'Too big to show.' : 'No text changes.'}</p>;
  const cut = d.truncated && <p className="pane-empty">The diff is cut short; it is too long to show whole.</p>;
  if (view === 'split') return <div className="diff diff-split" dir="ltr" role="table" aria-label={`Diff of ${d.path}, side by side`}>
    {splitRows(diffLines(d.diff)).map((r, i) => r.kind !== 'pair'
      ? <div key={i} className="diff-line" data-kind={r.kind} role="row"><code>{r.text}</code></div>
      : <div key={i} className="diff-row" role="row">{[r.left, r.right].map((x, j) => <div key={j} className="diff-side" data-kind={x?.kind ?? 'empty'} role="cell" aria-label={j ? 'New' : 'Old'}>
          <span className="diff-no" aria-hidden="true">{x?.no ?? ''}</span><code>{x ? `${x.kind === 'add' ? '+' : x.kind === 'del' ? '−' : ' '}${x.text}` : ''}</code>
        </div>)}</div>)}
    {cut}
  </div>;
  return <div className="diff" dir="ltr" role="table" aria-label={`Diff of ${d.path}`}>
    {diffLines(d.diff).map((l, i) => <div key={i} className="diff-line" data-kind={l.kind} role="row">
      <span className="diff-no" aria-hidden="true">{l.old ?? ''}</span><span className="diff-no" aria-hidden="true">{l.new ?? ''}</span>
      <code>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}{l.text}</code>
    </div>)}
    {cut}
  </div>;
}

/** The project folder as a tree; a file opens as read-only text. */
export function FilesPane({ panes, onOpenCode }: { panes: PanesController; onOpenCode?:(file:string)=>void }) {
  const s = useSyncExternalStore(panes.subscribe, panes.getSnapshot, panes.getSnapshot);
  useEffect(() => { if (s.projectId && !s.tree['']) void panes.loadFolder(''); }, [panes, s.projectId, s.tree]);
  const origin = useRef<HTMLElement | null>(null);
  const wasFile = useRef(false);
  useEffect(() => {
    if (s.file && !(document.activeElement as HTMLElement | null)?.closest('.file-viewer')) origin.current = document.activeElement as HTMLElement | null;
    else if (!s.file && wasFile.current) origin.current?.focus();
    wasFile.current = !!s.file;
  }, [s.file?.path]);
  const [q, setQ] = useState('');
  if (!s.projectId) return <p className="pane-empty">Pick a project with a folder to browse its files.</p>;
  if (s.file) return <FileViewer panes={panes} file={s.file} view={s.diffView} onOpenCode={onOpenCode}/>;
  return <div className="pane" aria-label="Files">
    {/* CH4: find a file by name in the folders that are open. */}
    <div className="pane-head"><label className="pane-find"><UiIcon name="search" size={12}/><input type="search" aria-label="Find a file" placeholder="Find a file" value={q} onChange={e => setQ(e.target.value)}/></label>
      <button type="button" className="row-tool pane-refresh" aria-label="Reload files" title="Reload" onClick={() => void panes.refresh()}><UiIcon name="refresh" size={12}/></button></div>
    <Folder panes={panes} rel="" depth={0} q={q.trim().toLowerCase()}/>
  </div>;
}

function Folder({ panes, rel, depth, q }: { panes: PanesController; rel: string; depth: number; q: string }) {
  const s = useSyncExternalStore(panes.subscribe, panes.getSnapshot, panes.getSnapshot);
  const t = s.tree[rel];
  if (!t || t.phase === 'loading') return <p className="pane-empty" style={{ paddingInlineStart: 8 + depth * 12 }}>Loading…</p>;
  if (t.phase === 'error') return <p className="pane-empty error" style={{ paddingInlineStart: 8 + depth * 12 }}>{t.message}</p>;
  if (!t.data.entries.length) return <p className="pane-empty" style={{ paddingInlineStart: 8 + depth * 12 }}>Empty folder.</p>;
  return <ul className="tree" role={depth ? 'group' : 'tree'}>{t.data.entries.filter(e => !q || e.kind === 'dir' || e.name.toLowerCase().includes(q)).map(e => {
    const path = rel ? `${rel}/${e.name}` : e.name; const open = s.expanded.includes(path);
    return <li key={e.name} role="treeitem" aria-expanded={e.kind === 'dir' ? open : undefined}>
      <button type="button" className="tree-row" style={{ paddingInlineStart: 6 + depth * 12 }} dir="ltr"
        onClick={() => void (e.kind === 'dir' ? panes.toggleFolder(path) : panes.openFile(path))}>
        {e.kind === 'dir' ? <span className="tree-chevron" data-open={open || undefined}><UiIcon name="chevron" size={10}/></span> : <span className="tree-chevron"/>}
        <UiIcon name={e.kind === 'dir' ? 'folder' : SECRET.test(e.name) ? 'lock' : 'file'} size={13}/><span className="tree-name">{e.name}</span>
        {e.kind === 'file' && <span className="tree-size">{SECRET.test(e.name) ? 'hidden' : size(e.size)}</span>}
      </button>
      {e.kind === 'dir' && open && <Folder panes={panes} rel={path} depth={depth + 1} q={q}/>}
    </li>;
  })}{t.data.truncated && <li className="pane-empty">Only the first 1000 entries are listed.</li>}</ul>;
}

/** CHAT-CONTENT-01: what a file can show beside the chat. */
type FileMode = 'preview' | 'source' | 'changes' | 'pages';

/** The headings of a Markdown text (the viewer's outline), with stable ids. */
export function outlineOf(text: string): { level: number; title: string; id: string }[] {
  const out: { level: number; title: string; id: string }[] = []; let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    const m = !fence && /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, title: m[2].replace(/[*_`]/g, ''), id: `h-${out.length}` });
  }
  return out.slice(0, 80);
}
/** Text split around every place `mark` appears (any case), for the marked line. */
export function markParts(text: string, mark?: string): { text: string; hit: boolean }[] {
  if (!mark) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = []; const lc = text.toLowerCase(), m = mark.toLowerCase(); let i = 0;
  for (let j = lc.indexOf(m); j >= 0 && out.length < 200; j = lc.indexOf(m, i)) { if (j > i) out.push({ text: text.slice(i, j), hit: false }); out.push({ text: text.slice(j, j + m.length), hit: true }); i = j + m.length; }
  if (i < text.length) out.push({ text: text.slice(i), hit: false });
  return out;
}

function FileViewer({ panes, file, view, onOpenCode }: { panes: PanesController; file: NonNullable<ReturnType<PanesController['getSnapshot']>['file']>; view: DiffViewName; onOpenCode?: (file: string) => void }) {
  const kind = fileKind(file.path), media = mediaKind(file.path);
  const [mode, setMode] = useState<FileMode>(kind === 'pdf' ? 'pages' : kind === 'text' ? 'source' : 'preview');
  const [copied, setCopied] = useState(false);
  const [find, setFind] = useState(''), [wrap, setWrap] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => { setFind(''); setCopied(false); }, [file.path]);
  const [page, setPage] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { setMode(kind === 'pdf' ? 'pages' : kind === 'text' ? 'source' : 'preview'); setPage(0); }, [file.path]);
  useEffect(() => { if (mode === 'changes') void panes.loadFileDiff(); }, [mode, file.path]);
  const f = file.load;
  const text = f.phase === 'ready' && !f.data.hidden && !f.data.binary ? f.data.text : null;
  const pdf = file.pdf?.phase === 'ready' ? file.pdf.data : null;
  const pages = pdf && 'pages' in pdf ? pdf.pages : null;
  // The page that holds the marked text opens first.
  useEffect(() => { if (pages && file.mark) { const i = pages.findIndex(p => p.text.toLowerCase().includes(file.mark!.toLowerCase())); if (i >= 0) setPage(i); } }, [pages, file.mark]);
  // A folder without git has no changes to show, so its files drop the Changes tab.
  const changes = panes.getSnapshot().changes;
  useEffect(() => { if (!changes) void panes.loadChanges(); }, [changes]);
  const tracked = !(changes?.phase === 'ready' && changes.data.notGit);
  const modes: FileMode[] = (media || kind === 'office' ? ['preview'] : kind === 'pdf' ? ['pages'] : kind === 'text' ? ['source', 'changes'] : ['preview', 'source', 'changes']).filter((m): m is FileMode => tracked || m !== 'changes') as FileMode[];
  const label: Record<FileMode, string> = { preview: 'Preview', source: 'Source', changes: 'Changes', pages: 'Pages' };
  const copy = () => { const t = text ?? (pages ? pages.map(p => p.text).join('\n\n') : ''); if (!t || !navigator.clipboard) return; void navigator.clipboard.writeText(t).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined); };
  const outline = kind === 'md' && text && mode === 'preview' ? outlineOf(text) : [];
  return <div className="pane file-viewer" aria-label="File" data-kind={kind} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); panes.closeFile(); } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && mode === 'source') { e.preventDefault(); search.current?.focus(); } }}>
    <div className="pane-head">
      <button type="button" className="row-tool" aria-label="Back to files" title="Back to files" onClick={() => panes.closeFile()}><UiIcon name="arrow-left" size={12}/></button>
      <span className="pane-path" dir="ltr" title={file.path}>{file.path.split('/').at(-1)}</span>
      {f.phase === 'ready' && !pdf && kind !== 'office' && <span className="muted">{size(f.data.size)}</span>}
      {pages && <span className="muted">Page {page + 1} of {pdf && 'pageCount' in pdf ? pdf.pageCount : pages.length}</span>}
      {modes.length > 1 && <span className="file-modes" role="tablist" aria-label="View">{modes.map(m => <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}>{label[m]}</button>)}</span>}
      {!media && kind !== 'office' && <button type="button" className="row-tool" aria-label={copied ? 'Copied' : 'Copy the file text'} title={copied ? 'Copied' : 'Copy the file text'} onClick={copy}><UiIcon name={copied ? 'check' : 'copy'} size={12}/></button>}
      {onOpenCode && f.phase === 'ready' && !f.data.hidden && <button type="button" className="row-tool" aria-label="Open in Code" title="Open in Code" onClick={() => onOpenCode(file.path)}><UiIcon name="code" size={13}/></button>}
      <button type="button" className="row-tool" aria-label="Close the file" title="Close (Esc)" onClick={() => panes.closeFile()}><UiIcon name="close" size={12}/></button>
    </div>
    {f.phase === 'loading' ? <p className="pane-empty">Loading…</p> : f.phase === 'error' ? <p className="pane-empty error">{f.message}</p>
      : f.data.hidden ? <p className="pane-empty">Hidden: this file may hold secrets.</p>
      : kind === 'office' ? (file.office?.phase === 'ready' ? <OfficeContent key={file.path} payload={file.office.data}/> : <p className="pane-empty">{file.office?.phase === 'error' ? file.office.message : 'Reading document…'}</p>)
      : media ? (file.media?.phase === 'ready' ? <MediaContent key={file.path} media={file.media.data} kind={kind as 'image' | 'video' | 'audio'} name={file.path.split('/').at(-1)!}/> : <p className="pane-empty error">{file.media?.phase === 'error' ? file.media.message : 'Loading media…'}</p>)
      : mode === 'changes' ? (file.diff ? <DiffView load={file.diff} view={view}/> : <p className="pane-empty">Loading…</p>)
      : kind === 'pdf' ? (file.pdf?.phase === 'loading' || !file.pdf ? <p className="pane-empty">Reading the PDF…</p>
        : file.pdf.phase === 'error' ? <p className="pane-empty error">{file.pdf.message}</p>
        : !pages ? <p className="pane-empty">{pdfWhy((file.pdf.data as { reason: string }).reason)}</p>
        : <div className="pdf-view">
          <div className="pdf-thumbs" role="tablist" aria-label="Pages">{pages.map((p, i) => <button key={p.page} type="button" role="tab" aria-selected={i === page} aria-label={`Page ${p.page}`} title={`Page ${p.page}`} data-marked={!!file.mark && p.text.toLowerCase().includes(file.mark.toLowerCase()) || undefined} onClick={() => setPage(i)}><span>{p.page}</span></button>)}</div>
          <div className="pdf-page" dir="auto">{(pages[page]?.text ?? '').split('\n').map((line, i) => <p key={i}>{markParts(line, file.mark).map((x, j) => x.hit ? <mark key={j}>{x.text}</mark> : x.text)}</p>)}</div>
        </div>)
      : text === null ? <p className="pane-empty">Binary file; it cannot be shown as text.</p>
      : mode === 'preview' && (kind === 'json' || kind === 'csv') ? (f.data.truncated ? <p className="pane-empty">This structured file is too large to preview. Open Source for the first 512 KB.</p> : kind === 'json' ? <JsonContent key={file.path} text={text}/> : <CsvContent key={file.path} text={text}/>)
      : mode === 'preview' && kind === 'md' ? <div className="md-view" ref={body}>
          {outline.length > 1 && <nav className="md-outline" aria-label="On this page"><b>On this page</b>{outline.map((h, i) => <button key={i} type="button" data-level={h.level} onClick={() => body.current?.querySelectorAll('.md-body h1, .md-body h2, .md-body h3, .md-body h4')[i]?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>{h.title}</button>)}</nav>}
          <div className="md-body chat-prose md-host"><Markdown text={text}/></div>
        </div>
      : mode === 'preview' && kind === 'html' ? <div className="html-view"><p className="muted html-note">Preview · scripts off</p>
          {/* Shown in a frame with every permission off: no scripts, forms, popups or same-origin access. */}
          <iframe title={`Preview of ${file.path}`} sandbox="" srcDoc={text} referrerPolicy="no-referrer"/></div>
      : <div className="file-source"><div className="file-content-tools"><label className="pane-find"><UiIcon name="search" size={12}/><input ref={search} type="search" aria-label="Find in file" placeholder="Find in file" value={find} onChange={e => setFind(e.target.value)}/></label><button type="button" className="link-button" aria-pressed={wrap} onClick={() => setWrap(v => !v)}>Wrap</button></div><div className="file-view" data-wrap={wrap || undefined} dir="ltr">{text.split('\n').slice(0, 10000).map((line, i) => <div key={i} className="file-line"><span className="diff-no" aria-hidden="true">{i + 1}</span><code>{markParts(line, find || file.mark).map((x, j) => x.hit ? <mark key={j}>{x.text}</mark> : x.text)}</code></div>)}
          {(f.data.truncated || text.split('\n').length > 10000) && <p className="pane-empty">Preview limited to 512 KB and 10,000 lines.</p>}</div></div>}
  </div>;
}
const pdfWhy = (r: string) => r === 'encrypted' ? 'This PDF is locked with a password.' : r === 'no_text' ? 'This PDF has no text Girru can read (a scan).' : r === 'too_large' ? 'This PDF is too large to show.' : r === 'hidden' ? 'Hidden: this file may hold secrets.' : 'This PDF cannot be shown.';
