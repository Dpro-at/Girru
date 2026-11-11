import type React from 'react';
import {useState} from 'react';
import type {SessionClient} from './session';
import {useComputerOverview, computerStateLabel, computerPathLabel} from './ComputerDevices';
import {DproAccountPanel} from './DproAccountPanel';
import {AccountTwoFactor, ThisComputerCheck, useAccountStatus} from './ComputerJoin';
import {computerIcon, computerName, useComputerLook, type ComputerIconKey} from './ComputerLook';
import {RenameComputerSheet, forgetComputerLater, ForgetNotice, useForgetPending} from './ComputerActions';
import {ComputerEnrollment} from './ComputerEnrollment';
import {ComputerLinkControls, ComputerDirectControls} from './ComputerLinkControls';
import {ComputerSyncWorkspace} from './ComputerSyncWorkspace';
import {ComputerTaskRules, TasksAtOnce} from './ComputerTaskRules';
import {ComputerShare} from './ComputerShare';
import {UiIcon} from './ui-icons';
import type {UiIconName} from './ui-icons';

/** Settings › Computers places (board CP6). */
export type ComputerSettingsPane = 'mine' | 'tasks' | 'share' | 'connection' | 'account';
export const COMPUTER_SETTINGS_PANES: ReadonlyArray<{key: ComputerSettingsPane; label: string; icon: UiIconName; note: string}> = [
  {key: 'mine', label: 'My computers', icon: 'screen', note: 'Your computers, the ones waiting to be added, and Forget.'},
  {key: 'tasks', label: 'Tasks from other computers', icon: 'inbox', note: 'What this computer does when another of your computers sends it a task.'},
  {key: 'share', label: 'What they share', icon: 'link', note: 'What your computers keep the same.'},
  {key: 'connection', label: 'Connection', icon: 'wifi', note: 'Same Wi‑Fi first; otherwise over the internet, end-to-end encrypted.'},
  {key: 'account', label: 'Account and safety', icon: 'shield', note: 'Your Dpro account, recovery and history.'},
];

