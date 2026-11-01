import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { diffLines, splitRows, SPLIT_MIN_WIDTH } from './panes';
import type { DiffView as DiffViewName, PanesController } from './panes';
import { UiIcon } from './ui-icons';

/** Names that usually hold secrets: shown locked; Girru does not open them (the server checks again). */
const SECRET = /^\.env(\..*)?$|\.(pem|key|p12|pfx)$|^id_(rsa|ed25519|ecdsa)/i;
const STATUS: Record<string, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U' };
const size = (b: number | null) => b === null ? '' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB` : `${(b / 1048576).toFixed(1)} MB`;

/** Uncommitted changes per file; a file opens its diff in place. */
export function ChangesPane({ panes }: { panes: PanesController }) {
  const s = useSyncExternalStore(panes.subscribe, panes.getSnapshot, panes.getSnapshot);
  useEffect(() => { if (s.projectId && !s.changes) void panes.loadChanges(); }, [panes, s.projectId, s.changes]);
  useEffect(() => { void panes.loadDiffView(); }, [panes]);
  // Side by side needs room: a narrow pane shows one column and keeps the choice.
  const box = useRef<HTMLDivElement>(null); const [width, setWidth] = useState(Infinity);
  useEffect(() => { const b = box.current; if (!b || typeof ResizeObserver === 'undefined') return; const o = new ResizeObserver(() => setWidth(b.clientWidth || Infinity)); o.observe(b); setWidth(b.clientWidth || Infinity); return () => o.disconnect(); }, [s.projectId]);
  const narrow = width < SPLIT_MIN_WIDTH, view: DiffViewName = s.diffView === 'split' && !narrow ? 'split' : 'unified';
  if (!s.projectId) return <p className="pane-empty">Pick a project with a folder to see its changes.</p>;
  const c = s.changes;
  const data = c?.phase === 'ready' ? c.data : null;
  const total = data?.changes.reduce((t, x) => [t[0] + (x.added ?? 0), t[1] + (x.removed ?? 0)], [0, 0]);
  return <div className="pane" aria-label="Changes" ref={box} data-diff={view}>
    <div className="pane-head">
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
        return <li key={f.path} data-open={d ? true : undefined}>
          <button type="button" className="change-row" aria-expanded={!!d} onClick={() => void panes.toggleDiff(f.path)} title={f.from ? `${f.from} → ${f.path}` : f.path}>
            <UiIcon name="chevron" size={11}/>
            <span className="change-status" data-status={f.status} aria-label={f.status}>{STATUS[f.status]}</span>
            <span className="change-name" dir="ltr">{f.path.slice(slash + 1)}</span>
            <span className="change-dir" dir="ltr">{slash > 0 ? f.path.slice(0, slash) : ''}</span>
            <span className="change-count">{f.added !== null && <span className="plus">+{f.added}</span>}{f.removed !== null && <span className="minus">−{f.removed}</span>}</span>
          </button>
          {d && <DiffView load={d} view={view}/>}
        </li>;
      })}</ul>}
    {data?.truncated && <p className="pane-empty">Only the first 1000 files are listed.</p>}
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
  const [q, setQ] = useState('');
  if (!s.projectId) return <p className="pane-empty">Pick a project with a folder to browse its files.</p>;
  if (s.file) {
    const f = s.file.load;
    return <div className="pane" aria-label="File">
      <div className="pane-head"><button type="button" className="row-tool" aria-label="Back to files" onClick={() => panes.closeFile()}><UiIcon name="arrow-left" size={12}/></button>
        <span className="pane-path" dir="ltr" title={s.file.path}>{s.file.path}</span>{f.phase === 'ready' && <span className="muted">{size(f.data.size)}</span>}{onOpenCode&&f.phase==='ready'&&!f.data.hidden&&<button type="button" className="row-tool" aria-label="Open file in Code" title="Open file in Code" onClick={()=>onOpenCode(s.file!.path)}><UiIcon name="code" size={13}/></button>}</div>
      {f.phase === 'loading' ? <p className="pane-empty">Loading…</p> : f.phase === 'error' ? <p className="pane-empty error">{f.message}</p>
        : f.data.hidden ? <p className="pane-empty">Hidden: this file may hold secrets.</p>
        : f.data.binary || f.data.text === null ? <p className="pane-empty">Binary file; it cannot be shown as text.</p>
        : <div className="file-view" dir="ltr">{f.data.text.split('\n').map((line, i) => <div key={i} className="file-line"><span className="diff-no" aria-hidden="true">{i + 1}</span><code>{line}</code></div>)}
          {f.data.truncated && <p className="pane-empty">Only the first 512 KB are shown.</p>}</div>}
    </div>;
  }
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
