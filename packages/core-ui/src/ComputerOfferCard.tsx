import {useState} from 'react';
import type {SessionClient} from './session';
import type {ComputerOffer} from './turns';
import {useComputerOverview} from './ComputerDevices';
import {ComputerTaskRequest} from './ComputerTaskRequest';
import {computerName, useComputerLook} from './ComputerLook';
import {UiIcon} from './ui-icons';

/**
 * CP11a: “Send 2 steps to other computers?” under the agent's reply. Send sends each step through the
 * same route as Computers › Send a task (each computer still allows it there); Change… opens that sheet
 * for one step; Keep it here tells the agent to do the work on this computer.
 */
export function ComputerOfferCard({client, offer, conversationId, onKeepHere}: {client: SessionClient; offer: ComputerOffer; conversationId?: string | null; onKeepHere: () => void}) {
  const view = useComputerOverview();
  const {look} = useComputerLook(client);
  const [state, setState] = useState<'open' | 'sending' | 'sent' | 'kept'>('open');
  const [notice, setNotice] = useState('');
  const [changing, setChanging] = useState<number | null>(null);
  const devices = (view?.devices ?? []).filter(d => d.state !== 'revoked');
  const match = (name: string) => devices.find(d => [d.name, computerName(look, d.id, d.name)].some(n => n.trim().toLowerCase() === name.trim().toLowerCase()));
  const plan = offer.steps.map(s => ({...s, device: match(s.computer)}));
  const missing = plan.filter(p => !p.device).map(p => p.computer);
  const option = (d: NonNullable<typeof plan[number]['device']>) => (d.dispatchOptions?.length ? d.dispatchOptions : view?.dispatchOptions ?? [])[0];
  const send = async () => {
    setState('sending'); setNotice('');
    let sent = 0;
    for (const p of plan) {
      const o = p.device && option(p.device);
      if (!p.device || !o) continue;
      try {
        const r = await client.request({method: 'POST', path: '/api/computers/tasks', body: {target: p.device.id, task: {taskId: crypto.randomUUID(), attemptId: crypto.randomUUID(), projectBinding: o.id, agentBinding: o.agentBinding, modelBinding: o.modelBinding, text: `${p.title}\n\n${p.text}`, ...(conversationId ? {source: {conversationId}} : {})}}});
        if (r.status === 200) sent++;
      } catch { /* counted below */ }
    }
    if (sent === plan.length) setState('sent');
    else { setState('open'); setNotice(sent ? `${sent} of ${plan.length} sent. Use Change… for the others.` : 'Nothing could be sent. Use Change… to pick a computer and project.'); }
  };
  if (state === 'sent') return <p className="moment-line"><UiIcon name="check" size={12}/>Sent to {[...new Set(plan.map(p => p.device ? computerName(look, p.device.id, p.device.name) : p.computer))].join(' and ')}. Each computer allows it there.</p>;
  if (state === 'kept') return <p className="moment-line"><UiIcon name="screen" size={12}/>Kept on this computer.</p>;
  return <div className="cp-offer" role="group" aria-label="Send steps to other computers">
    <b>Send {plan.length === 1 ? 'this step' : `${plan.length} steps`} to other computers?</b>
    {offer.why && <span className="cp-note">{offer.why}</span>}
    <ul className="cp-offer-steps">{plan.map((p, i) => <li key={i}><span className="cp-grow">{p.title}</span><span className={`cp-offer-to${p.device ? '' : ' is-missing'}`}><UiIcon name="screen" size={12}/>{p.device ? computerName(look, p.device.id, p.device.name) : `${p.computer}?`}</span><button type="button" className="cp-link" onClick={() => setChanging(i)}>Change…</button></li>)}</ul>
    {missing.length > 0 && <span className="cp-note">Not one of your computers: {missing.join(', ')}. Use Change… to pick one.</span>}
    <span className="cp-offer-actions">
      <button type="button" className="primary" disabled={state === 'sending' || missing.length === plan.length} onClick={() => void send()}>{state === 'sending' ? 'Sending…' : 'Send'}</button>
      <button type="button" className="cp-soft" onClick={() => { setState('kept'); onKeepHere(); }}>Keep it here</button>
    </span>
    {notice && <p role="status" className="cp-note">{notice}</p>}
    {changing !== null && <ComputerTaskRequest client={client} conversationId={conversationId ?? undefined} title={`${plan[changing].title}\n\n${plan[changing].text}`} presetTarget={plan[changing].device?.id} openNow onClosed={() => setChanging(null)}/>}
  </div>;
}
