import { useEffect, useRef, useState } from 'react';
import { UiIcon } from './ui-icons';
import { csvRows, pointerChild } from './file-content';
import type { WireMedia } from './panes';

export function MediaContent({ media, kind, name }: { media: WireMedia; kind: 'image' | 'video' | 'audio'; name: string }) {
  const [zoom, setZoom] = useState<number | null>(null), [failed, setFailed] = useState(false);
  const player = useRef<HTMLMediaElement | null>(null);
  useEffect(() => { const old = player.current; return () => { old?.pause(); }; }, [name]);
  const box = useRef<HTMLDivElement>(null);
  if (media.reason || !media.mime || !media.base64) return <p className="pane-empty">{media.reason === 'too_large' ? 'This media file is larger than the 32 MB preview limit.' : media.reason === 'hidden' ? 'Hidden: this file may hold secrets.' : 'This media file cannot be shown.'}</p>;
  const src = `data:${media.mime};base64,${media.base64}`;
  return <div className={`file-media file-${kind}`} ref={box}>
    {kind === 'image' && <div className="file-content-tools" role="toolbar" aria-label="Image view">
      <button type="button" className="row-tool" title="Zoom out" aria-label="Zoom out" disabled={zoom !== null && zoom <= 25} onClick={() => setZoom(v => Math.max(25, (v ?? 100) - 25))}><UiIcon name="zoom-out" size={15}/></button>
      <output>{zoom === null ? 'Fit' : `${zoom}%`}</output>
      <button type="button" className="row-tool" title="Zoom in" aria-label="Zoom in" disabled={zoom !== null && zoom >= 400} onClick={() => setZoom(v => Math.min(400, (v ?? 100) + 25))}><UiIcon name="zoom-in" size={15}/></button>
      <button type="button" className="link-button" onClick={() => setZoom(null)}>Fit</button>
      <button type="button" className="link-button" onClick={() => setZoom(100)}>Actual size</button>
    </div>}
    {failed ? <p className="pane-empty" role="status">{kind === 'image' ? 'This image cannot be decoded.' : 'This media format cannot be played on this computer.'}</p>
      : kind === 'image' ? <div className="file-image-canvas"><img alt={name} src={src} draggable={false} className={zoom === null ? 'image-fit' : ''} style={zoom === null ? undefined : { zoom: zoom / 100 }} onError={() => setFailed(true)}/></div>
      : kind === 'video' ? <video ref={el => { player.current = el; }} controls playsInline preload="metadata" src={src} onError={() => setFailed(true)} aria-label={name}/>
      : <div className="file-audio-player"><UiIcon name="mic" size={32}/><strong dir="auto">{name}</strong><audio ref={el => { player.current = el; }} controls preload="metadata" src={src} onError={() => setFailed(true)} aria-label={name}/></div>}
  </div>;
}

function JsonNode({ value, name, pointer, depth, copy }: { value: unknown; name: string; pointer: string; depth: number; copy: (p: string) => void }) {
  const [expanded, setExpanded] = useState(depth === 0);
  const compound = value !== null && typeof value === 'object';
  const entries = compound ? Object.entries(value as Record<string, unknown>) : [];
  const label = <><span className="json-key">{name}</span><span className="json-value">{compound ? `${Array.isArray(value) ? 'Array' : 'Object'} · ${entries.length}` : JSON.stringify(value)}</span></>;
  return <div className="json-node">
    {compound ? <details open={expanded} onToggle={e => setExpanded(e.currentTarget.open)}><summary>{label}<button type="button" className="row-tool" aria-label={`Copy JSON path ${pointer || '/'}`} title="Copy JSON path" onClick={e => { e.preventDefault(); copy(pointer); }}><UiIcon name="copy" size={12}/></button></summary>
      {expanded && (depth >= 40 ? <p className="muted">Deeper values are available in Source.</p> : entries.slice(0, 200).map(([key, child]) => <JsonNode key={key} name={key} value={child} pointer={pointerChild(pointer, key)} depth={depth + 1} copy={copy}/>))}
      {entries.length > 200 && <p className="muted">First 200 items shown. Open Source for the rest.</p>}
    </details> : <div className="json-leaf">{label}<button type="button" className="row-tool" aria-label={`Copy JSON path ${pointer || '/'}`} title="Copy JSON path" onClick={() => copy(pointer)}><UiIcon name="copy" size={12}/></button></div>}
  </div>;
}
export function JsonContent({ text }: { text: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  let value: unknown; try { value = JSON.parse(text); } catch { return <p className="pane-empty">This file is not valid JSON. Open Source to read it.</p>; }
  const copy = (p: string) => { void navigator.clipboard?.writeText(p).then(() => setCopied(p), () => setCopied(null)); };
  return <div className="file-json" dir="ltr"><JsonNode value={value} name="root" pointer="" depth={0} copy={copy}/>{copied !== null && <p className="fine-print" role="status">Copied JSON path {copied || '(root)'}</p>}</div>;
}
export function CsvContent({ text }: { text: string }) {
  const [query, setQuery] = useState(''), [header, setHeader] = useState(true), [copied, setCopied] = useState(false);
  const { rows, error, truncated } = csvRows(text.replace(/^\uFEFF/, ''));
  if (error) return <p className="pane-empty">{error}</p>;
  if (!rows.length) return <p className="pane-empty">{truncated ? 'This table has more than 200 columns. Open Source to read it.' : 'This table is empty.'}</p>;
  const data = (header ? rows.slice(1) : rows).filter(row => !query || row.some(c => c.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  return <div className="file-csv"><div className="file-content-tools"><label className="pane-find"><UiIcon name="search" size={12}/><input type="search" aria-label="Find in table" placeholder="Find in table" value={query} onChange={e => setQuery(e.target.value)}/></label><label className="fine-print"><input type="checkbox" checked={header} onChange={e => setHeader(e.target.checked)}/>First row is header</label></div>
    <div className="file-table-scroll"><table dir="ltr" aria-label="CSV contents">{header && <thead><tr>{rows[0].map((c, i) => <th key={i} scope="col">{c}</th>)}</tr></thead>}<tbody>{data.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j}><button type="button" title="Copy cell" onClick={() => { void navigator.clipboard?.writeText(c).then(() => setCopied(true), () => setCopied(false)); }}>{c || <span className="muted" aria-label="Empty cell"> </span>}</button></td>)}</tr>)}</tbody></table></div>
    {!data.length && <p className="pane-empty">No matching rows.</p>}{truncated && <p className="pane-empty">Preview limited to 1,000 rows and 200 columns.</p>}{copied && <p className="fine-print" role="status">Cell copied.</p>}
  </div>;
}
