// Memory › Needs you (boards M22 B1–B2, M34 N1–N2, M29 I4, M31 J4): one
// question at a time with two choices (Enter takes the blue one), or the whole
// list with Show (type filters with counts, group by, Accept all routine) and
// bulk approve / reject after "I read the selected". Keys: J / K next,
// A keep new, O keep old, B keep both.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent } from 'react';
import { FILTERS, KIND_WORD, MemoryReviewController, OUTSIDER, PERSONAL_DATA, REPOSITORY_FILE, RUN_NOTES, SPECIAL_CATEGORY, isSensitive, plainReasons } from './memory-review';
import type { ReviewItem } from './memory-review';
import { ago, agentLabel, drawerName } from './memory-store';
import type { PrivacyFlags } from './memory-people-contract.js';
import { personName } from './memory-people';
import { UiIcon } from './ui-icons';
import type { UiIconName } from './ui-icons';
import { Avatar, IconButton, Popover, WithSwatches } from './desktop-ui';
import type { MemoryDesktopController } from './memory-desktop';
import type { ProjectFilesController } from './project-files';
import { TaskProblems } from './MemoryProjectFiles';
import { HiddenKeysQuestion } from './memory-hidden-keys';
import type { HiddenKeysController } from './memory-hidden-keys';

const noSubscribe = () => () => {};
const noSnapshot = () => null;

const KIND_ICON: Record<ReviewItem['kind'], UiIconName> = { conflict: 'diff', important: 'alert', agent: 'sparkle', imported: 'download', file: 'file', link: 'link' };

export function NeedsYou({ c, mode, onOpenChat, design, files, client, hidden, projectName }: { c: MemoryReviewController; mode: 'one' | 'list'; onOpenChat?: (id: string) => void; design?: MemoryDesktopController; files?: ProjectFilesController;
  /** MEM-READ-01 MR2: "N keys and logins were hidden" (Keep hidden here / Move to Connections…). */ hidden?: HiddenKeysController; projectName?: (drawer: string) => string | undefined;
  /** CODE-OPEN-01: a task-number question opens tasks.md at its line. */ client?: Parameters<typeof TaskProblems>[0]['client'] }) {
  const say = design ? (t: string) => design.say(t) : undefined;
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  // P6: a task-number question waits too, so the "Nothing needs you" line would be wrong beside it.
  const fp = useSyncExternalStore(files ? files.subscribe : noSubscribe, files ? files.getSnapshot : noSnapshot, files ? files.getSnapshot : noSnapshot);
  const taskQuestions = Array.isArray(fp?.problems) && fp.problems.length > 0;
  const ref = useRef<HTMLDivElement>(null);
  const visible = s.phase === 'ready' ? c.visible() : [];
  // Open the first question when there is none open.
  useEffect(() => { if (s.phase === 'ready' && !s.open && visible[0]) void c.openItem(visible[0].key, true); }, [s.phase, s.open, visible[0]?.key]);
  useEffect(() => { ref.current?.focus(); }, [mode]);
  if (s.phase === 'error') return <div className="dk-empty"><p>{s.notice}</p><button type="button" onClick={() => void c.load()}>Try again</button></div>;
  if (s.phase !== 'ready') return <p className="dk-empty" role="status">Reading what waits for you…</p>;
  const keysRow = hidden ? <HiddenKeysQuestion c={hidden} nameOf={projectName}/> : null;
  if (!s.items.length && taskQuestions && files) return <div className="dk-needs">{keysRow}{design && <DesignQuestions d={design}/>}<TaskProblems c={files} client={client} say={say}/></div>;
  if (!s.items.length) return <>{keysRow}{design && <DesignQuestions d={design}/>}{files && <TaskProblems c={files} client={client} say={say}/>}<div className="dk-empty"><UiIcon name="check" size={20}/><p>Nothing needs you. Girru saves routine facts on its own and asks only when something matters or disagrees.</p>{s.result && <p className="fine-print">{s.result}</p>}</div></>;
  function keys(e: KeyboardEvent<HTMLElement>) {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if (k === 'j' || e.key === 'ArrowDown') { e.preventDefault(); c.step(1); }
    else if (k === 'k' || e.key === 'ArrowUp') { e.preventDefault(); c.step(-1); }
    else if (s.detail?.conflictWith && !s.busy && (k === 'a' || k === 'o' || k === 'b')) { e.preventDefault(); void c.decide(k === 'a' ? 'keep_new' : k === 'o' ? 'keep_old' : 'keep_both'); }
    else if (e.key === 'Enter' && mode === 'one' && !s.busy) {
      e.preventDefault();
      if (s.detail?.conflictWith) void c.decide('keep_new');
      else if (s.open && (s.items.find(i => i.key === s.open)?.link || s.detail)) void c.approve('approve');
    }
  }
  const index = Math.max(0, visible.findIndex(i => i.key === s.open));
  if (mode === 'one') return <div className="dk-needs" ref={ref} tabIndex={-1} onKeyDown={keys}>
    <p className="dk-needs-head"><span>{index + 1} of {visible.length}</span><span className="fine-print">J / K next · Enter = the blue choice</span>
      <span className="dk-toolbar-gap"/><IconButton icon="arrow-up" label="Previous" shortcut="K" onClick={() => c.step(-1)} disabled={index === 0}/><IconButton icon="arrow-down" label="Next" shortcut="J" onClick={() => c.step(1)} disabled={index >= visible.length - 1}/></p>
    {s.result && <p className="dk-inline-ok" role="status">{s.result}</p>}
    {s.notice && <p className="dk-inline-notice" role="alert">{s.notice}</p>}
    {keysRow}
    {design && <DesignQuestions d={design}/>}
    {files && <TaskProblems c={files} client={client} say={say}/>}
    <Question c={c} onOpenChat={onOpenChat}/>
    <p className="fine-print dk-needs-foot">Other questions here, one at a time: an agent wants to remember something important, a new link on the map, memories found on this computer, a change to a memory file.</p>
  </div>;
  return <NeedsList c={c} keys={keys}/>;
}

