import type React from 'react';
import {useEffect, useState} from 'react';
import type {SessionClient} from './session';
import {Sheet} from './desktop-ui';
import {UiIcon} from './ui-icons';
import {useAccountStatus} from './ComputerJoin';

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
  const [way, setWay] = useState<'github' | 'here'>('github');
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
  return <Sheet title="The project this computer works on" onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={busy || !ready || (way === 'github' ? !url.trim() || !parent.trim() : !(projectId || here[0]))} onClick={() => void go()}>{busy ? 'Working…' : way === 'github' ? 'Get the project' : 'Use this project'}</button></>}>
    <div className="cp-choices" role="radiogroup" aria-label="Where it comes from">
      <button type="button" role="radio" aria-checked={way === 'github'} className={`cp-choice${way === 'github' ? ' is-on' : ''}`} onClick={() => setWay('github')}><span className="cp-tile" style={{'--tint': '#9DBBFF'} as React.CSSProperties}><UiIcon name="globe" size={18}/></span><span className="cp-choice-text"><span>Get it from GitHub</span><small>Recommended. This computer uses its own GitHub sign-in.</small></span></button>
      <button type="button" role="radio" aria-checked={way === 'here'} disabled={!here.length} className={`cp-choice${way === 'here' ? ' is-on' : ''}`} onClick={() => setWay('here')}><span className="cp-tile" style={{'--tint': '#F0C27A'} as React.CSSProperties}><UiIcon name="folder" size={18}/></span><span className="cp-choice-text"><span>It is already on this computer</span><small>{here.length ? 'Pick the project; its folder stays where it is.' : 'No project with a folder here yet.'}</small></span></button>
    </div>
    {way === 'github' ? <>
      <label className="phone-field"><span>GitHub address</span><input value={url} placeholder="github.com/you/project" onChange={e => setUrl(e.target.value)}/></label>
      {(choices?.projects ?? []).some(p => p.github) && !url && <p className="cp-note">From your projects: {(choices!.projects.filter(p => p.github).slice(0, 3)).map(p => <button key={p.id} type="button" className="cp-link" onClick={() => setUrl(p.github!)}>{p.name}</button>)}</p>}
      <label className="phone-field"><span>Put it in this folder</span><input value={parent} placeholder="/Users/you/Documents/Projects" onChange={e => setParent(e.target.value)}/></label>
    </> : <label className="phone-field"><span>Project</span><select value={projectId || here[0]?.id || ''} onChange={e => setProjectId(e.target.value)}>{here.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
    {!ready && choices && <p className="cp-note">{!workspaceId ? 'Add this computer to your account first.' : 'Create an agent and a Board first.'}</p>}
    {notice && <p role="status" className="cp-note">{notice}</p>}
  </Sheet>;
}
