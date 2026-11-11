import {useCallback, useEffect, useState} from 'react';
import type {SessionClient} from './session';
import {call} from './ComputerJoin';
import {Avatar, Sheet} from './desktop-ui';
import {UiIcon} from './ui-icons';

/**
 * People (CP17): your fixed Girru ID and nickname, adding a person by either one with a code
 * that changes every 90 seconds, their request in Needs you, and People in the sidebar.
 * A person you add only exchanges tasks with you; nothing else is shared.
 */
export interface Person {publicId: string; nickname: string | null}
export interface PersonComputer {deviceId: string; publicKey: string; label: string; osFamily: string; viaGoogle?: boolean; presence: 'online' | 'unknown'}
export interface LinkedPerson {linkId: string; person: Person; linkedAt: number; computers: PersonComputer[]}
export interface PeopleRequest {linkId: string; person: Person; expiresAt: number; code: string; codeExpiresAt: number}
export interface PersonTask {id: string; direction: 'out' | 'in'; linkId: string; person: {publicId: string; name: string}; text: string; state: 'waiting' | 'running' | 'done' | 'declined' | 'failed'; answer: string; sessionId: string | null; createdAt: number}
export interface PeopleState {me: Person | null; people: LinkedPerson[]; blocked: {linkId: string; person: Person}[]; incoming: PeopleRequest[]; outgoing: PeopleRequest[]; tasks: PersonTask[]}

const PATH = '/api/computers/account/people';
export const people = (client: SessionClient, body: Record<string, unknown>) => call(client, PATH, body);
export const personName = (p: Person) => p.nickname ?? p.publicId;
export const personOnline = (p: LinkedPerson) => p.computers.some(c => c.presence === 'online');

export function peopleWords(code: string) {
  const words: Record<string, string> = {
    account_people_nickname_invalid: 'Use 3–24 letters, numbers, dots or dashes.',
    account_people_nickname_taken: 'Someone already uses that nickname.',
    account_people_wait: 'Too many tries. Wait a few minutes and try again.',
    account_people_unavailable: 'Nobody with that nickname or ID can be added.',
    account_people_linked: 'You already work with this person.',
    account_people_request_waiting: 'This person already asked to work with you: answer it under Needs you.',
    account_people_code_changed: 'The code changed. Compare the new code and try again.',
    account_people_capacity: 'You have too many open requests. Wait for some to finish.',
    account_sign_in_required: 'Sign in to your Girru account first.',
    account_people_offline: 'None of their computers is on right now. Try again when one is open.',
    account_people_task_text: 'Write the task in 1 to 4000 characters.',
    account_people_task_start: 'The task could not start here. Try again.',
  };
  return words[code] ?? 'That did not work. Try again.';
}

/** Reads your ID, people and requests every few seconds while the Computers page is shown. */
export function usePeople(client: SessionClient, active: boolean, ready: boolean) {
  const [state, setState] = useState<PeopleState | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [me, list, requests, tasks] = await Promise.all([people(client, {action: 'me'}), people(client, {action: 'list'}), people(client, {action: 'requests'}), people(client, {action: 'tasks'}).catch(() => ({tasks: []}))]);
      setState({me, people: list.people ?? [], blocked: list.blocked ?? [], incoming: requests.incoming ?? [], outgoing: requests.outgoing ?? [], tasks: tasks.tasks ?? []});
    } catch { /* The account service is not reachable: keep what was shown. */ }
  }, [client]);
  useEffect(() => {
    if (!active || !ready) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [active, ready, refresh]);
  return {state, refresh};
}

