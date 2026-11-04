// Settings › Phone (boards D6–D8): the paired phones; select one to see and
// change it in the inspector. ⋯ holds the rare choices.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { SessionClient } from './session';
import { UiIcon } from './ui-icons';
import { ContextMenu, Sheet, useMenu } from './desktop-ui';
import type { MenuItem } from './desktop-ui';
import { ConnectPhone } from './PhonePairing';
import { relayUrl as validRelay, phoneName } from './phone-contract.js';
import { WIFI_OFF, ago, codeOf, modelName, pathWords, phoneCall, shortDate, useNow } from './phone';
import type { PhoneDevice, PhoneLifetime, PhoneOverview, PhonePath } from './phone';

const LIFETIMES: Array<[PhoneLifetime, string]> = [[30, '30 days'], [60, '60'], [90, '90'], [120, '120'], [null, 'Always']];

function Segmented<T>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return <div className="phone-field"><span>{label}</span><div role="radiogroup" aria-label={label} className="phone-segmented">
    {options.map(([v, text]) => <button key={String(v)} type="button" role="radio" aria-checked={value === v} onClick={() => { if (value !== v) onChange(v); }}>{text}</button>)}</div></div>;
}

function PhoneRow({ d, selected, now, onSelect, onMenu, onOpen }: { d: PhoneDevice; selected: boolean; now: number; onSelect: () => void; onMenu: (e: ReactMouseEvent) => void; onOpen: () => void }) {
  return <button type="button" role="option" aria-selected={selected} tabIndex={selected ? 0 : -1} data-id={d.id} className="phone-row" onClick={onSelect} onDoubleClick={onOpen} onContextMenu={e => { onSelect(); onMenu(e); }}>
    <span className="phone-tile"><UiIcon name="mobile" size={17}/><span className="phone-dot" data-on={d.status === 'active' || undefined} aria-hidden="true"/></span>
    <span className="phone-row-text"><b><bdi>{d.name}</bdi></b><small>{d.status === 'expired' ? 'Signed out' : pathWords(d.path)} · used {ago(d.lastUsedAt, now)}</small></span>
  </button>;
}

/** The inspector of one phone. The name saves on Enter or when the field is left. */
function PhoneInspector({ d, now, onPatch, onForget }: { d: PhoneDevice; now: number; onPatch: (patch: Partial<Pick<PhoneDevice, 'name' | 'path' | 'lifetimeDays'>>) => void; onForget: () => void }) {
  const [name, setName] = useState(d.name);
  useEffect(() => setName(d.name), [d.id, d.name]);
  const saveName = () => { const n = name.trim(); if (n && n !== d.name && phoneName(n)) onPatch({ name: n }); else setName(d.name); };
  return <aside className="phone-inspector" aria-label={d.name}>
    <div className="phone-allow-head"><span className="phone-tile phone-tile-big"><UiIcon name="mobile" size={22}/></span><span><b><bdi>{d.name}</bdi></b><small>{modelName(d.model)} · paired {shortDate(d.pairedAt)}</small></span></div>
    <label className="phone-field"><span>Name</span><input id="phone-name" value={name} maxLength={64} spellCheck={false} onChange={e => setName(e.target.value)} onBlur={saveName} onKeyDown={e => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); if (e.key === 'Escape') setName(d.name); }}/></label>
    <Segmented label="Reaches this computer" value={d.path} options={[['anywhere', 'Anywhere'], ['wifi', 'Only on this Wi-Fi']]} onChange={(path: PhonePath) => onPatch({ path })}/>
    <Segmented label="Stays signed in after last use" value={d.lifetimeDays} options={LIFETIMES} onChange={(lifetimeDays: PhoneLifetime) => onPatch({ lifetimeDays })}/>
    <div className="phone-state"><span><span className="phone-dot" data-on={d.status === 'active' || undefined} aria-hidden="true"/>{d.status === 'active' ? `Signed in · ${d.path === 'anywhere' ? 'reaches this computer anywhere' : 'only on this Wi-Fi'}` : 'Signed out: not used for too long. Pair it again to use it.'}</span>
      <span>Last used {ago(d.lastUsedAt, now)}</span></div>
    <span className="phone-grow"/>
    <button type="button" className="phone-forget" onClick={onForget}>Forget this phone</button>
  </aside>;
}

export type PhoneSettingsProps = { overview: PhoneOverview | null; error?: boolean; selected: string | null; now: number; notice?: string;
  onSelect: (id: string) => void; onPair: () => void; onPatch: (id: string, patch: Partial<Pick<PhoneDevice, 'name' | 'path' | 'lifetimeDays'>>) => void;
  onForget: (d: PhoneDevice) => void; onMore: (e: ReactMouseEvent) => void; onRowMenu: (e: ReactMouseEvent, d: PhoneDevice) => void; onRetry: () => void };

