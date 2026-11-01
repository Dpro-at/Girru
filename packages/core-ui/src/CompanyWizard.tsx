import { PersonalityPicker } from './PersonalityLibrary';
import { DepartmentTile } from './StaffDirectory';
import { libraryRpc, P, type Entry } from './personality-library';
import { UiIcon } from './ui-icons';
import { departmentIcon, departmentTone, tileStyle } from './agent-look';
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PointerEvent as PointerEv, KeyboardEvent as KeyEv } from 'react';
import { presetLabel } from './hire';
import { shareRoles, sharesTotal, shareSpecialties } from './company';
import { validSpecialties } from './hire-contract.js';
import type { CompanyController, CompanyKind, Share } from './company';
import type { WorkspaceType } from './WorkspaceTypeStep';
import { movePeople, rolesSummary } from './team-split';
import type { TeamRole } from './team-split';

/** Ready-made company sizes, in agents (D2; any other number up to the catalogue's maximum is typed in). */
const agentCounts = [3, 5, 10, 25, 50, 100, 250, 500] as const;
/** Departments ticked first for a new team, in this order, as far as the catalogue has them. */
const STARTERS = ['marketing', 'sales', 'support', 'development'];

/**
 * FIRSTRUN-01 (FR3, FR4c): how many → departments → the split → hire. The same flow is the
 * Team step of setup and Agents › ⋯ › Plan a bigger company.
 */
