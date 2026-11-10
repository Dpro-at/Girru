import {useState} from 'react';
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
