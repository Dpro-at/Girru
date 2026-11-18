import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DEVICES, SCREENS, type SpaceRow } from './GenVRHome';
import { GENVR_PUBLISH_PAGE } from './genvr-contract.js';
import worldFree from '../assets/genvr/world-free.webp';
import worldSide from '../assets/genvr/world-side.webp';

/**
 * GV1b section pages (approved by Mohamed, 2026-11-12): the settings of one place, copied from the
 * package's Place settings. What a local space stores (how it is played, its game, the agents in it)
 * is changed here and saved at once; what GenVR keeps for a published place (pictures, blocks,
 * avatars, people, remixing) is shown with the reason it is not open yet.
 */
export interface SpaceAgentRow {id: string; avatar: number}
export interface SpaceDoc {project: Record<string, any>; revision: number; agents: SpaceAgentRow[]}
export interface RosterAgent {id: string; name: string; avatar: number | null}
export interface SpaceStore {
  load(): Promise<SpaceDoc>;
  /** Saves the whole project (and, when given, the agents in it); resolves to the new revision; rejects with Error('conflict') on a newer copy. */
  save(project: Record<string, any>, revision: number, agents?: SpaceAgentRow[]): Promise<number>;
  roster(): Promise<RosterAgent[]>;
}

/** The package's game limits (contracts GAME_LIMITS) and its new game (contracts newGame). */
export const GAME_LIMITS = {minPlayers: [1, 50], durationSec: [30, 1800], health: [1, 1000], respawnDelaySec: [0, 60], scoreGoal: [1, 1000]} as const;
export const newGame = () => ({match: {minPlayers: 2, durationSec: 300, countdownSec: 5, resultsSec: 10}, score: {from: 'kills'}, win: {by: 'highest_score'}});
const MOVES = [{id: 'double-jump', name: 'Double jump'}, {id: 'wall-jump', name: 'Wall jump'}, {id: 'dash', name: 'Dash'}];
const ORDER = ['phone', 'tablet', 'computer', 'tv', 'vr'];
const clamp = (value: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, value));

const Glyph = ({d, size = 14}: {d: string; size?: number}) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d}/></svg>;
const Chip = ({on, label, icon, act, off, sub}: {on: boolean; label: string; icon?: string; act?: () => void; off?: boolean; sub?: string}) =>
  <button type="button" className="genvr-chip" aria-pressed={on} disabled={off} onClick={act}>{icon && <Glyph d={icon}/>}{sub ? <span className="genvr-chip-two"><b>{label}</b><small>{sub}</small></span> : label}</button>;
const Group = ({label, hint, children}: {label: string; hint?: string; children: ReactNode}) => <div className="genvr-group"><small>{label}</small>{children}{hint && <p className="fine-print">{hint}</p>}</div>;
const Lead = ({children}: {children: ReactNode}) => <p className="genvr-lead">{children}</p>;
const Later = () => <p className="genvr-kept fine-print">GenVR keeps this for a published place. It opens here once the place is on GenVR.</p>;

/** A number that is saved when the field is left or Enter is pressed; Esc puts it back. */
function NumberField({label, value, range, unit, scale = 1, step = 1, disabled, onCommit}: {label: string; value: number; range: readonly [number, number]; unit: string; scale?: number; step?: number; disabled?: boolean; onCommit: (value: number) => void}) {
  const [text, setText] = useState(String(value / scale));
  useEffect(() => setText(String(value / scale)), [value, scale]);
  const commit = () => { const n = Number(text); if (!Number.isFinite(n) || text.trim() === '') { setText(String(value / scale)); return; } const next = clamp(Math.round(n * scale), range); setText(String(next / scale)); if (next !== value) onCommit(next); };
  return <label className="genvr-number"><span>{label}</span><input type="number" inputMode="decimal" aria-label={label} value={text} min={range[0] / scale} max={range[1] / scale} step={step} disabled={disabled} onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setText(String(value / scale)); }}/><small>{unit}</small></label>;
}

