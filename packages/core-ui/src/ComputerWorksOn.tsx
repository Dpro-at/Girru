import type React from 'react';
import {useEffect, useState} from 'react';
import type {SessionClient} from './session';
import {Sheet} from './desktop-ui';
import {UiIcon} from './ui-icons';
import {useAccountStatus} from './ComputerJoin';
import {useComputerOverview} from './ComputerDevices';

type Choices = {projects: {id: string; name: string; hasFolder: boolean; folder?: string | null; github: string | null}[]; agentId: string | null; boardId: string | null; columnId: string | null};

/**
 * CP12 C: the project this computer works on is a folder the owner chooses (they get it there
 * themselves: GitHub, a copy, anything). Work from tasks comes back through GitHub or directly.
 */
export function ComputerWorksOn({client, currentName, onClose}: {client: SessionClient; currentName?: string; onClose: () => void}) {
  const status = useAccountStatus(client);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [folder, setFolder] = useState('');
  const [back, setBack] = useState<'github' | 'direct'>('github');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    void client.request({method: 'GET', path: '/api/computers/works-on/choices'}).then(r => {
      if (r.status !== 200) return; const c = r.body as Choices; setChoices(c);
      const now = c.projects.find(p => p.name === currentName && p.folder); if (!now?.folder) return;
      setFolder(f => f || now.folder!);
      void client.request({method: 'GET', path: '/api/computers/task-rules'}).then(t => { const b = (t.body as {back?: Record<string, 'github' | 'direct'>})?.back?.[now.id]; if (t.status === 200 && b) setBack(b); }).catch(() => {});
    }).catch(() => setNotice('It could not be read. Try again.'));
  }, [client, currentName]);
  const workspaceId = status?.workspaces?.[0]?.id;
  const ready = !!choices?.agentId && !!choices.boardId && !!choices.columnId && !!workspaceId;
  const go = async () => {
    if (!choices || !ready || !folder.trim()) return;
    setBusy(true); setNotice('');
    try {
      const p = await client.request({method: 'POST', path: '/api/computers/works-on/folder', body: {folder: folder.trim(), confirmed: true}});
      if (p.status !== 200) throw Error((p.body as {code?: string})?.code ?? 'folder');
      const id = (p.body as {id: string}).id;
      const b = await client.request({method: 'POST', path: '/api/computers/task-rules', body: {back: {id, via: back}}});
      if (b.status !== 200) throw Error('back');
      const d = await client.request({method: 'POST', path: '/api/computers/account/workspaces/destination', body: {workspaceId, projectId: id, agentId: choices.agentId, boardId: choices.boardId, columnId: choices.columnId, confirmed: true}});
      if (d.status !== 200) throw Error('destination');
      // Choosing the project here is the owner's yes to receiving tasks on this computer: its main agent may accept them.
      // Each task still waits for the owner unless the rules allow it automatically.
      const g = await client.request({method: 'GET', path: `/api/agents/${choices.agentId}/tool-grants`});
      if (g.status !== 200) throw Error('grants');
      const view = g.body as {grants: {tool: string; scopes: unknown}[]; version: number};
      if (!view.grants.some(x => x.tool === 'computer_task_accept')) {
        const c = await client.request({method: 'PUT', path: `/api/agents/${choices.agentId}/tool-grants`, body: {grants: [...view.grants, {tool: 'computer_task_accept', scopes: null}], expectedVersion: view.version}});
        if (c.status !== 200) throw Error('grants');
      }
      onClose();
    } catch (e) {
      const code = (e as Error).message;
      setNotice(code.includes('folder_missing') ? 'That folder is not on this computer. Choose it again.' : code.includes('folder_invalid') ? 'Choose the project’s own folder, not the whole disk or your home folder.' : 'It could not be saved. Try again.');
    } finally { setBusy(false); }
  };
  return <Sheet title="The project on this computer" onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={busy || !ready || !folder.trim()} onClick={() => void go()}>Save</button></>}>
    <p className="cp-note">Choose the folder you work in. Get it there yourself first (GitHub, a copy, anything).</p>
    <FolderField value={folder} onChange={setFolder}/>
    <b className="cp-h">Work comes back</b>
    <div className="cp-choices" role="radiogroup" aria-label="Work comes back">
      <button type="button" role="radio" aria-checked={back === 'github'} className={`cp-choice${back === 'github' ? ' is-on' : ''}`} onClick={() => setBack('github')}><span className="cp-tile" style={{'--tint': '#9DBBFF'} as React.CSSProperties}><UiIcon name="globe" size={18}/></span><span className="cp-choice-text"><span>Through GitHub (faster)</span><small>When the folder has a GitHub address; otherwise directly.</small></span></button>
      <button type="button" role="radio" aria-checked={back === 'direct'} className={`cp-choice${back === 'direct' ? ' is-on' : ''}`} onClick={() => setBack('direct')}><span className="cp-tile" style={{'--tint': '#8FD6B0'} as React.CSSProperties}><UiIcon name="link" size={18}/></span><span className="cp-choice-text"><span>Directly, I look first</span><small>Encrypted, from computer to computer; you see the changes before they go in.</small></span></button>
    </div>
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

/** "Put it in this folder": typed, or picked with the system folder dialog (Finder / File Explorer) when the desktop app offers it. */
function FolderField({value, onChange}: {value: string; onChange: (v: string) => void}) {
  const bridge = typeof window === 'undefined' ? undefined : (window as unknown as { dproApp?: { chooseProjectFolders?: () => Promise<string[]> } }).dproApp;
  const browse = async () => { try { const [first] = await bridge!.chooseProjectFolders!(); if (first) onChange(first); } catch { /* keep what is typed */ } };
  return <label className="phone-field"><span>Folder</span>
    <span style={{display: 'flex', gap: 8}}><input style={{flex: 1}} value={value} placeholder="~/Projects/website" onChange={e => onChange(e.target.value)}/>
      {bridge?.chooseProjectFolders && <button type="button" className="cp-soft" onClick={() => void browse()}>Choose a folder…</button>}</span></label>;
}
