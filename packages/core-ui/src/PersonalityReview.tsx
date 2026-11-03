import { useEffect, useSyncExternalStore } from 'react';
import { traitNames } from './personality-contract.js';
import { labels } from './personality-library';
import type { PersonalityController } from './personality';

const STATUS: Record<string, string> = { pending: 'Waiting for you', approved: 'Agreed', rejected: 'Declined', cancelled: 'Cancelled', stale: 'Out of date', expired: 'Expired' };
const SOURCE: Record<string, string> = { agent: 'The agent', evolution: 'Learned from its work', owner: 'You' };
const when = (t: string | null | undefined) => t ? new Date(t).toLocaleString() : '—';
const label = (n: string) => (labels as Record<string, string>)[n] ?? n;

/**
 * PL5 "Needs you": changes an agent suggests about its own personality, one
 * question at a time. Nothing changes until the owner agrees (the decision
 * carries the review hash it was shown); agreeing never grants tools or permissions.
 */
export function PersonalityReview({ controller, agentName = 'This agent' }: { controller: PersonalityController; agentName?: string }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const p = s.detail, busy = s.phase === 'loading' || s.phase === 'deciding';
  const canDecide = s.owner && s.phase === 'ready' && p?.status === 'pending' && s.consent;
  const pending = s.proposals.filter(x => x.status === 'pending');
  useEffect(() => { if (s.owner && s.agentId && s.phase === 'idle') void controller.list(); }, [controller, s.owner, s.agentId, s.phase]);
  useEffect(() => { if (s.phase === 'ready' && !p && pending[0]) void controller.open(pending[0].id); }, [controller, s.phase, p, pending[0]?.id]);
  if (!s.owner) return null;
  if (['error', 'conflict', 'unknown', 'denied'].includes(s.phase)) return <section className="ag-needs" aria-label="Suggested persona changes"><p role="status">{s.notice ?? 'Suggestions could not be read.'} <button type="button" className="link-button" onClick={() => void controller.list()}>Read again</button></p></section>;
  const earlier = s.proposals.filter(x => x.status !== 'pending');
  // Decided, cancelled or out-of-date suggestions stay readable, newest first as the server lists them.
  const history = earlier.length > 0 && <details className="ag-details ag-earlier"><summary>Earlier suggestions <small>({earlier.length})</small></summary>
    <ul>{earlier.map(x => <li key={x.id}><button type="button" className="link-button" disabled={busy} aria-pressed={p?.id === x.id} onClick={() => void controller.open(x.id)}>{STATUS[x.status] ?? x.status} · {when(x.createdAt)}</button><small className="personality-copy" dir="auto">{x.reason}</small></li>)}</ul></details>;
  if (!p) return history ? <section className="ag-earlier-box" aria-label="Earlier suggestions">{history}</section> : null;
  const changed = traitNames.filter(n => p.delta[n] !== undefined && p.delta[n] !== 0);
  const at = Math.max(0, pending.findIndex(x => x.id === p.id));
  // STORE-MAP-01 P4 (T7b, T7d): a text change shows before → after next to the trait bars.
  const textChange = p.proposedText !== undefined && p.proposedText !== p.baseText;
  const outside = p.origin === 'file';
  return <section className="ag-needs" aria-label="Suggested persona changes">
    <div className="ag-head-row"><b>{outside ? <><bdi>{agentName}</bdi>’s personality text changed outside Girru</> : <><bdi>{agentName}</bdi> suggests a small change</>}</b><small className="ag-muted">{p.status === 'pending' ? `${at + 1} of ${pending.length} · it changes nothing until you agree` : STATUS[p.status] ?? p.status}</small></div>
    {outside ? <p className="personality-copy">The file PERSONALITY.md was changed by a coding app or by hand. Girru keeps one personality, so the change waits here. Agree makes it a new version; No keeps the current one and writes the file back.</p>
      : <p className="personality-copy" dir="auto">“{p.reason}”</p>}
    {textChange && <div className="ag-text-diff" aria-label="Text before and after">
      <pre className="ag-text-before" dir="auto" aria-label="Now">{p.baseText || '(no text)'}</pre>
      <pre className="ag-text-after" dir="auto" aria-label="Suggested">{p.proposedText || '(no text)'}</pre>
    </div>}
    <div className="ag-delta">{changed.map(n => <span key={n} className="ag-delta-row"><span>{label(n)}</span>
      <span className="ag-bar"><i style={{ inlineSize: `${p.baseTraits[n]}%` }}/><i data-next style={{ inlineSize: `${p.proposedTraits[n]}%` }}/></span><span className="ag-delta-n">{p.baseTraits[n]} → {p.proposedTraits[n]}</span></span>)}</div>
    <details className="ag-details"><summary>What it noticed ({p.evidence.length}) and every trait</summary>
      {p.evidence.length > 0 && <ul>{p.evidence.map((e, i) => <li className="personality-copy" key={i}><bdi>{e}</bdi></li>)}</ul>}
      <p className="fine-print">Written by the agent: information only.</p>
      <table className="persona-delta"><caption>{changed.length ? `All traits (0–100); ${changed.length} would change` : 'All traits (0–100); none would change'}</caption><thead><tr><th>Trait</th><th>Now</th><th>Suggested</th><th>Change</th></tr></thead>
        <tbody>{traitNames.map(n => <tr key={n} data-changed={changed.includes(n) || undefined}><th scope="row">{n}</th><td>{p.baseTraits[n]}</td><td>{p.proposedTraits[n]}</td><td>{p.delta[n] === undefined || p.delta[n] === 0 ? '—' : `${p.delta[n]! > 0 ? '+' : ''}${p.delta[n]}`}</td></tr>)}</tbody></table>
      <dl className="ag-tech"><dt>Suggestion</dt><dd><bdi dir="ltr">{p.id}</bdi></dd><dt>From version</dt><dd>{p.baseVersion}</dd><dt>Source</dt><dd>{SOURCE[p.source] ?? p.source}</dd><dt>Created</dt><dd>{when(p.createdAt)}</dd><dt>Review hash</dt><dd className="personality-hash"><bdi dir="ltr">{p.reviewHash}</bdi></dd>
        {p.appliedVersion !== null && p.appliedVersion !== undefined && <><dt>Applied as version</dt><dd>{p.appliedVersion}</dd></>}</dl>
    </details>
    {p.status === 'pending' ? <div className="ag-needs-foot">
      <label className="ag-check"><input type="checkbox" checked={s.consent} disabled={s.phase !== 'ready'} onChange={e => controller.review(e.target.checked)}/>I read the change and what it noticed</label>
      <button type="button" disabled={!canDecide} onClick={() => void controller.decide('reject')}>No</button>
      <button type="button" className="primary" disabled={!canDecide} onClick={() => void controller.decide('approve')}>Agree</button>
    </div> : <p className="fine-print">{STATUS[p.status] ?? p.status}{p.decidedAt ? ` · ${new Date(p.decidedAt).toLocaleString()}` : ''}{p.decisionNote ? ` · ${p.decisionNote}` : ''}{busy ? '' : ' '}{pending.length > 0 && <button type="button" className="link-button" onClick={() => void controller.open(pending[0].id)}>Next suggestion</button>}</p>}
    {history}
  </section>;
}
