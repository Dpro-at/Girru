import { SetupOrb } from './SetupOrb';
import { useState } from 'react';
import { validCompanyName } from './owner-setup-contract.js';
import { UiIcon } from './ui-icons';

export type WorkspaceType = 'individual' | 'company';

/** A preference for setup copy, never an account role or a permission. */
export function WorkspaceTypeStep({ value, companyName: initialName, busy = false, notice, onNext }: { value?: WorkspaceType; companyName?: string; busy?: boolean; notice?: string; onNext: (type: WorkspaceType, companyName?: string) => void }) {
  const [pick, setPick] = useState<WorkspaceType | undefined>(value);
  const [companyName, setCompanyName] = useState(initialName ?? '');
  const ready = !!pick && (pick !== 'company' || validCompanyName(companyName.trim()));
  const next = () => { if (ready && pick && !busy) onNext(pick, pick === 'company' ? companyName.trim() : undefined); };
  return <section className="setup-pane setup-intro" aria-label="Who is Girru for?">
    <SetupOrb/>
    <h2>Who is Girru for?</h2>
    <p>Choose how you will use this workspace.</p>
    <div className="setup-audience" role="radiogroup" aria-label="Workspace type">
      {([{ id: 'individual', title: 'For myself', detail: 'Help with my own work and projects.', icon: 'person' },
        { id: 'company', title: 'For a company', detail: 'A team of agents for our work.', icon: 'building' }] as const).map(choice =>
        <label className="setup-row setup-choice" key={choice.id} data-on={pick === choice.id || undefined}>
          <input type="radio" name="workspace-type" value={choice.id} checked={pick === choice.id} disabled={busy} onChange={() => setPick(choice.id)}/>
          <UiIcon name={choice.icon} size={22}/><span className="setup-row-text"><b>{choice.title}</b><small>{choice.detail}</small></span>
        </label>)}
    </div>
    {pick === 'company' && <label className="setup-company-name">Company name<input type="text" autoComplete="organization" maxLength={100} value={companyName} disabled={busy} onChange={e => setCompanyName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); next(); } }}/></label>}
    {notice && <p role="alert">{notice}</p>}
    <div className="setup-actions"><button type="button" className="primary" disabled={!ready || busy} onClick={next}>{busy ? 'Saving…' : 'Continue'}</button></div>
  </section>;
}
