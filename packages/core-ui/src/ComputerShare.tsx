import {useEffect, useState} from 'react';
import type {SessionClient} from './session';
import {UiIcon} from './ui-icons';
import type {UiIconName} from './ui-icons';

/**
 * CP6c “What my computers share”: a few switches, on by default. A switch adds every item of its kind
 * to what a computer that starts “Same as this one” may copy; nothing goes until that computer asks
 * and the owner presses Allow. Memory stays on each computer for now (D3).
 */
const GROUPS: ReadonlyArray<{key: string; name: string; note: string; icon: UiIconName; categories: string[]}> = [
  {key: 'agents', name: 'Agents and their personalities', note: 'The same on every computer', icon: 'person', categories: ['agent', 'personality', 'specialty']},
  {key: 'skills', name: 'Skills and rules', note: 'The same on every computer', icon: 'sparkle', categories: ['skill', 'rule']},
  {key: 'prefs', name: 'Panels and footer', note: 'The same on every computer', icon: 'sliders', categories: ['preferences']},
];
type Item = {category: string; localId: string; label?: string};
const root = '/api/computers/account';

export function ComputerShare({client}: {client: SessionClient}) {
  const [state, setState] = useState<{resources: Item[]; shared: Item[]; workspaceId: string | null} | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const load = async () => { try { const r = await client.request({method: 'GET', path: root + '/resources'}); if (r.status === 200) setState(r.body as any); else setState({resources: [], shared: [], workspaceId: null}); } catch { setState({resources: [], shared: [], workspaceId: null}); } };
  useEffect(() => { void load(); }, [client]);
  if (!state) return <p role="status" className="fine-print">Reading…</p>;
  const on = (g: typeof GROUPS[number]) => state.shared.some(s => g.categories.includes(s.category));
  const toggle = async (g: typeof GROUPS[number]) => {
    if (!state.workspaceId) { setNotice('Add a computer first; then you can choose what it shares.'); return; }
    const keep = on(g) ? state.shared.filter(s => !g.categories.includes(s.category)) : [...state.shared, ...state.resources.filter(r => g.categories.includes(r.category) && !state.shared.some(s => s.category === r.category && s.localId === r.localId))];
    if (keep.length > 100) { setNotice('That is more than 100 items. Share fewer kinds, or one item at a time below.'); return; }
    setBusy(true); setNotice('');
    try {
      const r = await client.request({method: 'POST', path: root + '/workspaces/resources', body: {workspaceId: state.workspaceId, resources: keep.map(x => ({category: x.category, localId: x.localId})), confirmed: true}});
      if (r.status !== 200) throw Error();
      await load();
    } catch { setNotice('It could not be saved. Try again.'); } finally { setBusy(false); }
  };
  return <div className="phone-list" role="list" aria-label="What my computers share">
    {GROUPS.map(g => { const count = state.resources.filter(r => g.categories.includes(r.category)).length; return <div key={g.key} className="phone-row" role="listitem">
      <span className="phone-tile"><UiIcon name={g.icon} size={15}/></span>
      <span className="phone-row-text"><b>{g.name}</b><small>{count ? `${g.note} · ${count}` : 'Nothing of this kind yet'}</small></span>
      <button type="button" role="switch" aria-checked={on(g)} aria-label={g.name} className={`computer-switch${on(g) ? ' is-on' : ''}`} disabled={busy || !count} onClick={() => void toggle(g)}><i/></button>
    </div>; })}
    <div className="phone-row" role="listitem"><span className="phone-tile"><UiIcon name="board" size={15}/></span><span className="phone-row-text"><b>Projects and their Boards</b><small>Each task brings its card; the project itself is on each computer (GitHub, a folder, or a copy).</small></span></div>
    <div className="phone-row" role="listitem"><span className="phone-tile"><UiIcon name="database" size={15}/></span><span className="phone-row-text"><b>Memory</b><small>Stays on each computer for now</small></span></div>
    {notice && <p role="status" className="fine-print">{notice}</p>}
  </div>;
}
