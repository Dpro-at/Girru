import { useMemo, useState } from 'react';
import type { OfficeParagraph, OfficePayload } from './office-content';
import { PowerPointContent } from './PowerPointContent';
import { columnLabel, wordPreview, workbookPreview, presentationPreview } from './office-content';
import { UiIcon } from './ui-icons';

function Paragraph({ p }: { p: OfficeParagraph }) {
  return <div className={`office-paragraph${p.heading ? ` office-heading-${p.heading}` : ''}${p.list ? ' office-list' : ''}`} role={p.heading ? 'heading' : undefined} aria-level={p.heading || undefined} dir={p.dir} style={{ textAlign: p.align }}>
    {p.runs.map((r, i) => r.image ? <img key={i} src={r.image.src} alt={r.image.alt} loading="lazy"/> : <span key={i} style={{ fontWeight: r.bold ? 700 : undefined, fontStyle: r.italic ? 'italic' : undefined, textDecoration: r.underline ? 'underline' : undefined }}>{r.text}</span>)}
  </div>;
}
export function OfficeContent({ payload }: { payload: OfficePayload }) {
  const [sheetIndex, setSheetIndex] = useState(0), [query, setQuery] = useState(''), [copied, setCopied] = useState(false);
  const parsed = useMemo(() => {
    if (payload.reason) return null;
    try { return payload.kind === 'docx' ? { word: wordPreview(payload) } : payload.kind === 'xlsx' ? { book: workbookPreview(payload) } : payload.kind === 'pptx' ? { deck: presentationPreview(payload) } : null; } catch { return null; }
  }, [payload]);
  if (!parsed) return <p className="pane-empty">{payload.reason === 'hidden' ? 'Hidden: this file may hold secrets.' : payload.reason === 'too_large' ? 'This Office file exceeds the preview size limits.' : 'This Office document cannot be previewed. Password-protected and older Office formats are not supported.'}</p>;
  if ('word' in parsed && parsed.word) return <div className="file-office"><p className="office-note">Read-only preview · layout may differ from Word</p><article className="office-paper" aria-label="Word document">
    {parsed.word.blocks.length ? parsed.word.blocks.map((b, i) => 'paragraph' in b ? <Paragraph key={i} p={b.paragraph}/> : <div className="office-word-table" key={i}><table><tbody>{b.table.map((row, j) => <tr key={j}>{row.map((c, k) => <td key={k} colSpan={c.span}>{c.paragraphs.map((p, l) => <Paragraph key={l} p={p}/>)}</td>)}</tr>)}</tbody></table></div>) : <p>This document has no text to preview.</p>}
    {parsed.word.truncated && <p className="office-note">This preview omits some content or images because of preview limits.</p>}
  </article></div>;
  if ('deck' in parsed && parsed.deck) return <PowerPointContent deck={parsed.deck}/>;
  const book = parsed.book!, sheet = book.sheets[Math.min(sheetIndex, book.sheets.length - 1)];
  if (!sheet) return <p className="pane-empty">No visible worksheets can be previewed.</p>;
  const rows = sheet.rows.filter(r => !query || r.cells.some(c => c.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  return <div className="file-office file-workbook"><div className="file-content-tools">
    <label>Sheet <select aria-label="Worksheet" value={sheetIndex} onChange={e => { setSheetIndex(Number(e.target.value)); setQuery(''); }}>{book.sheets.map((s, i) => <option key={i} value={i}>{s.name}</option>)}</select></label>
    <label className="pane-find"><UiIcon name="search" size={12}/><input type="search" aria-label="Find in worksheet" placeholder="Find in sheet" value={query} onChange={e => setQuery(e.target.value)}/></label>
  </div><p className="office-note">Read-only · saved values · formulas are not recalculated · formatting may differ</p>
    <div className="file-table-scroll"><table dir="ltr" aria-label={`Worksheet ${sheet.name}`}><thead><tr><th aria-label="Row"/>{Array.from({ length: sheet.columns }, (_, i) => <th key={i} scope="col">{columnLabel(i + 1)}</th>)}</tr></thead><tbody>{rows.map(r => <tr key={r.index}><th scope="row">{r.index}</th>{Array.from({ length: sheet.columns }, (_, i) => { const c = r.cells.find(c => c.column === i + 1); return <td key={i}><button type="button" title={c?.formula ? 'Copy saved formula value' : 'Copy cell'} onClick={() => { void navigator.clipboard?.writeText(c?.text ?? '').then(() => setCopied(true), () => setCopied(false)); }}>{c?.text ?? ''}</button></td>; })}</tr>)}</tbody></table></div>
    {!rows.length && <p className="pane-empty">{query ? 'No matching rows.' : 'This worksheet is empty.'}</p>}
    {(sheet.truncated || book.truncated) && <p className="office-note">Preview limited to 20 sheets, 1,000 rows, 100 columns and 20,000 cells per sheet.</p>}
    {copied && <p className="office-note" role="status">Cell copied.</p>}
  </div>;
}