/** The open question: a conflict, a proposal (file edit, agent change, import) or a new link. */
function Question({ c, onOpenChat }: { c: MemoryReviewController; onOpenChat?: (id: string) => void }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const [read, setRead] = useState(false);
  const [more, setMore] = useState(false);
  useEffect(() => { setRead(false); setMore(false); }, [s.open]);
  const item = s.items.find(i => i.key === s.open);
  if (!item) return null;
  if (item.link) { const l = item.link; return <article className="dk-question">
    <h3><UiIcon name="link" size={15}/>A new link on the map</h3>
    <p className="dk-big">{l.from.name} — {l.type.replace(/_/g, ' ')} → {l.to.name}</p>
    <p className="fine-print">Found in {l.memoryIds.length} {l.memoryIds.length === 1 ? 'memory' : 'memories'} · {ago(l.createdAt)}. An approved link helps replies connect people, projects and decisions.</p>
    <div className="actions"><button type="button" onClick={() => void c.approve('reject')} disabled={s.busy}>Reject</button><button type="button" className="primary" onClick={() => void c.approve('approve')} disabled={s.busy}>Approve</button></div>
  </article>; }
  if (s.detailBusy) return <p className="dk-empty" role="status">Reading…</p>;
  if (!s.detail) return <div className="dk-empty"><button type="button" onClick={() => void c.load()}>Read the questions again</button></div>;
  const d = s.detail;
  if (d.conflictWith) {
    const ch = d.changes[0];
    const before = ch && 'before' in ch ? ch.before.content : '—'; const after = ch && 'after' in ch ? ch.after.content : '—';
    return <article className="dk-question">
      <h3><UiIcon name="diff" size={15}/>This changes something Girru already knows <span className="fine-print">({drawerName(d.drawerId)})</span></h3>
      <div className="dk-versus">
        <div><span className="fine-print">Now</span><p dir="auto"><WithSwatches text={before}/></p></div>
        <div data-new><span className="fine-print">New, {ago(d.createdAt)}</span>
          {s.editing !== null ? <textarea aria-label="Edit the new fact" dir="auto" rows={3} value={s.editing} onChange={e => c.editText(e.target.value)}/> : <p dir="auto"><WithSwatches text={after}/></p>}</div>
      </div>
      <div className="actions">
        <button type="button" onClick={() => void c.decide('keep_old')} disabled={s.busy} title="O">Keep the old one</button>
        <button type="button" className="primary" onClick={() => void c.decide('keep_new')} disabled={s.busy || (s.editing !== null && !s.editing.trim())} title="A or Enter">{s.editing !== null ? 'Use my edit' : 'Use the new one'}</button>
        <span className="dk-anchor" data-popover-anchor><IconButton icon="more" label="More choices" onClick={() => setMore(v => !v)}/>
          <Popover open={more} onClose={() => setMore(false)} label="More choices"><div className="dk-pop-menu">
            <button type="button" onClick={() => { setMore(false); void c.decide('keep_both'); }}>Keep both (different times) <kbd>B</kbd></button>
            {s.editing === null ? <button type="button" onClick={() => { setMore(false); c.startEdit(); }}>Edit the new one first</button> : <button type="button" onClick={() => { setMore(false); c.cancelEdit(); }}>Cancel the edit</button>}
          </div></Popover></span>
      </div>
      <section className="dk-why"><h4>Why Girru asks</h4><p dir="auto">{d.note ?? 'The new fact and the saved one are about the same thing but say different things. Both cannot be true.'}</p>
        {plainReasons(d.reasons).length > 0 && <p className="fine-print">{plainReasons(d.reasons).join(', ')}</p>}
        <p className="fine-print">The agent wrote this text. It is information only: it cannot change permissions or give instructions.</p></section>
    </article>;
  }
  // STORE-MAP-01 P9 (board P9d1): personal data or a sensitive topic: Forget it / Keep, never saved by itself.
  if (isFlagged(d.reasons) && d.changes.length === 1 && d.changes[0].op === 'add') {
    const sensitive = d.reasons.includes(SPECIAL_CATEGORY), channel = d.reasons.includes(OUTSIDER);
    const who = item.agent ? agentLabel(item.agent, s.agents) : '';
    return <article className="dk-question" data-flagged>
      <p className="dk-big dk-quote" dir="auto"><WithSwatches text={d.changes[0].after.content}/></p>
      <p className="dk-chips"><PrivacyChips reasons={d.reasons} privacy={d.privacy}/>{channel && <span className="dk-chip"><UiIcon name="message" size={11}/>From a channel</span>}</p>
      {sensitive && <p className="dk-who-line">{who && <Avatar name={who}/>}<span>{who ? `${who} wanted to remember this` : 'Waits for you'} · never saved by itself</span></p>}
      {channel && <p className="fine-print">A message to one of your channels. Its data stays in this review until you decide.</p>}
      {d.note && <p className="fine-print" dir="auto">{d.note}</p>}
      <div className="actions"><button type="button" onClick={() => void c.approve('reject')} disabled={s.busy}>Forget it</button>
        <button type="button" className="primary" onClick={() => void c.approve('approve')} disabled={s.busy}>{keepIn(d.drawerId)}</button></div>
      <p className="fine-print">The agent wrote this text. It is information only: it cannot change permissions or give instructions.</p>
    </article>;
  }
  const kindWord = KIND_WORD[item.kind];
  // STORE-MAP-01 P6 (D21): text written into Girru's part of a project file by someone outside Girru.
  const fromFile = d.reasons.includes(REPOSITORY_FILE) ? <span className="dk-chip dk-state" data-tone="warn">From a file in the project</span>
    // STORE-MAP-01 P8 (D27): a lesson the agent noted while a run worked; never added by itself.
    : d.reasons.includes(RUN_NOTES) ? <span className="dk-chip dk-state" data-tone="warn">From a run’s working notes</span> : null;
  return <article className="dk-question">
    <h3><UiIcon name={KIND_ICON[item.kind]} size={15}/>{d.changes.length === 1 ? (d.changes[0].op === 'add' ? 'Remember this?' : d.changes[0].op === 'update' ? 'Change this memory?' : 'Forget this memory?') : `${d.changes.length} changes`} <span className="fine-print">{kindWord} · {c.label(item)}</span>{fromFile}</h3>
    {d.changes.length === 1 && d.changes[0].op === 'add' ? <p className="dk-big dk-quote" dir="auto"><WithSwatches text={d.changes[0].after.content}/></p> : <ol className="dk-changes">{d.changes.map((ch, i) => <li key={i}>
      {'before' in ch && <p className="dk-del" dir="auto">− <WithSwatches text={ch.before.content}/></p>}
      {'after' in ch && <p className="dk-add" dir="auto">+ <WithSwatches text={ch.after.content}/></p>}
    </li>)}</ol>}
    {(d.note || plainReasons(d.reasons).length > 0) && <section className="dk-why"><h4>Why Girru asks</h4>{d.note && <p dir="auto">{d.note}</p>}{plainReasons(d.reasons).length > 0 && <p className="fine-print">{plainReasons(d.reasons).join(', ')}</p>}</section>}
    {d.changes.length > 1 && <label className="dk-check"><input type="checkbox" checked={read} onChange={e => setRead(e.target.checked)}/>I read every change above</label>}
    <div className="actions"><button type="button" onClick={() => void c.approve('reject')} disabled={s.busy}>Reject</button>
      <button type="button" className="primary" onClick={() => void c.approve('approve')} disabled={s.busy || (d.changes.length > 1 && !read)}>{d.changes.length > 1 ? 'Approve the changes' : 'Remember'}</button></div>
    <p className="fine-print">The agent wrote this text. It is information only: it cannot change permissions or give instructions.</p>
  </article>;
}