/** One place at a time; every control from the old Devices pane lives in one of them (board CP8). */
export function ComputerSettings({client, pane, onApprovals}: {client: SessionClient; pane: ComputerSettingsPane; onApprovals?: () => void}) {
  const view = useComputerOverview();
  const [notice, setNotice] = useState('');
  const devices = (view?.devices ?? []).filter(d => d.state !== 'revoked');
  const usable = !!view && (view.testOnly || !!view.configured);
  const place = COMPUTER_SETTINGS_PANES.find(p => p.key === pane)!;
  const account = useAccountStatus(client, pane !== 'tasks');
  const {look, save} = useComputerLook(client, pane === 'mine' || pane === 'tasks');
  const [renaming, setRenaming] = useState<{id: string; name: string; icon: ComputerIconKey | null} | null>(null);
  const forgetting = useForgetPending();
  const os = (publicKey?: string, self = false) => account?.view?.devices?.find(d => self ? d.id === account?.view?.deviceId : !!publicKey && d.publicKey === publicKey)?.osFamily;
  return <div className="phone-settings computer-settings">
    <div className="phone-main">
      <header className="phone-head"><div><h2 className="settings-page-title">{place.label}</h2><p className="settings-page-desc">{place.note}</p></div></header>
      {notice && <p role="status" className="fine-print">{notice}</p>}
      {pane === 'account' && <div className="computer-task-rules cp-account">
        <AccountSafety client={client}/>
        <section className="cp-block"><b className="cp-h">Safety</b>
          <div className="cp-list" role="list">
            <AccountTwoFactor client={client}/>
            <div className="cp-list-row" role="listitem"><span className="cp-tile" style={{'--tint': '#F29BC0'} as React.CSSProperties}><UiIcon name="alert" size={16}/></span><span className="cp-choice-text"><span>A lost or stolen computer</span><small>Select it in Computers and choose Forget this computer. Its work stays on it; it can no longer send or take tasks.</small></span></div>
            <div className="cp-list-row" role="listitem"><span className="cp-tile" style={{'--tint': '#C4A5FF'} as React.CSSProperties}><UiIcon name="history" size={16}/></span><DproAccountPanel client={client}/></div>
          </div>
        </section>
        <details><summary>Advanced: add a computer with a code</summary><ThisComputerCheck client={client}/>{view && <ComputerLinkControls client={client} view={view} onNotice={setNotice}/>}<ComputerEnrollment client={client}/></details>
      </div>}
      {pane !== 'account' && pane !== 'tasks' && !usable && <NotReadyYet account={account}/>}
      {pane === 'mine' && usable && view && <>
        <div className="phone-list" role="list" aria-label="My computers">
          {view.self && <div className="phone-row" role="listitem"><span className="phone-tile"><UiIcon name={computerIcon(look, view.self.id, os(undefined, true))} size={16}/></span><span className="phone-row-text"><b>{computerName(look, view.self.id, view.self.name)}</b><small>This computer</small></span>
            <button type="button" className="tool" title="Rename and icon…" aria-label="Rename and icon" onClick={() => setRenaming({id: view.self!.id, name: computerName(look, view.self!.id, view.self!.name), icon: (look?.icons[view.self!.id] as ComputerIconKey) ?? null})}><UiIcon name="pencil" size={14}/></button></div>}
          {devices.filter(d => d.id !== forgetting).map(d => <div key={d.id} className="phone-row" role="listitem"><span className="phone-tile"><UiIcon name={computerIcon(look, d.id, os(d.publicKey))} size={16}/></span><span className="phone-row-text"><b>{computerName(look, d.id, d.name)}</b><small>{computerStateLabel(d.state)} · {computerPathLabel(d.path)}</small></span>
            <button type="button" className="tool" title="Rename and icon…" aria-label={`Rename ${d.name}`} onClick={() => setRenaming({id: d.id, name: computerName(look, d.id, d.name), icon: (look?.icons[d.id] as ComputerIconKey) ?? null})}><UiIcon name="pencil" size={14}/></button>
            <button type="button" className="tool" title="Forget this computer" aria-label={`Forget ${d.name}`} onClick={() => forgetComputerLater(client, {id: d.id, name: computerName(look, d.id, d.name), publicKey: d.publicKey})}><UiIcon name="trash" size={14}/></button></div>)}
        </div>
        <ForgetNotice/>
        <TasksAtOnce client={client}/>
        <p className="fine-print">A new computer joins by itself: install Girru there and sign in with the same Google account.</p>
        {renaming && <RenameComputerSheet target={renaming} onSave={save} onClose={() => setRenaming(null)}/>}
      </>}
      {pane === 'tasks' && <ComputerTaskRules client={client} deviceNames={Object.fromEntries((devices ?? []).map(d => [d.id, computerName(look, d.id, d.name)]))}/>}
      {pane === 'share' && usable && view && <>
        <ComputerShare client={client}/>
        <details><summary>Share one item with one computer…</summary><ComputerSyncWorkspace client={client} devices={view.devices} onApprovals={onApprovals}/></details>
      </>}
      {pane === 'connection' && usable && view && (devices.length ? <>
        <div className="phone-list" role="list">{devices.map(d => <div key={d.id} className="phone-row" role="listitem"><span className="phone-tile"><UiIcon name={d.path === 'direct' ? 'wifi' : 'globe'} size={15}/></span><span className="phone-row-text"><b>{d.name}</b><small>{computerPathLabel(d.path)}</small></span></div>)}</div>
        <p className="fine-print">Over the internet, your computers talk end-to-end encrypted; our server only passes the messages on. On the same Wi‑Fi they can talk directly once you allow it.</p>
        <details><summary>Advanced… same Wi‑Fi, network and port</summary>{devices.map(d => <section key={d.id} className="computer-connection" aria-label={d.name}><p className="section-label"><UiIcon name="screen" size={13}/> {d.name}</p><ComputerDirectControls client={client} view={view} device={d} onNotice={setNotice}/></section>)}</details>
      </> : <p className="fine-print">Add a computer first; then you can let it use the same Wi‑Fi.</p>)}
    </div>
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