/** Board A: on your own computer's page only. */
export function YouOnGirru({client, me, onAdd, onChanged}: {client: SessionClient; me: Person; onAdd: () => void; onChanged: () => void}) {
  const [editing, setEditing] = useState<string | null>(null), [notice, setNotice] = useState(''), [copied, setCopied] = useState(false);
  const save = async () => {
    try { await people(client, {action: 'nickname', nickname: editing?.trim() ? editing.trim() : null}); setEditing(null); setNotice(''); onChanged(); }
    catch (e) { setNotice(peopleWords((e as Error).message)); }
  };
  const copy = () => { void navigator.clipboard?.writeText(me.publicId).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); };
  return <section className="people-you" aria-label="You on Girru">
    <span className="people-you-head"><b>You on Girru</b><button type="button" onClick={onAdd} title="Add a person (⌘⇧N)"><UiIcon name="user-plus" size={14}/>Add</button></span>
    <span className="people-you-row"><small>Nickname</small>
      {editing === null ? <><span className="people-id">{me.nickname ?? 'None yet'}</span><button type="button" onClick={() => setEditing(me.nickname ?? '')}>{me.nickname ? 'Change' : 'Choose…'}</button></>
        : <><input autoFocus aria-label="Nickname" maxLength={24} value={editing} placeholder="letters and numbers" onChange={e => setEditing(e.target.value.toLowerCase())} onKeyDown={e => { if (e.key === 'Enter') void save(); else if (e.key === 'Escape') setEditing(null); }}/><button type="button" className="primary" onClick={() => void save()}>Save</button></>}
    </span>
    <span className="people-you-row"><small>Your ID</small><span className="people-id">{me.publicId}</span><button type="button" onClick={copy} title="Copy your ID"><UiIcon name="copy" size={13}/>{copied ? 'Copied' : 'Copy'}</button></span>
    <small className="fine-print">Give either one to a person you work with. Nobody is added without your OK.</small>
    {notice && <p role="status" className="fine-print">{notice}</p>}
  </section>;
}

/** Board B: add someone by nickname or ID, then both compare the code. */
export function AddPersonSheet({client, outgoing, onClose, onChanged}: {client: SessionClient; outgoing: PeopleRequest[]; onClose: () => void; onChanged: () => void}) {
  const [query, setQuery] = useState(''), [found, setFound] = useState<{person: Person; computers: number; linked: boolean; waiting: boolean} | null>(null);
  const [notice, setNotice] = useState(''), [sentId, setSentId] = useState(''), [busy, setBusy] = useState(false);
  const sent = outgoing.find(r => r.linkId === sentId);
  const find = async () => {
    if (!query.trim()) return;
    setBusy(true); setNotice(''); setFound(null);
    try { const r = await people(client, {action: 'find', query: query.trim()}); if (r.found) setFound(r); else setNotice('Nobody with that nickname or ID. Check it with the person.'); }
    catch (e) { setNotice(peopleWords((e as Error).message)); } finally { setBusy(false); }
  };
  const ask = async () => {
    if (!found) return;
    setBusy(true); setNotice('');
    try { const r = await people(client, {action: 'request', publicId: found.person.publicId}); setSentId(r.linkId); onChanged(); }
    catch (e) { setNotice(peopleWords((e as Error).message)); } finally { setBusy(false); }
  };
  return <Sheet title="Add a person" onClose={onClose} actions={<button type="button" onClick={onClose}>{sent ? 'Done' : 'Cancel'}</button>}>
    {!sentId && <span className="people-find"><input autoFocus aria-label="Nickname or ID" placeholder="Nickname or ID (GR-…)" maxLength={40} value={query} onChange={e => { setQuery(e.target.value); setFound(null); }} onKeyDown={e => { if (e.key === 'Enter') void find(); }}/><button type="button" className={found ? undefined : 'primary'} disabled={busy || !query.trim()} onClick={() => void find()}>Find</button></span>}
    {found && <span className="people-person"><Avatar name={personName(found.person)} size={28}/><span><b>{personName(found.person)}</b><small>{found.person.publicId} · {found.computers === 1 ? '1 computer' : `${found.computers} computers`}</small></span>
      {found.linked ? <span className="people-pill">Already added</span> : sentId ? <span className="people-pill warn">Waiting for {personName(found.person)}</span> : <button type="button" className="primary" disabled={busy} onClick={() => void ask()}>Add</button>}
    </span>}
    {sent && found && <><div className="people-code" aria-label="Code">{sent.code.slice(0, 4)} {sent.code.slice(4)}</div>
      <p className="fine-print">Read this code to {personName(found.person)} (call or chat). It changes every 90 seconds. When they see the same code and press Yes, you are linked.</p></>}
    {sentId && !sent && <p role="status" className="fine-print">Done: {found ? personName(found.person) : 'the person'} answered. Look under People.</p>}
    {!found && !sentId && <p className="fine-print">Type the person’s nickname or ID exactly. Nobody can list people.</p>}
    {notice && <p role="status" className="fine-print">{notice}</p>}
  </Sheet>;
}

