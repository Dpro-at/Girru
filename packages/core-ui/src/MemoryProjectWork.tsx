// MEM-READ-01 MR6: a project's Key files (in its Files tab) and "Where the work stands" (under its memories).
import { useEffect, useState } from 'react';
import { UiIcon } from './ui-icons';
import { ago } from './memory-store';
import type { MemoryScopesController } from './memory-scopes';
import type { PeriodSummary, ProjectDocument, ProjectDocuments } from './memory-pages-contract.js';

/** Today / This week / Month: quiet rows made from the handoffs, only when there was work. Read more shows each session's handoff. */
export function WorkStands({ sc, slug }: { sc: MemoryScopesController; slug: string }) {
  const [list, setList] = useState<PeriodSummary[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { let live = true; setList(null); void sc.summaries(slug).then(x => { if (live) setList(x ?? []); }); return () => { live = false; }; }, [sc, slug]);
  if (!list?.length) return null;
  return <section className="dk-list-group dk-work" aria-label="Where the work stands"><h3>Where the work stands</h3>
    {list.map(s => <article key={s.period} className="dk-work-row">
      <p className="dk-row-title"><UiIcon name="history" size={13}/>{s.label}<span className="fine-print"> · {s.sessions} {s.sessions === 1 ? 'session' : 'sessions'} · {s.sources.join(', ')}</span></p>
      <p className="dk-row-lines">{s.done.length > 0 && <><b>Done:</b> {s.done.slice(0, 2).join('; ')}. </>}{s.left.length > 0 && <><b>Left:</b> {s.left[0]}. </>}{s.next.length > 0 && <><b>Next:</b> {s.next[0]}.</>}</p>
      <button type="button" className="link-button dk-read-more" aria-expanded={open === s.period} onClick={() => setOpen(open === s.period ? null : s.period)}>{open === s.period ? 'Show less' : 'Read more'}</button>
      {open === s.period && <ul className="dk-work-sessions">{s.handoffs.map((h, i) => <li key={i}><span className="fine-print">{h.from} · {ago(h.at)}</span>
        {h.done.length > 0 && <p><b>Done</b> {h.done.join('; ')}</p>}{h.left.length > 0 && <p><b>Left</b> {h.left.join('; ')}</p>}{h.next.length > 0 && <p><b>Next</b> {h.next.join('; ')}</p>}</li>)}</ul>}
    </article>)}
    <p className="fine-print">Made from the handoffs of chats, board tasks and coding apps. No work in a period, no row.</p>
  </section>;
}

/** MR8: the file's type as a short badge (PDF, DOC, XLS, PPT, CSV, MD …). */
const TYPE_BADGE: Record<string, string> = { pdf: 'PDF', docx: 'DOC', doc: 'DOC', odt: 'DOC', rtf: 'DOC', xlsx: 'XLS', xls: 'XLS', ods: 'XLS', pptx: 'PPT', ppt: 'PPT', odp: 'PPT', csv: 'CSV', md: 'MD', markdown: 'MD', txt: 'TXT', html: 'HTML', htm: 'HTML', json: 'JSON', yaml: 'YAML', yml: 'YAML', zip: 'ZIP', mdc: 'MD' };
const PLAIN_REASON: Record<string, string> = { encoding: 'not UTF-8 text', binary: 'not a text file' };
/** How Girru read it: "Read · 3 sheets", "Read · 12 pages", or "Not read · why". */
export function readLine(d: ProjectDocument): string {
  if (d.status === 'unreadable') return `Not read · ${PLAIN_REASON[d.reason ?? ''] ?? d.reason ?? 'unreadable'}`;
  if (d.reason) return `Read · ${d.reason}`;
  return d.pages ? `Read · ${d.pages} ${d.pages === 1 ? 'page' : 'pages'}` : 'Read';
}
function DocRow({ d }: { d: ProjectDocument }) {
  const ext = (/\.([a-z0-9]+)$/i.exec(d.path)?.[1] ?? '').toLowerCase();
  return <li className="dk-doc"><span className="dk-doc-type" data-unread={d.status === 'unreadable' || undefined}>{TYPE_BADGE[ext] ?? (ext.slice(0, 4).toUpperCase() || 'FILE')}</span><span className="dk-row-text"><span className="dk-row-main">{d.path}</span>
    <span className="dk-row-sub">{d.purpose ?? readLine(d)}</span></span>
    <span className="fine-print">{ago(d.updatedAt)}</span></li>;
}

/** Files tab: the files every coding app reads first ("Key files"), then the project's other documents. */
export function ProjectDocumentsList({ sc, slug }: { sc: MemoryScopesController; slug: string }) {
  const [docs, setDocs] = useState<ProjectDocuments | null>(null);
  useEffect(() => { let live = true; setDocs(null); void sc.documents(slug).then(x => { if (live) setDocs(x ?? { key: [], other: [] }); }); return () => { live = false; }; }, [sc, slug]);
  if (!docs || (!docs.key.length && !docs.other.length)) return null;
  return <div className="dk-docs">
    {docs.key.length > 0 && <section className="dk-list-group"><h3>Key files · {docs.key.length}</h3><ul className="dk-doc-list">{docs.key.map(d => <DocRow key={d.path} d={d}/>)}</ul></section>}
    {docs.other.length > 0 && <section className="dk-list-group"><h3>Other documents · {docs.other.length}</h3><ul className="dk-doc-list">{docs.other.map(d => <DocRow key={d.path} d={d}/>)}</ul></section>}
    <p className="fine-print">Key files are found by name in the project folder and in .claude / .codex / .gemini / .cursor. They never appear as memories; agents read them as project files.</p>
  </div>;
}