function NeedsList({ c, keys }: { c: MemoryReviewController; keys: (e: KeyboardEvent<HTMLElement>) => void }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const [show, setShow] = useState(false);
  const [read, setRead] = useState(false);
  useEffect(() => setRead(false), [s.checked.length]);
  const visible = c.visible();
  const filterLabel = s.groupBy === 'kind' ? (FILTERS.find(f => f[0] === s.filter)?.[1] ?? 'All') : s.group ? c.groupName(s.group) : 'All';
  return <div className="dk-needs-list" tabIndex={-1} onKeyDown={keys}>
    <div className="dk-list-bar">
      <label className="dk-check"><input type="checkbox" aria-label="Select all" checked={visible.some(i => !isSensitive(i.summary)) && visible.every(i => isSensitive(i.summary) || s.checked.includes(i.key))} onChange={e => c.checkAll(e.target.checked)}/>{visible.length} {visible.length === 1 ? 'question' : 'questions'}</label>
      <span className="dk-anchor" data-popover-anchor><button type="button" className="dk-pill" onClick={() => setShow(v => !v)}><UiIcon name="filter" size={12}/>Show: {filterLabel}</button>
        <Popover open={show} onClose={() => setShow(false)} label="Show" wide><div className="dk-filter">
          <h4>Show</h4>
          <div className="dk-chips">{FILTERS.map(([f, label]) => <button key={f} type="button" className="dk-chip-button" aria-pressed={s.groupBy === 'kind' && s.filter === f} onClick={() => { if (s.groupBy !== 'kind') void c.setGroupBy('kind'); c.setFilter(f); }}>{label} <span className="dk-count">{c.count(f)}</span></button>)}</div>
          <h4>Group by</h4>
          <div className="dk-segmented" role="group" aria-label="Group by">{([['kind', 'Type'], ['scope', 'Project'], ['department', 'Department'], ['agent', 'Agent']] as const).map(([v, l]) => <button key={v} type="button" aria-pressed={s.groupBy === v} onClick={() => void c.setGroupBy(v)}>{l}</button>)}</div>
          {s.groupBy !== 'kind' && <div className="dk-chips">{s.groups === null ? <span className="fine-print">Grouping…</span> : s.groups.map(g => <button key={g.key} type="button" className="dk-chip-button" aria-pressed={s.group === g.key} onClick={() => c.setGroup(s.group === g.key ? null : g.key)}>{c.groupName(g.key)} <span className="dk-count">{g.count}</span></button>)}</div>}
          {s.routine ? <div className="dk-ask"><p>{s.routine.count ? `Accept ${s.routine.count} routine ${s.routine.count === 1 ? 'fact' : 'facts'}? Conflicts and important facts stay here.` : 'No routine fact waits.'}</p>
            <div className="actions"><button type="button" onClick={() => c.cancelRoutine()}>Cancel</button>{s.routine.count > 0 && <button type="button" className="primary" disabled={s.busy} onClick={() => void c.acceptRoutine()}>Accept {s.routine.count}</button>}</div></div>
            : <button type="button" disabled={s.busy} onClick={() => void c.previewRoutine()}>Accept all routine…</button>}
          <p className="fine-print">Keys: J / K next · A keep new · O keep old · B keep both</p>
        </div></Popover></span>
      <span className="dk-toolbar-gap"/>
      {s.checked.length > 0 && <>
        <label className="dk-check"><input type="checkbox" checked={read} onChange={e => setRead(e.target.checked)}/>I read the selected</label>
        <button type="button" disabled={!read || s.busy} onClick={() => { c.askBulk('reject'); void c.bulk(); }}>Reject {s.checked.length}</button>
        <button type="button" className="primary" disabled={!read || s.busy} onClick={() => { c.askBulk('approve'); void c.bulk(); }}>Approve {s.checked.length}</button>
      </>}
    </div>
    {s.result && <p className="dk-inline-ok" role="status">{s.result}</p>}
    {s.notice && <p className="dk-inline-notice" role="alert">{s.notice}</p>}
    <div className="dk-split">
      <div className="dk-list" role="listbox" aria-label="Questions">{visible.map(i => <div key={i.key} className="dk-row" role="option" aria-selected={s.open === i.key} data-checked={s.checked.includes(i.key) || undefined} onClick={() => void c.openItem(i.key)}>
        <input type="checkbox" aria-label="Select" checked={s.checked.includes(i.key)} onClick={e => e.stopPropagation()} onChange={() => c.toggleCheck(i.key)}/>
        <span className="dk-row-icon"><UiIcon name={KIND_ICON[i.kind]} size={14}/></span>
        <span className="dk-row-text"><span className="dk-row-main" dir="auto">{s.texts[i.key] ?? (i.link ? `${i.link.from.name} → ${i.link.to.name}` : '…')}</span><span className="dk-row-sub">{KIND_WORD[i.kind]} · {c.label(i)}</span>{i.summary && isFlagged(i.summary.reasons) && <span className="dk-chips"><PrivacyChips reasons={i.summary.reasons} privacy={i.summary.privacy}/></span>}</span>
      </div>)}</div>
      <div className="dk-split-detail"><Question c={c}/></div>
    </div>
  </div>;
}

