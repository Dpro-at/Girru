import {useEffect, useState} from 'react';
import type {SessionClient} from './session';
import {useCardAttempt} from './ComputerDevices';
import {ComputerTaskRequest} from './ComputerTaskRequest';
import {UiIcon} from './ui-icons';

/**
 * CP5 card details: the task that runs on another computer — where and from where, its live steps,
 * and Open its chat · Stop. CP7e: while the other computer has not allowed it, Send elsewhere….
 * The result arrives as the card's comment (with the computer as its author).
 */
export function ComputerCardPanel({client, cardId, boardId, cardVersion, title, sessionId, onOpenChat}: {client: SessionClient; cardId: string; boardId: string; cardVersion: number; title: string; sessionId?: string | null; onOpenChat?: (id: string) => void}) {
  const a = useCardAttempt(cardId, sessionId);
  const [notice, setNotice] = useState('');
  const [elsewhere, setElsewhere] = useState(false);
  if (!a) return null;
  const live = ['queued', 'waiting_approval', 'scheduled', 'accepted', 'running'].includes(a.state);
  const stop = async () => {
    try { const r = await client.request({method: 'POST', path: `/api/computers/tasks/${encodeURIComponent(a.taskId)}/cancel`}); setNotice(r.status === 200 ? 'Stopping the task.' : 'It could not be stopped.'); }
    catch { setNotice('It could not be stopped.'); }
  };
  const chat = a.sourceSessionId ?? null;
  return <section className="cp-card-panel" aria-label="On another computer">
    <span className="cp-card-where"><UiIcon name="screen" size={16}/>Runs on {a.targetName} · sent by {a.sourceName}</span>
    {a.state === 'waiting_approval' && <p className="cp-card-wait">{a.targetName} has not allowed it yet. It waits there in Needs you.</p>}
    {a.steps?.length > 0 && <>
      <span className="cp-card-label">Steps (live)</span>
      <ol className="cp-steps">{a.steps.map((s, i) => <li key={i} className={`is-${s.state}`}><i aria-hidden="true"/>{s.title}</li>)}</ol>
    </>}
    {!a.steps?.length && live && <p className="cp-card-wait">{a.statusLabel}.</p>}
    {a.state === 'completed' && <p className="cp-card-done"><UiIcon name="check" size={14}/>Done on {a.targetName}. The result is in the comments.</p>}
    {a.state === 'completed' && a.sourceDevice !== a.targetDevice && <BringWorkBack client={client} taskId={a.taskId} targetName={a.targetName}/>}
    {['cancelled', 'unknown', 'blocked'].includes(a.state) && <p className="cp-card-wait">{a.statusLabel}. {a.detail.split('\n')[0].slice(0, 200)}</p>}
    <span className="cp-card-actions">
      {chat && onOpenChat && <button type="button" className="cp-soft" onClick={() => onOpenChat(chat)}>Open its chat</button>}
      {a.state === 'waiting_approval' && <button type="button" className="cp-soft" onClick={() => setElsewhere(true)}>Send elsewhere…</button>}
      {live && <button type="button" className="cp-stop" onClick={() => void stop()}>Stop</button>}
    </span>
    {notice && <p role="status" className="cp-note">{notice}</p>}
    {elsewhere && <ComputerTaskRequest client={client} card={{boardId, cardId, cardVersion}} title={title} openNow onClosed={() => setElsewhere(false)}/>}
  </section>;
}

type WorkBack = {result: {mode: 'github' | 'direct' | 'too_large' | 'none'; branch: string | null; files: {path: string; added: number; removed: number}[]; state: string; from: string} | null; projects: {id: string; name: string}[]; suggested: string | null};

/**
 * CP10c Bring the work back: the files another computer changed (from its GitHub branch, or sent
 * directly), then Bring into the project here. Nothing is written into the folder before that press,
 * and it is not committed: you look at it and save it as usual.
 */
export function BringWorkBack({client, taskId, targetName}: {client: SessionClient; taskId: string; targetName: string}) {
  const [data, setData] = useState<WorkBack | null>(null);
  const [project, setProject] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ok: true} | {ok: false; conflicts: string[]} | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => { let live = true; const load = () => void client.request({method: 'GET', path: `/api/computers/tasks/${encodeURIComponent(taskId)}/result`}).then(r => { if (live && r.status === 200) setData(r.body as WorkBack); }).catch(() => {}); load(); const t = setInterval(load, 10_000); return () => { live = false; clearInterval(t); }; }, [client, taskId]);
  const r = data?.result;
  if (!r || r.mode === 'none') return null;
  const chosen = project || data?.suggested || data?.projects[0]?.id || '';
  const name = data?.projects.find(p => p.id === chosen)?.name ?? 'the project';
  const bring = async () => {
    setBusy(true); setNotice('');
    try { const x = await client.request({method: 'POST', path: `/api/computers/tasks/${encodeURIComponent(taskId)}/bring`, body: {projectId: chosen, confirmed: true}}); if (x.status === 200) setOutcome(x.body as typeof outcome); else setNotice('It could not be brought in. Check that the project has a folder here.'); }
    catch { setNotice('It could not be brought in.'); } finally { setBusy(false); }
  };
  const added = r.files.reduce((n, f) => n + f.added, 0), removed = r.files.reduce((n, f) => n + f.removed, 0);
  return <div className="cp-bring">
    <b>{targetName} finished: {r.files.length} {r.files.length === 1 ? 'file' : 'files'} changed</b>
    <span className="cp-note">{r.mode === 'github' ? `Its changes are on the branch ${r.branch}.` : r.mode === 'direct' ? 'Its changes came here directly, encrypted.' : 'The changes are too large to send directly; they stay on that computer.'} <span className="cp-plus">+{added}</span> <span className="cp-minus">−{removed}</span></span>
    <ul className="cp-bring-files">{r.files.slice(0, 8).map(f => <li key={f.path}><span className="cp-grow">{f.path}</span>{f.added > 0 && <span className="cp-plus">+{f.added}</span>}{f.removed > 0 && <span className="cp-minus">−{f.removed}</span>}</li>)}{r.files.length > 8 && <li className="cp-note">and {r.files.length - 8} more</li>}</ul>
    {r.state === 'brought' || outcome?.ok ? <p className="cp-card-done"><UiIcon name="check" size={14}/>Brought into {name}. Look at the changes there and save them as usual.</p>
      : r.mode === 'too_large' ? null
      : outcome && !outcome.ok ? <p className="cp-warn">{targetName} and this computer both changed {outcome.conflicts.length ? outcome.conflicts.join(', ') : 'the same lines'}. The parts that fit are in {name}; the rest is marked in the files for you to choose.</p>
      : <span className="cp-card-actions">
        {(data?.projects.length ?? 0) > 1 && <select aria-label="Project" value={chosen} onChange={e => setProject(e.target.value)}>{data!.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
        <button type="button" className="primary" disabled={busy || !chosen} onClick={() => void bring()}>{busy ? 'Bringing…' : `Bring into ${name}`}</button>
      </span>}
    {!data?.projects.length && <p className="cp-note">No project here has a folder yet. Add the project’s folder first.</p>}
    {notice && <p role="status" className="cp-note">{notice}</p>}
  </div>;
}