/** Board C: the other person's request, in Needs you on your own computer. */
export function PeopleRequests({client, incoming, onChanged}: {client: SessionClient; incoming: PeopleRequest[]; onChanged: () => void}) {
  const [notice, setNotice] = useState('');
  if (!incoming.length) return notice ? <p role="status" className="fine-print">{notice}</p> : null;
  const act = async (body: Record<string, unknown>, done: string) => {
    try { await people(client, body); setNotice(done); onChanged(); } catch (e) { setNotice(peopleWords((e as Error).message)); }
  };
  return <div className="computer-list" role="list" aria-label="People who want to work with you">
    {incoming.map(r => <div key={r.linkId} className="computer-task people-request" role="listitem">
      <Avatar name={personName(r.person)} size={28}/>
      <span className="computer-task-text"><b>{personName(r.person)} wants to work with you</b><small>{r.person.publicId} · only tasks are shared</small>
        <span className="people-code" aria-label="Code">{r.code.slice(0, 4)} {r.code.slice(4)}</span>
        <small>Is it the same code {personName(r.person)} reads to you? It changes every 90 seconds.</small></span>
      <span className="computer-task-actions">
        <button type="button" className="primary" onClick={() => void act({action: 'accept', linkId: r.linkId, code: r.code, confirmed: true}, `${personName(r.person)} is added.`)}>Same code, add</button>
        <button type="button" onClick={() => void act({action: 'decline', linkId: r.linkId, block: false}, 'Not added.')}>Not now</button>
        <button type="button" className="danger-text" onClick={() => void act({action: 'decline', linkId: r.linkId, block: true}, `${personName(r.person)} can no longer find you.`)}>Block</button>
      </span>
    </div>)}
    {notice && <p role="status" className="fine-print">{notice}</p>}
  </div>;
}