export function TeamFlow({ controller, mode, workspaceType, onBack, onHired, onClose }: { controller: CompanyController; workspaceType?: WorkspaceType; mode: 'setup' | 'planner'; onBack?: () => void; onHired?: () => void; onClose?: () => void }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [query, setQuery] = useState('');
  const [other, setOther] = useState('');
  const [custom, setCustom] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  // FR7: "What is your work?" is asked once, before the departments; null = not answered yet, '' = general work.
  const [kind, setKind] = useState<string | null>(null);
  const [kindQuery, setKindQuery] = useState('');
  const [allKinds, setAllKinds] = useState(true);
  const busy = ['loading', 'planning', 'hiring'].includes(s.phase);
  const bulk = s.total !== undefined || s.shares.length > 0 || !!s.batch;
  const entries = useLibrary(controller.client, s.shares, busy, controller);
  useEffect(() => { if (!s.catalogue && s.owner && s.phase !== 'loading') void controller.loadCatalogue(); }, [s.owner, s.catalogue]);
  // In setup, the hired team is shown as soon as everyone is hired (Mohamed 2026-10-30).
  const allHired = s.step === 'done' && (!s.batch || !s.batch.failed);
  useEffect(() => { if (allHired && mode === 'setup') onHired?.(); }, [allHired]);
  const choose = (n: number) => {
    if (!Number.isSafeInteger(n) || n < 1) return;
    controller.chooseTotal(n);
    setKind(null);
    // Pre-tick what fits the number: fewer departments for a small team.
    const want = n <= 3 ? 1 : n <= 10 ? 3 : 4;
    const ids = s.catalogue?.departments.map(d => d.id) ?? [];
    if (!controller.getSnapshot().departments.length) for (const id of STARTERS.filter(x => ids.includes(x)).slice(0, want)) controller.toggleDepartment(id);
  };
  const back = onBack ?? onClose;

  if (s.step === 'hiring' || s.step === 'done') {
    const b = s.batch;
    if (!bulk) {
      const chosen = s.hires.filter(h => h.include);
      return <section className="setup-pane" aria-label="Hiring your team">
        <h2>{s.step === 'done' ? 'Your team is ready' : 'Hiring your team'}</h2>
        <p>{s.step === 'done' ? `${chosen.length} new ${chosen.length === 1 ? 'agent has' : 'agents have'} joined your team.` : 'A few seconds.'}</p>
        {s.notice && <p role="status">{s.notice}</p>}
        {mode === 'planner' && s.step === 'done' && <div className="setup-actions"><button type="button" className="primary" onClick={onClose}>Back to team</button></div>}
      </section>;
    }
    const done = s.step === 'done' || !!b?.done;
    return <section className="setup-pane" aria-label="Hiring your team">
      <h2>{done && mode === 'planner' ? 'Your team is ready' : 'Hiring your team'}</h2>
      <p>{b && done && !b.failed ? `${b.created} new ${b.created === 1 ? 'agent has' : 'agents have'} joined your team.` : b ? `${b.created} of ${b.total} hired${b.failed ? `, ${b.failed} not hired` : ''}. If one fails, the others stay hired and you can try it again.` : 'Starting the hire…'}</p>
      <ul className="setup-progress" aria-label="Progress per department">{(b?.departments ?? []).map(d => { const label = s.shares.find(x => x.department === d.department)?.departmentLabel ?? d.department;
        return <li key={d.department}><b>{label}</b><progress max={d.total} value={d.created}>{d.created} of {d.total}</progress><span>{d.created} of {d.total}{d.failed ? ` · ${d.failed} not hired` : ''}</span></li>; })}</ul>
      {s.notice && <p role="status">{s.notice}</p>}
      {(s.step === 'done' || s.phase === 'stopped') && s.boardSetup === 'error' && <p role="status">Agents are kept. Board setup needs another attempt. <button type="button" onClick={() => void controller.setupBoards()}>Retry board setup</button></p>}
      <div className="setup-actions">
        {s.phase === 'stopped' && b && b.failed > 0 && b.pending === 0 && <button type="button" disabled={busy} onClick={() => void controller.retryFailed()}>Try the {b.failed} again</button>}
        {(s.phase === 'stopped' || s.phase === 'error') && !done && <button type="button" className="primary" disabled={busy} onClick={() => void controller.continueBatch()}>Continue</button>}
        {mode === 'planner' && !busy && <button type="button" className={done ? 'primary' : undefined} onClick={onClose}>Back to team</button>}
        {mode === 'setup' && done && b && b.failed > 0 && <button type="button" className="primary" onClick={onHired}>Go on without them</button>}
      </div>
    </section>;
  }

  if (s.step === 'review') {
    if (!bulk) {
      const chosen = s.hires.filter(h => h.include && h.status !== 'created');
      return <section className="setup-pane" aria-label="Your team">
        <h2>Your team</h2>
        <ul className="setup-split">{[...new Set(s.hires.map(h => h.department))].map(dep => { const list = s.hires.filter(h => h.department === dep);
          return <li key={dep}><b>{list[0].departmentLabel}</b><span>{list.map(h => h.name || h.title).join(', ')}</span></li>; })}</ul>
        <p className="fine-print">Everyone starts Careful and asks you before doing anything outside Girru.</p>
        <div className="setup-actions"><button type="button" disabled={busy} onClick={() => controller.back()}>Back</button>
          <button type="button" className="primary" disabled={busy || !chosen.length} onClick={() => void controller.hireAll()}>Hire {chosen.length} {chosen.length === 1 ? 'agent' : 'agents'}</button></div>
      </section>;
    }
    const total = sharesTotal(s.shares);
    const share = s.shares.find(x => x.department === open);
    const invalid = s.shares.some(x => !validSpecialties(x.specialties, x.count));
    return <section className="setup-pane" aria-label="Your team">
      <h2>Your team</h2>
      <p>{total} {total === 1 ? 'agent' : 'agents'} over {s.shares.length} {s.shares.length === 1 ? 'department' : 'departments'}. {mode === 'setup' || s.shares.length > 6 ? 'Click a department to change its agent count, jobs or personality.' : 'Drag a line to move agents; click a department to change its jobs or personality.'}</p>
      {mode === 'setup' ? <div className="setup-review-grid">{s.shares.map(x => <button type="button" className="setup-review-row" key={x.department} disabled={busy} onClick={() => setOpen(x.department)} aria-label={`${x.departmentLabel}: ${x.count} agents. Edit jobs and personality`}><UiIcon name={departmentIcon(x.departmentLabel)} size={20}/><b>{x.departmentLabel}</b><span>{x.count}</span><UiIcon name="pencil" size={14}/></button>)}</div> : s.shares.length > 0 && <TeamPicture shares={s.shares} busy={busy} onOpen={setOpen} onMove={(a, b, [l, r]) => { controller.editShare(a.department, { count: l }); controller.editShare(b.department, { count: r }); }}/>}
      {mode !== 'setup' && <ul className="setup-split">{s.shares.map(x => <li key={x.department}><b>{x.departmentLabel}</b><span>{jobsLine(x)}</span>{!validSpecialties(x.specialties, x.count) && <span className="badge">Check specialties</span>}</li>)}</ul>}
      {share && <DepartmentJobs share={share} busy={busy} controller={controller} entries={entries} onClose={() => setOpen(null)}/>}
      <p className="fine-print">Everyone starts Careful and asks you before doing anything outside Girru.</p>
      {s.notice && <p role="status">{s.notice}</p>}
      <div className="setup-actions"><button type="button" disabled={busy} onClick={() => controller.back()}>Back</button>
        <button type="button" className="primary" disabled={busy || !total || invalid} onClick={() => void controller.hireBatch()}>Hire {total} {total === 1 ? 'agent' : 'agents'}</button></div>
    </section>;
  }

  if (workspaceType === 'company' && s.step === 'departments' && s.catalogue?.kinds?.length && kind === null) {
    const q = kindQuery.trim().toLowerCase();
    const found = s.catalogue.kinds.filter(k => k.label.toLowerCase().includes(q));
    const shown = q || allKinds ? found : found.slice(0, 13);
    return <KindStep workspaceType={workspaceType} kinds={shown} more={!q && !allKinds ? found.length - shown.length : 0} query={kindQuery} busy={busy}
      onQuery={setKindQuery} onMore={() => setAllKinds(true)} onBack={() => controller.back()}
      onDone={id => { if (id.startsWith('custom:')) { if (!controller.addCustom(id.slice(7))) return; } else if (id) controller.chooseKind(id); setKind(id); }}/>;
  }

  if (s.step === 'departments' && s.catalogue) {
    const mainWork = s.catalogue.kinds?.find(k => s.departments.includes(k.id));
    const list = s.catalogue.departments.filter(d => `${d.label} ${d.summary}`.toLowerCase().includes(query.trim().toLowerCase()));
    const known = new Set([...s.catalogue.departments, ...(s.catalogue.kinds ?? [])].map(d => d.id));
    return <section className="setup-pane" aria-label="Which departments?">
      <h2>Which departments?</h2>
      <p>{mainWork ? `Girru ticked what ${mainWork.label.toLowerCase()} work usually needs. Change it as you like.` : `Pick the work you need. Girru splits your ${s.total} ${s.total === 1 ? 'agent' : 'agents'} by what each department usually needs.`}</p>
      {mainWork && <button type="button" className="setup-mainwork" aria-pressed disabled={busy} onClick={() => controller.toggleDepartment(mainWork.id)}>
        <DepartmentTile department={mainWork.label} size={26}/><span><b>{mainWork.label}</b><small>Your main work</small></span><span className="badge setup-recommended">Your main work</span><UiIcon name="check" size={15}/></button>}
      <ul className="setup-departments">{list.map(d => { const on = s.departments.includes(d.id);
        return <li key={d.id}><button type="button" aria-pressed={on} disabled={busy} onClick={() => controller.toggleDepartment(d.id)}>
          <DepartmentTile department={d.label} size={26}/><span><b>{d.label}</b><small>{d.summary}</small></span>{on && <UiIcon name="check" size={15}/>}</button></li>; })}
        {s.departments.filter(d => !known.has(d)).map(d => <li key={d}><button type="button" aria-pressed onClick={() => controller.toggleDepartment(d)}><DepartmentTile department={d} size={26}/><span><b>{d}</b><small>Your own department</small></span><UiIcon name="check" size={15}/></button></li>)}
      </ul>
      <form className="setup-add" onSubmit={e => { e.preventDefault(); if (controller.addCustom(custom)) setCustom(''); }}>
        <UiIcon name="plus" size={13}/><input aria-label="Add your own department" placeholder="Add your own department" maxLength={64} value={custom} onChange={e => setCustom(e.target.value)}/>{custom.trim() && <button type="submit">Add</button>}
      </form>
      {s.notice && <p role="status">{s.notice}</p>}
      <div className="setup-actions"><button type="button" disabled={busy} onClick={() => controller.back()}>Back</button>
        <button type="button" className="primary" disabled={busy || !s.departments.length} onClick={() => void controller.propose()}>See the split</button></div>
    </section>;
  }

  return <section className="setup-pane" aria-label="How many agents do you want?">
    <h2>How many agents do you want?</h2>
    <p>Your Main agent leads them. You can hire or remove agents any time.</p>
    {!s.catalogue ? <p role="status">{s.notice ?? 'Reading the departments…'}</p> : <>
      <div className="setup-counts" role="radiogroup" aria-label="Number of agents">{agentCounts.map(n =>
        <button key={n} type="button" role="radio" aria-checked={s.total === n} onClick={() => choose(n)}><strong>{n}</strong><small>agents</small></button>)}</div>
      <form className="setup-other" onSubmit={e => { e.preventDefault(); choose(Number(other)); }}>
        <label>Another number<input type="number" inputMode="numeric" min={1} max={s.catalogue.maxTotal ?? 1000} value={other} onChange={e => setOther(e.target.value)}/></label><small>up to {s.catalogue.maxTotal ?? 1000}</small>
      </form>
      <p className="fine-print">More agents do more at once, and use more of your subscription.</p>
      {s.open.length > 0 && <p className="setup-note"><UiIcon name="info" size={14}/>Unfinished hiring: {s.open[0].created} of {s.open[0].total} hired. <button type="button" className="link-button" onClick={() => void controller.resume(s.open[0].id)}>Continue it</button></p>}
    </>}
    <div className="setup-actions">{back && <button type="button" onClick={back}>Back</button>}
      <button type="button" className="primary" disabled={!s.catalogue || !(Number(other) > 0)} onClick={() => choose(Number(other))}>Continue</button></div>
  </section>;
}