/** One section of a place, loaded from and saved to the local space. */
export function PlaceSection({section, store, published, onChanged}: {section: string; store: SpaceStore; published: boolean; onChanged: (patch: Partial<SpaceRow>) => void}) {
  const [doc, setDoc] = useState<SpaceDoc | null>(null), [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [notice, setNotice] = useState(''), [undo, setUndo] = useState<{text: string; project: Record<string, any>} | null>(null), [busy, setBusy] = useState(false);
  const [roster, setRoster] = useState<RosterAgent[] | null>(null), [adding, setAdding] = useState(false);
  const docRef = useRef<SpaceDoc | null>(null);
  const reload = () => { setState('loading'); void store.load().then(d => { docRef.current = d; setDoc(d); setState('ready'); }).catch(() => setState('error')); };
  useEffect(reload, [store]);
  useEffect(() => { if (section === 'people' && !roster) void store.roster().then(setRoster).catch(() => setRoster([])); }, [section, roster, store]);

  /** Saves at once; a newer copy elsewhere loads the place again. */
  const apply = async (project: Record<string, any>, agents?: SpaceAgentRow[], undoText?: string) => {
    const before = docRef.current; if (!before || busy) return false;
    setBusy(true); setNotice(''); const optimistic = {...before, project, ...(agents ? {agents} : {})}; docRef.current = optimistic; setDoc(optimistic);
    try {
      const revision = await store.save(project, before.revision, agents);
      docRef.current = {...optimistic, revision}; setDoc(docRef.current);
      setUndo(undoText ? {text: undoText, project: before.project} : null);
      onChanged({title: project.title, view: project.play?.view ?? null, orientation: project.play?.orientation ?? null, devices: project.play?.devices ?? []});
      return true;
    } catch (e) {
      docRef.current = before; setDoc(before);
      if (e instanceof Error && e.message === 'conflict') { setNotice('Changed elsewhere. It is loaded again; try once more.'); reload(); } else setNotice('It could not be saved. Try again.');
      return false;
    } finally { setBusy(false); }
  };

  if (state === 'loading') return <p role="status" className="fine-print">Loading…</p>;
  if (state === 'error' || !doc) return <div role="alert" className="genvr-row-line"><p>The settings could not be loaded.</p><button type="button" onClick={reload}>Try again</button></div>;
  const project = doc.project, play = project.play ?? {}, world = project.world ?? {};
  const setPlay = (patch: Record<string, any>) => void apply({...project, play: {...play, ...patch}});
  const foot = <>{notice && <p role="alert" className="fine-print">{notice}</p>}{undo && <p role="status" className="genvr-row-line fine-print">{undo.text}<button type="button" className="link-button" onClick={() => { const back = undo.project; setUndo(null); void apply(back); }}>Undo</button></p>}</>;

  if (section === 'play') {
    const devices: string[] = Array.isArray(play.devices) ? play.devices : [], moves: string[] = Array.isArray(play.moves) ? play.moves : [];
    const toggleDevice = (d: string) => { const next = devices.includes(d) ? devices.filter(x => x !== d) : [...devices, d]; if (next.length) setPlay({devices: ORDER.filter(x => next.includes(x))}); };
    const toggleMove = (m: string) => { const next = moves.includes(m) ? moves.filter(x => x !== m) : [...moves, m]; setPlay({moves: MOVES.map(x => x.id).filter(x => next.includes(x))}); };
    return <>
      <Lead>Phones turn to this screen shape while playing, and players see which devices it is made for.</Lead>
      <Group label="Players see it"><div className="genvr-tiles two">
        <button type="button" className="genvr-tile" aria-pressed={play.view !== 'side'} disabled={busy} onClick={() => setPlay({view: 'free'})}><img src={worldFree} alt=""/><b>3D</b><small>Walk anywhere</small></button>
        <button type="button" className="genvr-tile" aria-pressed={play.view === 'side'} disabled={busy} onClick={() => setPlay({view: 'side'})}><img src={worldSide} alt=""/><b>2D side view</b><small>Like a platform game</small></button>
      </div></Group>
      {play.view === 'side' && <Group label="Extra moves" hint="Platforms players pass through from below work in every 2D place."><div className="genvr-chips">{MOVES.map(m => <Chip key={m.id} on={moves.includes(m.id)} label={m.name} off={busy} act={() => toggleMove(m.id)}/>)}</div></Group>}
      <Group label="Phone screen"><div className="genvr-chips">{SCREENS.map(s => <Chip key={s.id} on={play.orientation === s.id} label={s.name} icon={s.icon} off={busy} act={() => setPlay({orientation: s.id})}/>)}</div></Group>
      <Group label="Made for" hint="At least one."><div className="genvr-chips">{DEVICES.map(d => <Chip key={d.id} on={devices.includes(d.id)} label={d.name} icon={d.icon} off={busy || d.later} act={() => toggleDevice(d.id)}/>)}</div></Group>
      {foot}
    </>;
  }

  if (section === 'game') {
    const game = world.game as Record<string, any> | undefined;
    const setGame = (next: Record<string, any> | undefined, undoText?: string) => { const w = {...world}; if (next) w.game = next; else delete w.game; void apply({...project, world: w}, undefined, undoText); };
    const change = (patch: Record<string, any>) => game && setGame({...game, ...patch});
    const teams = game?.teams ?? {mode: 'none', friendlyFire: false}, goal: number | null = game?.score?.goal ?? null;
    const extras = game ? [['counters', 'counters'], ['rules', 'rules'], ['hud', 'on-screen values']].map(([k, n]) => Array.isArray(game[k]) && game[k].length ? `${game[k].length} ${n}` : '').filter(Boolean) : [];
    return <>
      <Lead>Rules the server runs while people play: a match, teams, health, and score.</Lead>
      <Group label="Game"><div className="genvr-chips"><Chip on={!game} label="Off" off={busy} act={() => game && setGame(undefined, 'Game turned off.')}/><Chip on={!!game} label="On" off={busy} act={() => !game && setGame(newGame())}/></div></Group>
      {game && <>
        <Group label="Teams"><div className="genvr-chips"><Chip on={teams.mode !== 'two'} label="No teams" off={busy} act={() => change({teams: {...teams, mode: 'none'}})}/><Chip on={teams.mode === 'two'} label="Two teams" off={busy} act={() => change({teams: {...teams, mode: 'two'}})}/></div></Group>
        {teams.mode === 'two' && <Group label="Friendly fire"><div className="genvr-chips"><Chip on={!teams.friendlyFire} label="Off" off={busy} act={() => change({teams: {...teams, friendlyFire: false}})}/><Chip on={!!teams.friendlyFire} label="On" off={busy} act={() => change({teams: {...teams, friendlyFire: true}})}/></div></Group>}
        <div className="genvr-numbers">
          <NumberField label="Match length" unit="minutes" scale={60} step={0.5} range={GAME_LIMITS.durationSec} value={game.match?.durationSec ?? 300} disabled={busy} onCommit={durationSec => change({match: {...game.match, durationSec}})}/>
          <NumberField label="Players to start" unit="players" range={GAME_LIMITS.minPlayers} value={game.match?.minPlayers ?? 2} disabled={busy} onCommit={minPlayers => change({match: {...game.match, minPlayers}})}/>
          <NumberField label="Health" unit="points" range={GAME_LIMITS.health} value={game.health?.max ?? 100} disabled={busy} onCommit={max => change({health: {max}})}/>
          <NumberField label="Back in" unit="seconds after being knocked out" range={GAME_LIMITS.respawnDelaySec} value={game.respawn?.delaySec ?? 3} disabled={busy} onCommit={delaySec => change({respawn: {delaySec, protectSec: game.respawn?.protectSec ?? 2}})}/>
        </div>
        <Group label="Score to win"><div className="genvr-chips genvr-row-line">
          <Chip on={goal === null} label="Off" off={busy} act={() => goal !== null && change({score: {from: game.score?.from ?? 'kills'}})}/>
          <Chip on={goal !== null} label="On" off={busy} act={() => goal === null && change({score: {from: game.score?.from ?? 'kills', goal: 10}})}/>
          {goal !== null && <NumberField label="Points" unit="to win" range={GAME_LIMITS.scoreGoal} value={goal} disabled={busy} onCommit={value => change({score: {from: game.score?.from ?? 'kills', goal: value}})}/>}
        </div></Group>
        <details className="genvr-more"><summary>Counters, rules, ranking, end of the match, on screen and scripts</summary><p className="fine-print">{extras.length ? `This game has ${extras.join(', ')}. ` : ''}They are made in the Studio, where they can be tried at once. Open in Studio at the top.</p></details>
      </>}
      {foot}
    </>;
  }

  if (section === 'people') {
    const names = new Map((roster ?? []).map(a => [a.id, a.name]));
    const free = (roster ?? []).filter(a => !doc.agents.some(m => m.id === a.id));
    const setAgents = (agents: SpaceAgentRow[], text?: string) => void apply(project, agents, text);
    return <>
      <Lead>Who builds this place with you, and who can play it before others.</Lead>
      <Group label="Agents in this place" hint="They build here with you when you ask them in the Studio chat.">
        <ul className="genvr-people">{doc.agents.map(a => <li key={a.id}><span className="genvr-avatar" aria-hidden="true">{(names.get(a.id) ?? a.id).slice(0, 1).toUpperCase()}</span><b>{names.get(a.id) ?? a.id}</b><small>Builder</small><button type="button" className="tool" title="Take out of this place" aria-label={`Take ${names.get(a.id) ?? a.id} out of this place`} disabled={busy} onClick={() => setAgents(doc.agents.filter(m => m.id !== a.id))}><Glyph d="M6 6l12 12M18 6L6 18"/></button></li>)}
          {!doc.agents.length && <li className="fine-print">No agents yet.</li>}</ul>
        {adding ? <div className="genvr-chips">{free.length ? free.map(a => <Chip key={a.id} on={false} label={a.name} off={busy} act={() => { setAdding(false); setAgents([...doc.agents, {id: a.id, avatar: a.avatar ?? 0}]); }}/>) : <span className="fine-print">Every agent is already here.</span>}<button type="button" className="link-button" onClick={() => setAdding(false)}>Done</button></div>
          : <button type="button" className="genvr-add" disabled={busy || roster === null} onClick={() => setAdding(true)}><Glyph d="M12 5v14M5 12h14"/>Add an agent</button>}
      </Group>
      <Group label="Invite people"><div className="genvr-chips"><Chip on={false} label="Copy builder link" off/></div></Group>
      <Later/>
      {foot}
    </>;
  }

  if (section === 'access') return <>
    <Lead>Who can join, and whether the place is published.</Lead>
    <div className="genvr-status"><Glyph d="M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3" size={18}/><span><b>{published ? 'On GenVR' : 'Private on this computer'}</b><small>{published ? 'See it under On GenVR.' : 'Only you and the agents in it.'}</small></span>
      <a className="link-button" href={GENVR_PUBLISH_PAGE} target="_blank" rel="noopener noreferrer">Publish…</a></div>
    <Group label="Allow remixing" hint="Let people make an independent editable copy of your published public place. Copies start private and keep your name and the original place credit."><div className="genvr-chips"><Chip on label="Off" off/><Chip on={false} label="On" off/></div></Group>
    <Later/>
  </>;

  if (section === 'available') return <>
    <Lead>Your place goes wherever GenVR is, for the devices you chose in How it is played.</Lead>
    <ul className="genvr-where">{([
      ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18', 'Web browser', 'Phones, tablets, and computers', 'Available now', true],
      ['M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2', 'GenVR app for Android and iPhone', 'Google Play and the App Store', 'Coming', false],
      ['M4 6h16v10H4zM9 20h6', 'Steam', 'Computers', 'Later', false],
      ['M3 6h18v11H3zM8 21h8', 'Xbox and PlayStation', 'TVs with a controller', 'Later', false],
    ] as const).map(([icon, name, where, when, now]) => <li key={name}><Glyph d={icon} size={18}/><span><b>{name}</b><small>{where}</small></span><em data-now={now}>{when}</em></li>)}</ul>
  </>;

  if (section === 'pictures') return <>
    <Lead>The thumbnail and screenshots players see before they join.</Lead>
    <Group label="Thumbnail" hint="Shown on place cards. Until it is published, the look’s picture stands in."><div className="genvr-chips"><Chip on={false} label="Replace thumbnail" off/></div></Group>
    <Group label="Screenshots (0 of 5)" hint="Every picture is checked before players see it."><div className="genvr-chips"><Chip on={false} label="Add a screenshot" off/></div></Group>
    <Later/>
  </>;

  if (section === 'blocks') return <>
    <Lead>How the blocks of this place look. Everyone sees your choice when they join.</Lead>
    <Group label="Block look"><div className="genvr-chips"><Chip on label="Clean" sub="Smooth colors" off/><Chip on={false} label="Pixel" sub="Small pixel pictures" off/></div></Group>
    <Group label="Who may build" hint="You and your builders always may."><div className="genvr-chips">{['Everyone', 'Invited players', 'Nobody'].map(n => <Chip key={n} on={n === 'Nobody'} label={n} off/>)}</div></Group>
    <Later/>
  </>;

  if (section === 'avatars') return <>
    <Lead>How players look in this place. Changes apply when players join.</Lead>
    <Group label="Look"><div className="genvr-chips"><Chip on label="Their own look" sub="Everyone wears what they picked" off/><Chip on={false} label="No big extras" sub="No capes, wings or backpacks" off/><Chip on={false} label="Your outfit" sub="Everyone wears yours" off/></div></Group>
    <Group label="Body type"><div className="genvr-chips">{['Player’s choice', 'Robot only', 'Man only', 'Woman only'].map(n => <Chip key={n} on={n === 'Player’s choice'} label={n} off/>)}</div></Group>
    <p className="fine-print">Characters for agents and players are made in the Studio’s Avatar tab.</p>
    <Later/>
  </>;

  return null;
}