/** Board D: a person's page: tasks with them, their computers, and Remove person in the More menu. */
export function PersonPage({person, tasks, onOpenChat}: {person: LinkedPerson; tasks: PersonTask[]; onOpenChat: (id: string) => void}) {
  const name = personName(person.person), mine = tasks.filter(t => t.linkId === person.linkId);
  return <>
    <section aria-label="Tasks"><p className="section-label">Tasks</p>
      {mine.length ? <div className="computer-list" role="list">{mine.map(t => <PersonTaskRow key={t.direction + t.id} task={t} name={name} onOpenChat={onOpenChat}/>)}</div> : <p className="fine-print">No task yet. Send one: it waits for {name}'s OK, then the answer shows here.</p>}
    </section>
    <section aria-label="Their computers"><p className="section-label">Their computers</p>
      <div className="computer-list" role="list">{person.computers.map(c => <div key={c.deviceId} className="computer-task" role="listitem">
        <UiIcon name={c.osFamily === 'windows' ? 'pc-tower' : 'pc-imac'} size={15}/>
        <span className="computer-task-text"><b>{c.label}</b><small>{c.presence === 'online' ? 'On' : 'Off or not seen'}{c.viaGoogle ? ' · added without a code check' : ''}</small></span>
      </div>)}{!person.computers.length && <p className="fine-print">No computer yet.</p>}</div>
    </section>
    <p className="fine-print">Only tasks are shared with {personName(person.person)}: never agents, settings, memory, chats or backups. A task from them always waits for your OK.</p>
  </>;
}

const taskWords = (t: PersonTask, name: string) => t.direction === 'out'
  ? {waiting: `Waits for ${name}'s OK`, running: `Running on ${name}'s computer`, done: 'Done', declined: `${name} said no`, failed: 'Did not finish'}[t.state]
  : {waiting: 'Waits for your OK', running: 'Running here', done: 'Done · answer sent', declined: 'You said no', failed: 'Did not finish · they were told'}[t.state];

function PersonTaskRow({task, name, onOpenChat}: {task: PersonTask; name: string; onOpenChat: (id: string) => void}) {
  return <div className="computer-task" role="listitem">
    <UiIcon name={task.state === 'done' ? 'check' : task.direction === 'in' ? 'inbox' : 'send'} size={15}/>
    <span className="computer-task-text"><b>{task.text.split('\n')[0].slice(0, 120)}</b><small>{taskWords(task, name)} · {task.direction === 'out' ? `sent to ${name}` : `from ${name}`}</small>
      {task.direction === 'out' && task.answer && <span className="computer-task-answer"><pre dir="auto">{task.answer}</pre></span>}</span>
    <span className="computer-task-actions">{task.direction === 'in' && task.sessionId && <button type="button" onClick={() => onOpenChat(task.sessionId!)}>Open its chat</button>}</span>
  </div>;
}

/** CP17 D: send a task to a person; it goes to one of their computers that is on and waits for their OK. */
export function SendToPersonSheet({client, person, onClose, onSent}: {client: SessionClient; person: LinkedPerson; onClose: () => void; onSent: (text: string) => void}) {
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const name = personName(person.person), on = person.computers.some(c => c.presence === 'online' && !c.viaGoogle);
  const send = async () => {
    setBusy(true); setNotice('');
    try { const r = await people(client, {action: 'send', linkId: person.linkId, text: text.trim()}); onSent(`Sent to ${name} (${r.to?.computer ?? 'their computer'}). It waits for their OK.`); onClose(); }
    catch (e) { setNotice(peopleWords((e as Error).message)); } finally { setBusy(false); }
  };
  return <Sheet title={`Send a task to ${name}`} onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={busy || !text.trim() || text.length > 4000} onClick={() => void send()}>Send</button></>}>
    <label className="phone-field"><span>The task</span><textarea autoFocus rows={6} maxLength={4000} value={text} onChange={e => setText(e.target.value)} placeholder="What should they do, and what should the answer say?" onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim()) void send(); }}/></label>
    <p className="fine-print">Runs on: {name} (any of their computers that is on{on ? '' : '; none is on right now'}). It waits for their OK and runs with their own agent. Only the text goes, only the answer comes back.</p>
    {notice && <p role="status" className="fine-print">{notice}</p>}
  </Sheet>;
}

/** CP17 D: on your own computer, tasks people sent you wait here for Allow. */
export function IncomingPersonTasks({client, tasks, onChanged, onOpenChat}: {client: SessionClient; tasks: PersonTask[]; onChanged: () => void; onOpenChat: (id: string) => void}) {
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState('');
  const waiting = tasks.filter(t => t.direction === 'in' && t.state === 'waiting');
  if (!waiting.length) return notice ? <p role="status" className="fine-print">{notice}</p> : null;
  const act = async (t: PersonTask, allow: boolean) => {
    setBusy(t.id);
    try { const r = await people(client, allow ? {action: 'allow', taskId: t.id, confirmed: true} : {action: 'decline-task', taskId: t.id}); setNotice(allow ? 'Started in a new chat.' : `${t.person.name} is told you said no.`); onChanged(); if (allow && r.sessionId) onOpenChat(r.sessionId); }
    catch (e) { setNotice(peopleWords((e as Error).message)); } finally { setBusy(''); }
  };
  return <div className="computer-list" role="list" aria-label="Tasks from people">
    {waiting.map(t => <div key={t.id} className="computer-task people-request" role="listitem">
      <Avatar name={t.person.name} size={28}/>
      <span className="computer-task-text"><b>{t.person.name} asks: {t.text.split('\n')[0].slice(0, 120)}</b>
        {t.text.length > 120 || t.text.includes('\n') ? <span className="computer-task-answer"><pre dir="auto">{t.text}</pre></span> : null}
        <small>Runs here in a new chat with your agent, and asks you before any change. Only its answer goes back.</small></span>
      <span className="computer-task-actions"><button type="button" className="primary" disabled={busy === t.id} onClick={() => void act(t, true)}>Allow</button><button type="button" disabled={busy === t.id} onClick={() => void act(t, false)}>Decline</button></span>
    </div>)}
    {notice && <p role="status" className="fine-print">{notice}</p>}
  </div>;
}