/** Agents › ⋯ › Plan a bigger company (FR4c): the same steps as setup, in a window over the team. */
export function CompanyWizard({ controller, onClose }: { controller: CompanyController; onClose: () => void }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const busy = ['loading', 'planning', 'hiring'].includes(s.phase);
  return <dialog ref={dialog} className="company-wizard company-planner" aria-label="Plan a bigger company" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <header className="company-planner-head"><h3>Plan a bigger company</h3>
      <button type="button" className="tool" aria-label="Close" title="Close" disabled={busy} onClick={onClose}><UiIcon name="close" size={14}/></button></header>
    <TeamFlow controller={controller} workspaceType="company" mode="planner" onClose={onClose}/>
  </dialog>;
}

function jobsLine(x: Share) {
  const jobs = shareSpecialties(x).filter(r => r.count > 0);
  return jobs.length ? jobs.map(r => r.count > 1 ? `${r.name} ×${r.count}` : r.name).join(', ') : rolesSummary(shareRoles(x));
}

/** FR3d: one department's jobs with − / +; the department's count follows the jobs, so counts always add up. */
function DepartmentJobs({ share, busy, controller, entries, onClose }: { share: Share; busy: boolean; controller: CompanyController; entries: readonly Entry[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.focus(); }, [share.department]);
  const rows = shareSpecialties(share);
  const set = (i: number, count: number) => {
    const next = rows.map((r, j) => j === i ? { ...r, count: Math.max(0, count) } : r);
    const total = next.reduce((n, r) => n + r.count, 0);
    if (total < 1) return;
    controller.editShare(share.department, { count: total });
    controller.editSpecialties(share.department, next);
  };
  const choices = (controller.getSnapshot().catalogue?.specialties ?? []).filter(c => c.department === share.department && !rows.some(r => r.name.toLowerCase() === c.name.toLowerCase()));
  return <div ref={box} tabIndex={-1} className="setup-popover" role="dialog" aria-label={`${share.departmentLabel}: jobs`} onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
    <header><b>{share.departmentLabel} · {share.count}</b><button type="button" className="tool" aria-label="Close" title="Close" onClick={onClose}><UiIcon name="close" size={13}/></button></header>
    <div className="setup-editor-grid"><section className="setup-editor-jobs"><h3>Jobs</h3>
    <ul>{rows.map((r, i) => <li key={r.name || i}><span>{r.name}</span><span className="setup-stepper">
      <button type="button" className="tool" aria-label={`One less ${r.name}`} disabled={busy || r.count < 1} onClick={() => set(i, r.count - 1)}><UiIcon name="minus" size={12}/></button>
      <b>{r.count}</b>
      <button type="button" className="tool" aria-label={`One more ${r.name}`} disabled={busy} onClick={() => set(i, r.count + 1)}><UiIcon name="plus" size={12}/></button></span></li>)}</ul>
    {choices.length > 0 && <label className="setup-popover-add">Add a job<select value="" disabled={busy} onChange={e => { const c = choices.find(x => x.name === e.target.value); if (c) { controller.editSpecialties(share.department, [...rows, { name: c.name, description: c.description, count: 1 }]); controller.editShare(share.department, { count: share.count + 1 }); } }}>
      <option value="">Choose from Specialties…</option>{choices.filter(c => !c.group).map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
      {[...new Set(choices.map(c => c.group).filter((g): g is string => !!g))].map(g => <optgroup key={g} label={g}>{choices.filter(c => c.group === g).map(c => <option key={c.name} value={c.name}>{c.name}</option>)}</optgroup>)}</select></label>}
    </section><section className="setup-editor-personality"><h3>Personality</h3>
    <div aria-label={`Personality for ${share.departmentLabel}`}><PersonalityPicker client={controller.client} value={share.personalities?.specialist} defaultId="temperament-balanced" disabled={busy} onPick={e => controller.editShare(share.department, { role: 'specialist', personality: { id: e.id, revision: e.revision } })}/></div>
    <small className="fine-print">{personalityLine(share, entries)}</small></section></div>
  </div>;
}

/** AG4b: the team as a picture, one coloured band per department sized by its people. Drag (or arrow keys on) the line between two bands to move people; click a band to change it. */
export function TeamPicture({ shares, busy = false, onOpen, onMove }: { shares: readonly Share[]; busy?: boolean; onOpen?: (department: string) => void; onMove?: (left: Share, right: Share, counts: [number, number]) => void }) {
  const total = sharesTotal(shares);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; left: number; right: number; last: number } | null>(null);
  const down = (i: number) => (e: PointerEv<HTMLSpanElement>) => {
    if (busy || !onMove) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, left: shares[i].count, right: shares[i + 1].count, last: 0 };
  };
  const move = (i: number) => (e: PointerEv<HTMLSpanElement>) => {
    const d = drag.current, width = box.current?.clientWidth ?? 0; if (!d || !width || !onMove) return;
    const people = Math.round((e.clientX - d.x) * total / width); if (people === d.last) return;
    d.last = people; onMove(shares[i], shares[i + 1], movePeople(d.left, d.right, people));
  };
  const key = (i: number) => (e: KeyEv<HTMLSpanElement>) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (!step || busy || !onMove) return;
    e.preventDefault(); onMove(shares[i], shares[i + 1], movePeople(shares[i].count, shares[i + 1].count, step));
  };
  return <div ref={box} className={`ag-team-picture${shares.length > 6 ? ' ag-team-grid' : ''}`} aria-label={`${total} agents over ${shares.length} departments`}>{shares.map((x, i) => { const tone = departmentTone(x.departmentLabel);
    return <Fragment key={x.department}>
      <button type="button" className="ag-band" disabled={!onOpen} style={{ flexGrow: Math.max(1, x.count), ...tileStyle(tone) }} aria-label={`${x.departmentLabel}: ${x.count} ${x.count === 1 ? 'agent' : 'agents'}. Change…`} onClick={() => onOpen?.(x.department)}>
        <span><UiIcon name={departmentIcon(x.departmentLabel)} size={14}/>{x.departmentLabel}</span><b>{x.count}</b><small>{rolesSummary(shareRoles(x))}</small>
      </button>
      {onMove && shares.length <= 6 && i < shares.length - 1 && <span className="ag-band-line" role="separator" tabIndex={busy ? -1 : 0} aria-orientation="vertical" aria-label={`Move people between ${x.departmentLabel} and ${shares[i + 1].departmentLabel}`}
        aria-valuemin={1} aria-valuemax={x.count + shares[i + 1].count - 1} aria-valuenow={x.count} title="Drag to move people" data-busy={busy || undefined}
        onPointerDown={down(i)} onPointerMove={move(i)} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onKeyDown={key(i)}/>}
    </Fragment>; })}</div>;
}