/** Boards D6 and D8, without state. */
export function PhoneSettingsView(p: PhoneSettingsProps) {
  const list = useRef<HTMLDivElement>(null);
  const devices = p.overview?.devices ?? [];
  const d = devices.find(x => x.id === p.selected) ?? null;
  const onKey = (e: ReactKeyboardEvent) => {
    const i = devices.findIndex(x => x.id === p.selected);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = devices[Math.max(0, Math.min(devices.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) { p.onSelect(next.id); list.current?.querySelector<HTMLButtonElement>(`[data-id="${next.id}"]`)?.focus(); }
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && d) { e.preventDefault(); p.onForget(d); }
    else if (e.key === 'Enter' && d) { e.preventDefault(); document.getElementById('phone-name')?.focus(); }
  };
  return <div className="phone-settings">
    <div className="phone-main">
      <header className="phone-head"><div><h2 className="settings-page-title">Phone</h2><p className="settings-page-desc">Use Girru from your phone. Phones you allow can chat, see tasks and approve.</p></div>
        {devices.length > 0 && <>
          <button type="button" className="tool" title="More" aria-label="More" data-popover-anchor onClick={p.onMore}><UiIcon name="more" size={15}/></button>
          <button type="button" className="primary" onClick={p.onPair}><UiIcon name="plus" size={14}/>Pair a phone</button></>}
      </header>
      {p.notice && <p className="setup-note" role="status"><UiIcon name="info" size={14}/>{p.notice}</p>}
      {p.error ? <div className="phone-empty"><p>Could not read your phones.</p><button type="button" onClick={p.onRetry}>Try again</button></div>
        : !p.overview ? <p className="fine-print" role="status">Reading your phones…</p>
        : !devices.length ? <div className="phone-empty"><span className="phone-tile phone-tile-big"><UiIcon name="mobile" size={24}/></span><b>No phone yet</b><p>Pair your phone to chat and approve when you are away.</p><button type="button" className="primary" onClick={p.onPair}>Pair a phone</button></div>
        : <>
          <div ref={list} role="listbox" aria-label="Paired phones" className="phone-list" onKeyDown={onKey}>
            {devices.map(x => <PhoneRow key={x.id} d={x} selected={x.id === p.selected} now={p.now} onSelect={() => p.onSelect(x.id)} onMenu={e => p.onRowMenu(e, x)} onOpen={() => document.getElementById('phone-name')?.focus()}/>)}
          </div>
          <p className="fine-print phone-lock-note"><UiIcon name="lock" size={13}/>Messages between your phone and this computer are locked end to end. The Girru relay only passes them on and keeps nothing.</p>
        </>}
    </div>
    {d && <PhoneInspector d={d} now={p.now} onPatch={patch => p.onPatch(d.id, patch)} onForget={() => p.onForget(d)}/>}
  </div>;
}

type SheetKind = { kind: 'pair' } | { kind: 'forget'; d: PhoneDevice } | { kind: 'forget-all' } | { kind: 'relay' } | null;

export function PhoneSettings({ client, active = true }: { client: SessionClient; active?: boolean }) {
  const [overview, setOverview] = useState<PhoneOverview | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>();
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow(active, 30000);
  const menu = useMenu();
  const load = useCallback(async (select?: string) => {
    const r = await phoneCall(client, 'GET', '/api/phone');
    if (r.status !== 200 || !r.body) { setError(true); return; }
    const o = r.body as unknown as PhoneOverview;
    setError(false); setOverview(o);
    setSelected(s => select && o.devices.some(x => x.id === select) ? select : s && o.devices.some(x => x.id === s) ? s : o.devices[0]?.id ?? null);
  }, [client]);
  useEffect(() => { if (active) void load(); }, [active, load]);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(undefined), 6000); return () => clearTimeout(t); }, [notice]);
  const wifiOn = overview?.wifi === 'on';
  const patch = async (id: string, body: Partial<Pick<PhoneDevice, 'name' | 'path' | 'lifetimeDays'>>) => {
    if (body.path === 'wifi' && !wifiOn) { setNotice(WIFI_OFF); return; }
    const r = await phoneCall(client, 'PATCH', `/api/phone/devices/${id}`, body);
    if (r.status !== 200) setNotice('Could not save that change. Try again.');
    await load();
  };
  const forget = async (d: PhoneDevice) => {
    setBusy(true);
    const r = await phoneCall(client, 'DELETE', `/api/phone/devices/${d.id}`);
    setBusy(false); setSheet(null);
    setNotice(r.status === 200 ? `${d.name} is forgotten. It cannot reach this computer any more.` : 'Could not forget the phone. Try again.');
    await load();
  };
  const forgetAll = async () => {
    setBusy(true);
    const r = await phoneCall(client, 'POST', '/api/phone/devices/forget-all');
    setBusy(false); setSheet(null);
    setNotice(r.status === 200 ? 'Every phone is forgotten.' : 'Could not forget the phones. Try again.');
    await load();
  };
  const allWifi = async () => {
    if (!wifiOn) { setNotice(WIFI_OFF); return; }
    for (const d of overview?.devices ?? []) if (d.path !== 'wifi') await phoneCall(client, 'PATCH', `/api/phone/devices/${d.id}`, { path: 'wifi' });
    setNotice('Every phone now reaches this computer only on this Wi-Fi.');
    await load();
  };
  const rowItems = (d: PhoneDevice): MenuItem[] => [
    { label: 'Rename', icon: 'pencil', run: () => { setSelected(d.id); setTimeout(() => document.getElementById('phone-name')?.focus(), 0); } },
    { label: d.path === 'anywhere' ? 'Only on this Wi-Fi' : 'Reach it anywhere', icon: d.path === 'anywhere' ? 'wifi' : 'globe', run: () => void patch(d.id, { path: d.path === 'anywhere' ? 'wifi' : 'anywhere' }) },
    'sep',
    { label: 'Forget this phone…', icon: 'trash', danger: true, shortcut: '⌫', run: () => setSheet({ kind: 'forget', d }) },
  ];
  const moreItems: MenuItem[] = [
    { label: 'Only on this Wi-Fi for all phones', icon: 'wifi', run: () => void allWifi() },
    { label: 'Use your own relay…', icon: 'server', run: () => setSheet({ kind: 'relay' }) },
    'sep',
    { label: 'Forget all phones…', icon: 'trash', danger: true, run: () => setSheet({ kind: 'forget-all' }) },
  ];
  return <>
    <PhoneSettingsView overview={overview} error={error} selected={selected} now={now} notice={notice} onSelect={setSelected} onPair={() => setSheet({ kind: 'pair' })}
      onPatch={(id, b) => void patch(id, b)} onForget={d => setSheet({ kind: 'forget', d })} onMore={e => menu.at(e, moreItems)} onRowMenu={(e, d) => menu.at(e, rowItems(d))} onRetry={() => void load()}/>
    <ContextMenu menu={menu.menu} onClose={menu.close}/>
    {sheet?.kind === 'pair' && <Sheet title="Pair a phone" onClose={() => setSheet(null)} actions={<button type="button" onClick={() => setSheet(null)}>Done</button>}>
      <ConnectPhone client={client} onSettings={() => setSheet(null)} onPaired={id => { setSheet(null); void load(id); }}/>
    </Sheet>}
    {sheet?.kind === 'forget' && <Sheet title={`Forget ${sheet.d.name}?`} onClose={() => setSheet(null)} actions={<><button type="button" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="primary danger" disabled={busy} onClick={() => void forget(sheet.d)}>Forget</button></>}>
      <p>It can no longer reach this computer. To use it again, pair it again.</p>
    </Sheet>}
    {sheet?.kind === 'forget-all' && <Sheet title="Forget all phones?" onClose={() => setSheet(null)} actions={<><button type="button" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="primary danger" disabled={busy} onClick={() => void forgetAll()}>Forget all</button></>}>
      <p>No phone can reach this computer any more. To use one again, pair it again.</p>
    </Sheet>}
    {sheet?.kind === 'relay' && <RelaySheet client={client} current={overview?.relayUrl ?? ''} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); setNotice('Phones that reach this computer anywhere now use your relay.'); void load(); }}/>}
  </>;
}

function RelaySheet({ client, current, onClose, onSaved }: { client: SessionClient; current: string; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState(current);
  const [error, setError] = useState('');
  const ok = validRelay(value.trim());
  const save = async () => {
    if (!ok) { setError('Use an address like wss://relay.example.com/v1.'); return; }
    const r = await phoneCall(client, 'PUT', '/api/phone/settings', { relayUrl: value.trim() });
    if (r.status === 200) onSaved(); else setError(codeOf(r) === 'invalid_request' ? 'That relay address cannot be used.' : 'Could not save the relay. Try again.');
  };
  return <Sheet title="Use your own relay" onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={!ok} onClick={() => void save()}>Use this relay</button></>}>
    <label className="phone-field"><span>Relay address</span><input autoFocus value={value} spellCheck={false} aria-label="Relay address" onChange={e => { setValue(e.target.value); setError(''); }} onKeyDown={e => { if (e.key === 'Enter') void save(); }}/></label>
    <p className="fine-print">A relay you run yourself. Messages stay locked end to end; the relay only passes them on.</p>
    {error && <p className="setup-note" role="alert">{error}</p>}
  </Sheet>;
}