const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
/** A plain name for a colour code ("Dark blue"), so the choice reads as words, not a code. */
function colourName(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim()); if (!m) return 'Colour';
  const n = parseInt(m[1], 16), [r, g, b] = [n >> 16 & 255, n >> 8 & 255, n & 255].map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (sat < 0.15) return l < 0.15 ? 'Black' : l > 0.9 ? 'White' : l < 0.4 ? 'Dark grey' : l > 0.7 ? 'Light grey' : 'Grey';
  const h = (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  const hue = h < 15 || h >= 345 ? 'red' : h < 40 ? 'orange' : h < 65 ? 'yellow' : h < 160 ? 'green' : h < 190 ? 'teal' : h < 255 ? 'blue' : h < 290 ? 'purple' : 'pink';
  const word = l < 0.35 ? `Dark ${hue}` : l > 0.7 ? `Light ${hue}` : hue[0].toUpperCase() + hue.slice(1);
  return word;
}
/** Board M31 J4: only a real disagreement in a project's design asks (two main colours), one question each. */
function DesignQuestions({ d }: { d: MemoryDesktopController }) {
  const [list, setList] = useState<Awaited<ReturnType<MemoryDesktopController['designConflicts']>> | null>(null);
  useEffect(() => { let live = true; void d.designConflicts().then(x => { if (live) setList(x); }); return () => { live = false; }; }, [d]);
  if (!list?.length) return null;
  const q = list[0];
  return <article className="dk-question">
    <h3><UiIcon name="palette" size={15}/>Two main colours for {q.project}</h3>
    <div className="dk-versus">{q.options.slice(0, 2).map((o, i) => <div key={o.value} className="dk-colour-choice">
      <p><span className="dk-swatch dk-swatch-big" style={{ background: o.value }} aria-hidden="true"/><span><b>{colourName(o.value)}</b><span className="fine-print" title={o.source}>From {fileName(o.source)} · <span dir="ltr">{o.value}</span></span></span></p>
      <button type="button" className={i === 0 ? 'primary' : undefined} aria-label={`Use ${colourName(o.value).toLowerCase()} ${o.value} from ${fileName(o.source)}`} onClick={() => void d.setMainColour(q.project, o.value).then(ok => { if (ok) setList(list.slice(1)); })}>Use this colour</button>
    </div>)}</div>
    <p className="fine-print">Only a real disagreement asks you. Everything else is added on its own.</p>
  </article>;
}