const teamRoleOrder: readonly TeamRole[] = ['manager', 'specialist', 'evaluator'];
export const teamRoleLabel: Record<TeamRole, string> = { manager: 'Managers', specialist: 'Specialists', evaluator: 'Reviewers' };

/** The library personalities for the split; a role without one gets the balanced default (as the picker did). */
function useLibrary(client: CompanyController['client'], shares: readonly Share[], busy: boolean, controller: CompanyController) {
  const [entries, setEntries] = useState<Entry[]>([]);
  useEffect(() => { let live = true; void libraryRpc<{ personalities: Entry[] }>(client, 'GET', P).then(r => { if (live) setEntries(r.personalities.filter(e => !e.archived)); }).catch(() => {}); return () => { live = false; }; }, [client]);
  useEffect(() => {
    const fallback = entries.find(e => e.id === 'temperament-balanced'); if (!fallback || busy) return;
    for (const x of shares) { const roles = shareRoles(x); for (const r of teamRoleOrder) if (roles[r] > 0 && !x.personalities?.[r]) controller.editShare(x.department, { role: r, personality: { id: fallback.id, revision: fallback.revision } }); }
  }, [entries, shares, busy, controller]);
  return entries;
}

/** One line of personalities per role: "Managers: Balanced · Specialists: Calm". */
export function personalityLine(share: Share, entries: readonly Pick<Entry, 'id' | 'profile'>[]) {
  const roles = shareRoles(share);
  return teamRoleOrder.filter(r => roles[r] > 0).map(r => `${teamRoleLabel[r]}: ${entries.find(e => e.id === share.personalities?.[r]?.id)?.profile.name ?? presetLabel[share.presets[r]]}`).join(' · ');
}


