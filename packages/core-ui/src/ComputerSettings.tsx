import type React from 'react';
import {useState} from 'react';
import type {SessionClient} from './session';
import {useComputerOverview} from './ComputerDevices';
import {DproAccountPanel} from './DproAccountPanel';
import {AccountTwoFactor, ThisComputerCheck, useAccountStatus} from './ComputerJoin';
import {computerName, useComputerLook} from './ComputerLook';
import {ComputerEnrollment} from './ComputerEnrollment';
import {ComputerLinkControls, ComputerDirectControls} from './ComputerLinkControls';
import {ComputerSyncWorkspace} from './ComputerSyncWorkspace';
import {ComputerTaskRules, TasksAtOnce} from './ComputerTaskRules';
import {ComputerShare} from './ComputerShare';
import {UiIcon} from './ui-icons';

/** CP12 D: Settings › Computers is one page. The computers themselves live on the Computers page
 * (right-click there to rename or forget); the account and two-step sign-in live in Settings › Account. */
export function ComputerSettings({client, onApprovals}: {client: SessionClient; onApprovals?: () => void}) {
  const view = useComputerOverview();
  const [notice, setNotice] = useState('');
  const [copyOpen, setCopyOpen] = useState(false);
  const devices = (view?.devices ?? []).filter(d => d.state !== 'revoked');
  const usable = !!view && (view.testOnly || !!view.configured);
  const account = useAccountStatus(client, !usable);
  const {look} = useComputerLook(client, true);
  const names = Object.fromEntries(devices.map(d => [d.id, computerName(look, d.id, d.name)]));
  return <div className="phone-settings computer-settings">
    <div className="phone-main">
      <header className="phone-head"><div><h2 className="settings-page-title">Computers</h2><p className="settings-page-desc">What this computer does with tasks from your other computers.</p></div></header>
      {notice && <p role="status" className="fine-print">{notice}</p>}
      <ComputerTaskRules client={client} deviceNames={names} part="main"/>
      <TasksAtOnce client={client}/>
      <div className="phone-list" role="list"><div className="phone-row" role="listitem">
        <span className="phone-tile"><UiIcon name="layers" size={15}/></span>
        <span className="phone-row-text"><b>What a new computer can copy (Same as)</b><small>Nothing goes until you press Allow here.</small></span>
        <button type="button" className="cp-link" aria-expanded={copyOpen} onClick={() => setCopyOpen(o => !o)}>Agents, skills, rules</button>
      </div></div>
      {copyOpen && (usable ? <ComputerShare client={client}/> : <NotReadyYet account={account}/>)}
      <details className="cp-advanced"><summary>Advanced</summary>
        <ComputerTaskRules client={client} deviceNames={names} part="advanced"/>
        {usable && view && <>
          {devices.length > 0 && <section className="cp-block"><b className="cp-h">Same Wi‑Fi</b>
            {devices.map(d => <section key={d.id} className="computer-connection" aria-label={names[d.id]}><p className="section-label"><UiIcon name="screen" size={13}/> {names[d.id]}</p><ComputerDirectControls client={client} view={view} device={d} onNotice={setNotice}/></section>)}
          </section>}
          <details><summary>Share one item with one computer…</summary><ComputerSyncWorkspace client={client} devices={view.devices} onApprovals={onApprovals}/></details>
        </>}
        <details><summary>Add a computer with a code</summary><ThisComputerCheck client={client}/>{view && <ComputerLinkControls client={client} view={view} onNotice={setNotice}/>}<ComputerEnrollment client={client}/></details>
      </details>
    </div>
  </div>;
}

/** CP12 D: the Dpro account part of Settings › Account (who is signed in here, two-step, a lost computer, history). */
export function ComputerAccountPart({client}: {client: SessionClient}) {
  return <div className="computer-task-rules cp-account" aria-label="Dpro account">
    <AccountSafety client={client}/>
    <section className="cp-block"><b className="cp-h">Safety</b>
      <div className="cp-list" role="list">
        <AccountTwoFactor client={client}/>
        <div className="cp-list-row" role="listitem"><span className="cp-tile" style={{'--tint': '#F29BC0'} as React.CSSProperties}><UiIcon name="alert" size={16}/></span><span className="cp-choice-text"><span>A lost or stolen computer</span><small>Right-click it in Computers and choose Forget this computer. Its work stays on it; it can no longer send or take tasks.</small></span></div>
        <div className="cp-list-row" role="listitem"><span className="cp-tile" style={{'--tint': '#C4A5FF'} as React.CSSProperties}><UiIcon name="history" size={16}/></span><DproAccountPanel client={client}/></div>
      </div>
    </section>
  </div>;
}

/** Why a place is still empty, in one sentence: not signed in, this computer still waiting, or getting ready. */
function NotReadyYet({account}: {account: ReturnType<typeof useAccountStatus>}) {
  const self = account?.view?.devices?.find(d => d.id === account?.view?.deviceId);
  const [title, text] = account === undefined ? ['Reading…', '']
    : account === null ? ['Your Dpro account can’t be reached right now', 'Check the internet connection; your work on this computer is not affected.']
    : !account.connected ? ['This computer is not in your Dpro account yet', 'Open Computers to add it. Then your computers show here.']
    : account.view?.deviceStatus === 'pending' ? [`${self?.label ?? 'This computer'} is waiting to be added`, 'Open Computers to finish adding it. Then your computers show here.']
    : ['Getting your computers ready…', 'This takes a few seconds after a computer is added.'];
  return <div className="phone-empty" role="status"><UiIcon name="screen" size={24}/><b>{title}</b>{text && <p>{text}</p>}</div>;
}

/** CP6d Account and safety: who is signed in and the everyday actions; recovery, history and deleting the account stay under Account and workspaces…. */
function AccountSafety({client}: {client: SessionClient}) {
  const status = useAccountStatus(client);
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(false);
  if (!status?.connected) return <p className="fine-print">{status === null ? 'Your Dpro account can’t be reached right now.' : 'Not signed in to your Dpro account on this computer. Open Computers to add it.'}</p>;
  const self = status.view?.devices?.find(d => d.id === status.view?.deviceId);
  const email = client.getSnapshot().user?.email;
  return <section className="cp-block">
    <div className="cp-card"><span className="cp-tile" style={{'--tint': '#9DBBFF'} as React.CSSProperties}><UiIcon name="shield" size={18}/></span>
      <span className="cp-choice-text"><span>{email ?? 'Your Dpro account'}</span><small>Signed in on {self?.label ?? 'this computer'} · {status.view?.deviceStatus === 'approved' ? 'added to your account' : 'waiting to be added'}</small></span>
      {!confirm ? <button type="button" className="cp-soft" onClick={() => setConfirm(true)}>Sign out this computer</button>
        : <span className="computer-task-actions"><button type="button" className="cp-soft" onClick={() => setConfirm(false)}>Cancel</button><button type="button" className="danger" onClick={() => void client.request({method: 'POST', path: '/api/computers/account/signout', body: {}}).then(r => setNotice(r.status === 200 ? 'Signed out. Your work stays on this computer.' : 'It could not sign out.')).finally(() => setConfirm(false))}>Sign out</button></span>}
    </div>
    {notice && <p role="status" className="cp-note">{notice}</p>}
  </section>;
}
