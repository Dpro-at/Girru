import type React from 'react';
import {useEffect, useState} from 'react';
import type {SessionClient} from './session';
import {Sheet} from './desktop-ui';
import {UiIcon} from './ui-icons';
import {useAccountStatus} from './ComputerJoin';
import {useComputerOverview} from './ComputerDevices';

/** “github.com/you/project” is enough; the secure web prefix is added here. */
const withScheme = (u: string) => (/^github\.com\//i.test(u) ? 'https' + '://' + u : u);

type Choices = {projects: {id: string; name: string; hasFolder: boolean; github: string | null}[]; agentId: string | null; boardId: string | null; columnId: string | null};

/**
 * CP10a: the project this computer works on. Get it from GitHub (into a folder you choose), or use a
 * project that is already here. Tasks for it from your other computers then land on this computer.
 */
export function ComputerWorksOn({client, onClose}: {client: SessionClient; onClose: () => void}) {
  const status = useAccountStatus(client);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [way, setWay] = useState<'github' | 'here' | 'copy'>('github');
  const view = useComputerOverview();
  const others = (view?.devices ?? []).filter(d => d.state !== 'revoked');
  const [from, setFrom] = useState('');
  const [copyName, setCopyName] = useState('');
  const [copyId, setCopyId] = useState<string | null>(null);
  const copy = copyId ? view?.copies?.find(c => c.requestId === copyId) : undefined;
  const [url, setUrl] = useState('');
  const [parent, setParent] = useState('');
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => { void client.request({method: 'GET', path: '/api/computers/works-on/choices'}).then(r => { if (r.status === 200) { const c = r.body as Choices; setChoices(c); if (!c.projects.some(p => p.hasFolder)) setWay('github'); } }).catch(() => setNotice('It could not be read. Try again.')); }, [client]);
  const here = (choices?.projects ?? []).filter(p => p.hasFolder);
  const workspaceId = status?.workspaces?.[0]?.id;
  const ready = !!choices?.agentId && !!choices.boardId && !!choices.columnId && !!workspaceId;
  const go = async () => {
    if (!choices || !ready) return;
    setBusy(true); setNotice('');
    try {
      let id = projectId || here[0]?.id || '';
      if (way === 'copy') {
        if (copy?.state === 'ready' && copy.projectId) id = copy.projectId;
        else {
          const r = await client.request({method: 'POST', path: '/api/computers/project-copy', body: {target: from || others[0]?.id, name: copyName.trim(), parent: parent.trim(), confirmed: true}});
          if (r.status !== 200) throw Error((r.body as {code?: string})?.code ?? 'copy');
          setCopyId((r.body as {requestId: string}).requestId); setNotice(''); return;
        }
      }
      if (way === 'github') {
        setNotice('Getting the project from GitHub…');
        const r = await client.request({method: 'POST', path: '/api/computers/works-on/clone', body: {url: withScheme(url.trim()), parent: parent.trim(), confirmed: true}});
        if (r.status !== 200) throw Error((r.body as {code?: string})?.code ?? 'clone');
        id = (r.body as {id: string}).id;
      }
      const d = await client.request({method: 'POST', path: '/api/computers/account/workspaces/destination', body: {workspaceId, projectId: id, agentId: choices.agentId, boardId: choices.boardId, columnId: choices.columnId, confirmed: true}});
      if (d.status !== 200) throw Error('destination');
      onClose();
    } catch (e) {
      const code = (e as Error).message;
      setNotice(code.includes('exists') ? 'A folder with that name is already there. Choose another place, or use “It is already on this computer”.' : code.includes('url') ? 'Use the project’s GitHub address, like github.com/you/project.' : code.includes('folder') ? 'Write the full path of an existing folder, like /Users/you/Projects.' : 'It could not be added. Check that this computer can reach GitHub and try again.');
    } finally { setBusy(false); }
  };
  return <Sheet title="The project this computer works on" onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={busy || !ready || (way === 'github' ? !url.trim() || !parent.trim() : way === 'copy' ? (copy ? copy.state !== 'ready' : !parent.trim() || !others.length) : !(projectId || here[0]))} onClick={() => void go()}>{busy ? 'Working…' : way === 'github' ? 'Get the project' : way === 'copy' ? (copy?.state === 'ready' ? 'Use this project' : copy ? 'Copying…' : 'Ask for a copy') : 'Use this project'}</button></>}>
    <div className="cp-choices" role="radiogroup" aria-label="Where it comes from">
      <button type="button" role="radio" aria-checked={way === 'github'} className={`cp-choice${way === 'github' ? ' is-on' : ''}`} onClick={() => setWay('github')}><span className="cp-tile" style={{'--tint': '#9DBBFF'} as React.CSSProperties}><UiIcon name="globe" size={18}/></span><span className="cp-choice-text"><span>Get it from GitHub</span><small>Recommended. This computer uses its own GitHub sign-in.</small></span></button>
      <button type="button" role="radio" aria-checked={way === 'here'} disabled={!here.length} className={`cp-choice${way === 'here' ? ' is-on' : ''}`} onClick={() => setWay('here')}><span className="cp-tile" style={{'--tint': '#F0C27A'} as React.CSSProperties}><UiIcon name="folder" size={18}/></span><span className="cp-choice-text"><span>It is already on this computer</span><small>{here.length ? 'Pick the project; its folder stays where it is.' : 'No project with a folder here yet.'}</small></span></button>
      <button type="button" role="radio" aria-checked={way === 'copy'} disabled={!others.length} className={`cp-choice${way === 'copy' ? ' is-on' : ''}`} onClick={() => setWay('copy')}><span className="cp-tile" style={{'--tint': '#8FD6B0'} as React.CSSProperties}><UiIcon name="screen" size={18}/></span><span className="cp-choice-text"><span>Copy it from another computer</span><small>{others.length ? 'For projects without GitHub. Sent once, encrypted; that computer allows it first.' : 'No other computer in your account yet.'}</small></span></button>
    </div>
    {way === 'copy' ? (copy ? <div className="cp-card-panel" role="status">
      {copy.state === 'waiting' && <p className="cp-card-wait">Waiting for {copy.toName} to allow it. Open Girru there and press Allow.</p>}
      {copy.state === 'receiving' && <><p className="cp-card-wait">Copying from {copy.toName}…</p><span className="computer-card-bar"><i style={{width: `${copy.parts ? Math.round(copy.received / copy.parts * 100) : 5}%`}}/></span></>}
      {copy.state === 'ready' && <p className="cp-card-done"><UiIcon name="check" size={14}/>{copy.name} is on this computer now.</p>}
      {copy.state === 'refused' && <p className="cp-card-wait">{copy.toName} said No. Nothing was copied.</p>}
      {copy.state === 'failed' && <p className="cp-card-wait">The copy did not arrive whole, so nothing was kept. Try again.</p>}
    </div> : <>
      <label className="phone-field"><span>From</span><select value={from || others[0]?.id || ''} onChange={e => setFrom(e.target.value)}>{others.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      <label className="phone-field"><span>Project name there (optional)</span><input value={copyName} maxLength={80} placeholder="Website" onChange={e => setCopyName(e.target.value)}/></label>
      <label className="phone-field"><span>Put it in this folder</span><input value={parent} placeholder="/Users/you/Documents/Projects" onChange={e => setParent(e.target.value)}/></label>
    </>)
    : way === 'github' ? <>
      <label className="phone-field"><span>GitHub address</span><input value={url} placeholder="github.com/you/project" onChange={e => setUrl(e.target.value)}/></label>
      {(choices?.projects ?? []).some(p => p.github) && !url && <p className="cp-note">From your projects: {(choices!.projects.filter(p => p.github).slice(0, 3)).map(p => <button key={p.id} type="button" className="cp-link" onClick={() => setUrl(p.github!)}>{p.name}</button>)}</p>}
      <label className="phone-field"><span>Put it in this folder</span><input value={parent} placeholder="/Users/you/Documents/Projects" onChange={e => setParent(e.target.value)}/></label>
    </> : <label className="phone-field"><span>Project</span><select value={projectId || here[0]?.id || ''} onChange={e => setProjectId(e.target.value)}>{here.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
    {!ready && choices && <p className="cp-note">{!workspaceId ? 'Add this computer to your account first.' : 'Create an agent and a Board first.'}</p>}
    {notice && <p role="status" className="cp-note">{notice}</p>}
  </Sheet>;
}

/** On the computer that has the project: another computer asks for a copy; choose the project, then Allow or No. */
export function ProjectCopyAsks({client}: {client: SessionClient}) {
  const view = useComputerOverview();
  const asks = view?.copyAsks ?? [];
  const [projects, setProjects] = useState<{id: string; name: string}[]>([]);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => { if (!asks.length) return; void client.request({method: 'GET', path: '/api/computers/works-on/choices'}).then(r => { if (r.status === 200) setProjects((r.body as Choices).projects.filter(p => p.hasFolder)); }).catch(() => {}); }, [client, asks.length]);
  if (!asks.length) return null;
  const choose = (a: {requestId: string; name: string}) => pick[a.requestId] || projects.find(p => a.name && p.name.toLowerCase() === a.name.toLowerCase())?.id || projects[0]?.id || '';
  const answer = async (requestId: string, allow: boolean) => {
    setBusy(requestId); setNotice('');
    try {
      const r = await client.request({method: 'POST', path: `/api/computers/project-copy/${encodeURIComponent(requestId)}/${allow ? 'allow' : 'deny'}`, body: allow ? {projectId: choose(asks.find(a => a.requestId === requestId)!), confirmed: true} : {}});
      if (r.status !== 200) throw Error();
      const sent = r.body as {files?: number; leftBehind?: number};
      setNotice(allow ? `Sending ${sent.files ?? 0} files.${sent.leftBehind ? ` ${sent.leftBehind} stayed here (ignored, build or secret files).` : ''}` : 'Not sent.');
    } catch { setNotice(allow ? 'It could not be sent. The project may be too large; use GitHub for it.' : 'It could not be answered.'); } finally { setBusy(''); }
  };
  return <section className="cp-block" aria-label="Copies asked for">
    {asks.map(a => <div key={a.requestId} className="cp-card">
      <span className="cp-tile" style={{'--tint': '#8FD6B0'} as React.CSSProperties}><UiIcon name="folder" size={18}/></span>
      <span className="cp-choice-text"><span>{a.fromName} asks for a copy of a project{a.name ? ` (“${a.name}”)` : ''}</span><small>Its files go once, encrypted. Ignored, build and secret files stay here.</small>
        {projects.length > 0 ? <select aria-label="Project to copy" value={choose(a)} onChange={e => setPick({...pick, [a.requestId]: e.target.value})}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select> : <small>No project with a folder on this computer.</small>}
      </span>
      <span className="cp-card-actions"><button type="button" className="cp-soft" disabled={busy === a.requestId} onClick={() => void answer(a.requestId, false)}>No</button><button type="button" className="primary" disabled={busy === a.requestId || !choose(a)} onClick={() => void answer(a.requestId, true)}>Allow</button></span>
    </div>)}
    {notice && <p role="status" className="cp-note">{notice}</p>}
  </section>;
}