/** FR7a: one optional question before the departments, for a company or one person. */
export function KindStep({ workspaceType, kinds, more, query, busy, onQuery, onMore, onBack, onDone }: { workspaceType?: WorkspaceType; kinds: readonly CompanyKind[]; more: number; query: string; busy: boolean;
  onQuery: (q: string) => void; onMore: () => void; onBack: () => void; onDone: (id: string) => void }) {
  const [pick, setPick] = useState('');
  const [customKind, setCustomKind] = useState('');
  const customValid = /^[\p{L}\p{N} _-]{1,64}$/u.test(customKind.trim());
  return <section className="setup-pane" aria-label="What is your work?">
    <h2>{workspaceType === 'company' ? 'What does your company do?' : workspaceType === 'individual' ? 'What do you do?' : 'What is your work?'}</h2>
    <p>Choose your main work. Girru suggests departments to help with it. You can change them or skip this.</p>
    <label className="setup-search"><UiIcon name="search" size={13}/><input type="search" aria-label="Search kinds of work" placeholder="Search" value={query} onChange={e => onQuery(e.target.value)}/></label>
    <div className="setup-kinds" role="radiogroup" aria-label="Your work">
      {[{ id: '', label: 'Office and online work' }, ...kinds].map(k =>
        <label key={k.id || 'general'} className="setup-kind" data-on={pick === k.id || undefined}>
          <input type="radio" name="kind" disabled={busy} checked={pick === k.id} onChange={() => setPick(k.id)}/><span>{k.label}</span></label>)}
    </div>
    <label className="setup-kind" data-on={pick === '__custom' || undefined}><input type="radio" name="kind" disabled={busy} checked={pick === '__custom'} onChange={() => setPick('__custom')}/><span>Other company specialty</span></label>
    {pick === '__custom' && <label className="setup-company-name">Company specialty<input type="text" maxLength={64} value={customKind} disabled={busy} placeholder="Enter your company specialty" onChange={e => setCustomKind(e.target.value)}/><small>Up to 64 letters, numbers, spaces, hyphens or underscores. Added to your team departments.</small></label>}
    {more > 0 && <button type="button" className="link-button" onClick={onMore}>Show {more} more</button>}
    <div className="setup-actions"><button type="button" disabled={busy} onClick={onBack}>Back</button>
      <button type="button" className="link-button" disabled={busy} onClick={() => onDone('')}>Skip</button>
      <button type="button" className="primary" disabled={busy || (pick === '__custom' && !customValid)} onClick={() => onDone(pick === '__custom' ? `custom:${customKind.trim()}` : pick)}>Continue</button></div>
  </section>;
}
