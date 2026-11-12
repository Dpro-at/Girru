import { useState, type ReactNode, useRef } from 'react';
import type { Publication } from './connections-contract.js';
import { UiIcon, type UiIconName } from './ui-icons';
import realistic from '../assets/genvr/style-realistic.webp';
import blocky from '../assets/genvr/style-blocky.webp';
import anime from '../assets/genvr/style-anime.webp';
import voxel from '../assets/genvr/style-voxel.webp';
import worldFree from '../assets/genvr/world-free.webp';
import worldSide from '../assets/genvr/world-side.webp';
import worldTop from '../assets/genvr/world-top.webp';

/**
 * GV1 / GV1b (approved by Mohamed, 2026-11-11): GenVR opens on its places in the sidebar
 * (My spaces, On GenVR, Market, Motion lab); My spaces shows big cards; a card opens the place
 * with its settings sections in the sidebar; with no spaces, one create page.
 */
export interface SpaceRow {id: string; title: string; agentCount?: number; style?: string | null; sizeTier?: string | null; view?: string | null; orientation?: string | null; devices?: string[]; lab?: boolean}
export type GenVRPlace = 'spaces' | 'published' | 'market' | 'lab';
export interface CreateSpec {title: string; style: string; view: 'free' | 'side'; devices: string[]; orientation: 'landscape' | 'portrait' | 'any'; sizeTier: string}