// ---------------------------------------------------------------- P9d chips
const DATA_WORD: Record<PrivacyFlags['personalData'][number], string> = { email: 'e-mail', phone: 'phone', 'bank-account': 'bank account', card: 'card', address: 'address', 'id-number': 'ID number' };
const isFlagged = (reasons: readonly string[]) => reasons.includes(PERSONAL_DATA) || reasons.includes(SPECIAL_CATEGORY);
/** "Keep in People › Lena", "Keep in About you". */
function keepIn(drawerId: string) {
  const i = drawerId.indexOf(':');
  if (i < 0) return `Keep in ${drawerName(drawerId)}`;
  const kind = drawerId.slice(0, i), key = drawerId.slice(i + 1);
  return kind === 'people' ? `Keep in People › ${personName(key)}` : `Keep in ${drawerName(drawerId).replace(' · ', ' › ')}`;
}
/** Board P9d: two chips only, the kinds and topics, never the values. */
export function PrivacyChips({ reasons, privacy }: { reasons: readonly string[]; privacy?: PrivacyFlags }) {
  const data = reasons.includes(PERSONAL_DATA), sensitive = reasons.includes(SPECIAL_CATEGORY);
  return <>
    {sensitive && <span className="dk-chip dk-privacy" data-tone="sensitive"><UiIcon name="shield" size={11}/>Sensitive{privacy?.sensitive.length ? ` · ${privacy.sensitive.join(', ')}` : ''}</span>}
    {data && <span className="dk-chip dk-privacy" data-tone="data"><UiIcon name="contact" size={11}/>Personal data{privacy?.personalData.length ? ` · ${privacy.personalData.map(k => DATA_WORD[k]).join(', ')}` : ''}</span>}
  </>;
}
