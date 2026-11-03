// STORE-MAP-01 P9 (board P9c): Memory › People › a person. The ⋯ menu and the
// right-click menu hold "Export everything about X…" (⌘E) and "Forget X…"; the
// person's details show how much memory holds about them; two sheets save the
// export or forget the person in one action (the typed name is the only
// confirmation on this screen, because it cannot be undone).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { UiIcon } from './ui-icons';
import { Avatar, Sheet } from './desktop-ui';
import type { MenuItem } from './desktop-ui';
import { drawerName, oneLine } from './memory-store';
import { MemoryPeopleController, exportFileName, personName } from './memory-people';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent ?? '');
const mod = isMac ? '⌘' : 'Ctrl+';

export type PersonSheet = { kind: 'export-person'; key: string } | { kind: 'forget-person'; key: string };

function usePeople(c: MemoryPeopleController) { return useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot); }

/** The person's actions, for the toolbar ⋯ menu and the right-click menu. */
export function personMenu(key: string, open: (s: PersonSheet) => void): MenuItem[] {
  const name = personName(key);
  return [
    { label: `Export everything about ${name}…`, icon: 'download', shortcut: `${mod}E`, run: () => open({ kind: 'export-person', key }) },
    { label: `Forget ${name}…`, icon: 'trash', danger: true, run: () => open({ kind: 'forget-person', key }) },
  ];
}

/** The open person's details (board P9c1 inspector). */
export function PersonInspector({ c, personKey, staysLocal }: { c: MemoryPeopleController; personKey: string; staysLocal: boolean }) {
  const s = usePeople(c);
  useEffect(() => { void c.load(personKey); }, [c, personKey]);
  const name = personName(personKey);
  const data = s.person === personKey ? s.data : null;
  const here = data?.drawer.filter(m => m.status !== 'replaced').length;
  return <div className="dk-insp">
    <div className="dk-insp-head"><Avatar name={name} size={28}/><div><h3>{name}</h3></div></div>
    {s.phase === 'error' && s.person === personKey && <p className="dk-inline-notice" role="alert">{s.notice}</p>}
    <dl className="dk-facts">
      <dt>Memories</dt><dd>{data ? `${here} here · ${data.mentions.length} elsewhere mention ${name}` : '…'}</dd>
      <dt>Stays on this computer</dt><dd><UiIcon name="lock" size={13}/>{staysLocal ? 'On (People)' : 'Off'}</dd>
      <dt>Old facts</dt><dd>Replaced facts go after a year</dd>
    </dl>
    <p className="fine-print">Right-click {name} in the sidebar, or use ⋯, to export everything about {name} or forget {name}.</p>
  </div>;
}

/** Board P9c2 right: one file with everything about the person, saved where the owner chooses. */
export function ExportPersonSheet({ c, personKey, onClose, onSaved }: { c: MemoryPeopleController; personKey: string; onClose: () => void; onSaved: () => void }) {
  const s = usePeople(c);
  useEffect(() => { void c.load(personKey); }, [c, personKey]);
  const name = personName(personKey);
  const data = s.person === personKey ? s.data : null;
  const file = data ? exportFileName(data) : `person-${personKey}.json`;
  return <Sheet title={`Export everything about ${name}…`} onClose={onClose}
    actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={s.busy || s.phase === 'loading'} onClick={() => void c.saveFile(personKey).then(ok => { if (ok) onSaved(); })}>Save the file</button></>}>
    <p>One file ({file}) with {name}’s memories and replaced facts, memories that mention {name}, the memory map entries and handoff lines that name {name}. An agent’s own notes appear as a count only. Saved where you choose; nothing is sent.</p>
    {s.notice && s.person === personKey && <p className="dk-inline-notice" role="alert">{s.notice}</p>}
  </Sheet>;
}

/** Board P9c2 left: forget the person in one action. */
export function ForgetPersonSheet({ c, personKey, onClose, onExport, onForgotten }: { c: MemoryPeopleController; personKey: string; onClose: () => void; onExport: () => void; onForgotten: (text: string) => void }) {
  const s = usePeople(c);
  useEffect(() => { void c.load(personKey, true); }, [c, personKey]);
  const name = personName(personKey);
  const data = s.person === personKey ? s.data : null;
  const [picked, setPicked] = useState<string[] | null>(null);
  const [typed, setTyped] = useState('');
  // Every mention the export found starts chosen; the owner takes out what is not about this person.
  useEffect(() => { if (data && s.phase === 'ready' && picked === null) setPicked(data.mentions.map(m => m.id)); }, [data, s.phase, picked]);
  const mine = data?.drawer.length ?? 0;
  const confirmed = typed.trim().toLowerCase() === name.toLowerCase() || typed.trim() === personKey;
  const toggle = (id: string) => setPicked(p => (p ?? []).includes(id) ? (p ?? []).filter(x => x !== id) : [...(p ?? []), id]);
  async function forget() {
    const out = await c.forget(personKey, picked ?? []);
    if (out) onForgotten(`${name} was forgotten: ${out.drawer} ${out.drawer === 1 ? 'memory' : 'memories'}${out.mentions ? ` and ${out.mentions} ${out.mentions === 1 ? 'mention' : 'mentions'}` : ''}.`);
  }
  return <Sheet title={`Forget ${name}`} wide onClose={onClose}
    actions={<><button type="button" onClick={onExport}><UiIcon name="download" size={13}/>Export first…</button><button type="button" onClick={onClose}>Cancel</button>
      <button type="button" className="danger-solid" disabled={!data || s.phase !== 'ready' || !confirmed || s.busy} onClick={() => void forget()}>Forget {name}</button></>}>
    <div className="dk-person-forget">
      <p className="fine-print">This cannot be undone. Girru removes {name}’s memories with their history, and they stay forgotten even if you put a backup back.</p>
      {s.phase === 'loading' && !data && <p role="status">Reading what memory holds about {name}…</p>}
      {s.notice && <p className="dk-inline-notice" role="alert">{s.notice}</p>}
      {data && <>
        <section><h4>Always</h4><ul className="dk-person-always">
          <li><UiIcon name="check" size={13}/>{name}’s {mine} {mine === 1 ? 'memory' : 'memories'} and their history</li>
          {data.graph.length > 0 && <li><UiIcon name="check" size={13}/>{name} in the memory map</li>}
        </ul></section>
        {data.mentions.length > 0 && <section><h4>Memories elsewhere that mention {name} <span className="fine-print">Choose</span></h4>
          <div className="dk-person-mentions">{data.mentions.map(m => <label key={m.id} className="dk-check">
            <input type="checkbox" checked={(picked ?? []).includes(m.id)} onChange={() => toggle(m.id)}/>
            <span><span dir="auto">{oneLine(m.content)}</span><span className="fine-print">{drawerName(m.drawer)} · {m.why === 'graph' ? `linked to ${name}` : `names ${name}`}</span></span>
          </label>)}</div></section>}
        {data.handoffs.length > 0 && <p className="fine-print">Handoff notes that name {name} stay (they are work records); they are listed in the export so you can edit them.</p>}
        <label className="dk-field">Type {name} to confirm<input value={typed} autoComplete="off" spellCheck={false} onChange={e => setTyped(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && confirmed && s.phase === 'ready' && !s.busy) { e.preventDefault(); void forget(); } }}/></label>
      </>}
    </div>
  </Sheet>;
}