/** later: the package cannot make this look yet (its own create page shows it as coming). */
export const STYLES: {id: string; name: string; sub: string; picture: string; later?: boolean}[] = [
  {id: 'blocky', name: 'Simple', sub: 'Fast on every phone', picture: blocky},
  {id: 'realistic', name: 'Realistic', sub: 'Real light and water', picture: realistic},
  {id: 'anime', name: 'Cartoon', sub: 'Painted colors', picture: anime, later: true},
  {id: 'voxel', name: 'Voxel', sub: 'Cube worlds', picture: voxel},
];
/** The package's size tiers (contracts SIZE_TIERS): side length and players. */
export const SIZES: {id: string; name: string; side: string; players: number; icon: string}[] = [
  {id: 'small', name: 'Small', side: '500 m', players: 30, icon: 'M9 9h6v6H9z'},
  {id: 'medium', name: 'Medium', side: '1 km', players: 50, icon: 'M7 7h10v10H7z'},
  {id: 'large', name: 'Large', side: '2 km', players: 100, icon: 'M5 5h14v14H5z'},
  {id: 'huge', name: 'Huge', side: '4 km', players: 100, icon: 'M3 3h18v18H3z'},
  {id: 'max', name: 'Biggest', side: '8 km', players: 100, icon: 'M2 2h20v20H2zM6 6h12v12H6z'},
];
export const DEVICES: {id: string; name: string; icon: string; later?: boolean}[] = [
  {id: 'phone', name: 'Phone', icon: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2'},
  {id: 'tablet', name: 'Tablet', icon: 'M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2'},
  {id: 'computer', name: 'Computer', icon: 'M3 5h18v11H3zM8 20h8M12 16v4'},
  {id: 'tv', name: 'TV with a controller', icon: 'M3 6h18v11H3zM8 21h8M9 3l3 3 3-3'},
  {id: 'vr', name: 'VR headset', icon: 'M3 9h18v7h-6l-2-2h-2l-2 2H3zM7 12h.01M17 12h.01', later: true},
];
export const SCREENS: {id: CreateSpec['orientation']; name: string; icon: string}[] = [
  {id: 'landscape', name: 'Landscape', icon: 'M3 7h18v10H3z'},
  {id: 'portrait', name: 'Portrait', icon: 'M7 3h10v18H7z'},
  {id: 'any', name: 'Either way', icon: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7'},
];
export const SECTIONS: {id: string; name: string; icon: string}[] = [
  {id: 'basic', name: 'Basic info', icon: 'M4 6h16M4 12h16M4 18h10'},
  {id: 'pictures', name: 'Pictures', icon: 'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4'},
  {id: 'play', name: 'How it is played', icon: 'M6 12h4M8 10v4M15 11h.01M18 13h.01M3 8h18v8H3z'},
  {id: 'game', name: 'Game', icon: 'M12 3l3 6 6 1-4.5 4 1 6-5.5-3-5.5 3 1-6L3 10l6-1z'},
  {id: 'blocks', name: 'Blocks', icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'},
  {id: 'avatars', name: 'Avatars', icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0'},
  {id: 'people', name: 'Collaborators', icon: 'M9 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 19a6 6 0 0 1 12 0M17 11a2.5 2.5 0 1 0 0-5M15 19a5 5 0 0 1 6 0'},
  {id: 'access', name: 'Access and publishing', icon: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3'},
  {id: 'available', name: 'Where it is available', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18'},
];

export const pictureOf = (style?: string | null) => STYLES.find(s => s.id === style)?.picture ?? realistic;
export const styleName = (style?: string | null) => STYLES.find(s => s.id === style)?.name ?? 'Realistic';
export const sizeLine = (tier?: string | null) => { const s = SIZES.find(x => x.id === (tier ?? 'small')) ?? SIZES[0]; return `${s.name} · ${s.side} × ${s.side} · up to ${s.players} players`; };
export const playLine = (r: SpaceRow) => [r.view === 'side' ? '2D side view' : '3D', r.orientation === 'portrait' ? 'Portrait' : r.orientation === 'any' ? 'Either way' : 'Landscape', (r.devices?.length ? r.devices : ['phone', 'tablet', 'computer', 'tv']).map(d => DEVICES.find(x => x.id === d)?.name.replace(' with a controller', '') ?? d).join(', ')].join(' · ');

const Glyph = ({d, size = 14}: {d: string; size?: number}) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d}/></svg>;

/** The GenVR section's places in the app sidebar; inside a space, its settings sections instead. */
export function GenVRSidebar({place, onPlace, counts, inside, section, onSection, onBack}: {
  place: GenVRPlace; onPlace: (p: GenVRPlace) => void; counts: {spaces: number; published: number};
  inside?: SpaceRow | null; section?: string; onSection?: (id: string) => void; onBack?: () => void;
}) {
  if (inside) return <nav className="dk-sidebar genvr-places" aria-label={`${inside.title} settings`}>
    <button type="button" className="nav-item dk-place genvr-back" onClick={onBack}><UiIcon name="arrow-left" size={13}/><span className="dk-place-name">My spaces</span></button>
    <div className="genvr-inside-name"><img src={pictureOf(inside.style)} alt=""/><b>{inside.title}</b></div>
    {SECTIONS.filter(s => s.id !== 'blocks' || inside.style === 'voxel').map(s => <button key={s.id} type="button" className="nav-item dk-place" aria-current={section === s.id ? 'page' : undefined} onClick={() => onSection?.(s.id)}><Glyph d={s.icon} size={15}/><span className="dk-place-name">{s.name}</span></button>)}
  </nav>;
  const row = (id: GenVRPlace, name: string, icon: UiIconName, count?: number) => <button type="button" className="nav-item dk-place" aria-current={place === id ? 'page' : undefined} onClick={() => onPlace(id)}><UiIcon name={icon} size={15}/><span className="dk-place-name">{name}</span>{count ? <span className="dk-count">{count}</span> : null}</button>;
  return <nav className="dk-sidebar genvr-places" aria-label="GenVR">
    {row('spaces', 'My spaces', 'folder', counts.spaces)}
    {row('published', 'On GenVR', 'globe', counts.published)}
    {row('market', 'Market', 'store')}
    {row('lab', 'Motion lab', 'flask')}
  </nav>;
}

/** GV1 A: My spaces as big cards with their look's picture; a card goes inside the place, double-click opens the Studio. */
export function SpaceCards({spaces, onInside, onOpen, onNew}: {spaces: SpaceRow[]; onInside: (id: string) => void; onOpen: (id: string) => void; onNew: () => void}) {
  return <div className="genvr-cards" role="list" aria-label="My spaces">
    {spaces.map(s => <button key={s.id} type="button" role="listitem" className="genvr-card" title="Click to see its settings · double-click opens it in the Studio" onClick={() => onInside(s.id)} onDoubleClick={() => onOpen(s.id)}>
      <img src={pictureOf(s.style)} alt=""/><b>{s.title}</b><small>Private · {styleName(s.style)}</small>
    </button>)}
    <button type="button" className="genvr-card genvr-card-new" onClick={onNew}><UiIcon name="plus" size={20}/><span>New space</span></button>
  </div>;
}

/** GV1 "On GenVR": the places published from this workspace. */
export function PublishedCards({published}: {published: Publication[]}) {
  if (!published.length) return <div className="dk-empty"><p>Nothing published yet. Publish a space from its Access and publishing settings.</p></div>;
  return <div className="genvr-cards" role="list" aria-label="On GenVR">{published.map(p => <div key={p.serverId} role="listitem" className="genvr-card"><img src={realistic} alt="" className="genvr-dim"/><b>{p.title}</b><small>{p.status === 'published' ? `Published · ${p.access}` : 'Private on GenVR'}</small></div>)}</div>;
}

/** GV1b: inside a place. The chosen section in the middle, Open in Studio on top. */
export function SpaceInside({space, section, onOpen, onRename, children}: {space: SpaceRow; section: string; onOpen: () => void; onRename: (title: string) => Promise<void>; children?: ReactNode}) {
  const [name, setName] = useState(space.title), [notice, setNotice] = useState(''), [saving, setSaving] = useState(false);
  const current = SECTIONS.find(s => s.id === section && (s.id !== 'blocks' || space.style === 'voxel')) ?? SECTIONS[0];
  // Enter and leaving the field both save: one save at a time, and a name already being saved is not sent again.
  const sending = useRef('');
  const save = async () => { const next = name.trim(); if (!next || next === space.title || next === sending.current) return; sending.current = next; setSaving(true); setNotice(''); try { await onRename(next); setNotice('Saved.'); } catch { setNotice('It could not be saved. Try again.'); } finally { sending.current = ''; setSaving(false); } };
  const field = (label: string, value: ReactNode) => <div className="genvr-field"><small>{label}</small><span>{value}</span></div>;
  return <div className="genvr-inside">
    <header className="genvr-inside-head"><h2>{current.name}</h2><button type="button" className="primary" title="Open this place in the Studio (⌘O)" onClick={onOpen}><UiIcon name="play" size={13}/>Open in Studio</button></header>
    {current.id === 'basic' ? <>
      <img className="genvr-inside-picture" src={pictureOf(space.style)} alt=""/>
      <label className="genvr-field"><small>Name</small><input value={name} maxLength={120} onChange={e => setName(e.target.value)} onBlur={() => void save()} onKeyDown={e => { if (e.key === 'Enter') void save(); }} disabled={saving}/></label>
      {field('Look', styleName(space.style))}
      {field('Size', sizeLine(space.sizeTier))}
      {notice && <p role="status" className="fine-print">{notice}</p>}
    </> : children ?? <>
      {current.id === 'play' && field('How it is played', playLine(space))}
    </>}
    <span className="genvr-inside-foot fine-print">Changes save by themselves · My spaces in the sidebar goes back</span>
  </div>;
}

/** GV1 B: make a space in one step: name, look, how it is played, size; Create and open. */
export function CreateSpace({first, onCreate}: {first: boolean; onCreate: (spec: CreateSpec) => void}) {
  const [spec, setSpec] = useState<CreateSpec>({title: first ? 'My first space' : 'New space', style: 'realistic', view: 'free', devices: ['phone', 'tablet', 'computer', 'tv'], orientation: 'landscape', sizeTier: 'small'});
  const set = (patch: Partial<CreateSpec>) => setSpec(old => ({...old, ...patch}));
  const toggle = (d: string) => set({devices: spec.devices.includes(d) ? (spec.devices.length > 1 ? spec.devices.filter(x => x !== d) : spec.devices) : [...spec.devices, d]});
  const chip = (on: boolean, label: string, icon: string, act: () => void, later?: boolean, sub?: string) => <button type="button" className="genvr-chip" aria-pressed={on} disabled={later} onClick={act}><Glyph d={icon} size={sub ? 16 : 14}/>{sub ? <span className="genvr-chip-two"><b>{label}</b><small>{sub}</small></span> : label}{later && <small className="genvr-later">later</small>}</button>;
  return <div className="genvr-create">
    <h2>{first ? 'Make your first space' : 'New space'}</h2>
    <label className="genvr-field"><small>Name</small><input value={spec.title} maxLength={120} onChange={e => set({title: e.target.value})}/></label>
    <div className="genvr-group"><small>Look</small><div className="genvr-tiles four">{STYLES.map(s => <button key={s.id} type="button" className="genvr-tile" aria-pressed={spec.style === s.id} disabled={s.later} onClick={() => set({style: s.id})}><img src={s.picture} alt=""/><b>{s.name}{s.later && <span className="genvr-later"> later</span>}</b><small>{s.sub}</small></button>)}</div></div>
    <div className="genvr-group"><small>How it is played</small><div className="genvr-tiles three">
      <button type="button" className="genvr-tile" aria-pressed={spec.view === 'free'} onClick={() => set({view: 'free'})}><img src={worldFree} alt=""/><b>3D</b><small>Walk anywhere</small></button>
      <button type="button" className="genvr-tile" aria-pressed={spec.view === 'side'} onClick={() => set({view: 'side'})}><img src={worldSide} alt=""/><b>2D side view</b><small>Like a platform game</small></button>
      <button type="button" className="genvr-tile" disabled><img src={worldTop} alt=""/><b>2D top-down <span className="genvr-later">later</span></b><small>From above</small></button>
    </div></div>
    <div className="genvr-group"><small>Made for</small><div className="genvr-chips">{DEVICES.map(d => chip(spec.devices.includes(d.id), d.name, d.icon, () => toggle(d.id), d.later))}</div></div>
    <div className="genvr-group"><small>Phone screen</small><div className="genvr-chips">{SCREENS.map(s => chip(spec.orientation === s.id, s.name, s.icon, () => set({orientation: s.id})))}</div></div>
    <div className="genvr-group"><small>Size</small><div className="genvr-chips">{SIZES.map(s => chip(spec.sizeTier === s.id, s.name, s.icon, () => set({sizeTier: s.id}), false, `${s.side} × ${s.side} · ${s.players} players`))}</div></div>
    <button type="button" className="primary genvr-create-go" disabled={!spec.title.trim()} onClick={() => onCreate({...spec, title: spec.title.trim()})}>Create and open</button>
    <p className="fine-print">It starts private. Everything here can be changed later in Place settings.</p>
  </div>;
}
