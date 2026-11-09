import {useState} from 'react';
import type {SessionClient} from './session';
import {useComputerOverview, computerStateLabel, computerPathLabel} from './ComputerDevices';
import {DproAccountPanel} from './DproAccountPanel';
import {AccountTwoFactor, ThisComputerCheck, useAccountStatus} from './ComputerJoin';
import {computerIcon, computerName, useComputerLook} from './ComputerLook';
import {ComputerEnrollment} from './ComputerEnrollment';
import {ComputerLinkControls, ComputerDirectControls} from './ComputerLinkControls';
import {ComputerSyncWorkspace} from './ComputerSyncWorkspace';
import {ComputerTaskRules} from './ComputerTaskRules';
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
  const account = useAccountStatus(client, pane === 'mine');
  const {look} = useComputerLook(client, pane === 'mine' || pane === 'tasks');
  const os = (publicKey?: string, self = false) => account?.view?.devices?.find(d => self ? d.id === account?.view?.deviceId : !!publicKey && d.publicKey === publicKey)?.osFamily;
  return <div className="phone-settings computer-settings">
    <div className="phone-main">
      <header className="phone-head"><div><h2 className="settings-page-title">{place.label}</h2><p className="settings-page-desc">{place.note}</p></div></header>
      {notice && <p role="status" className="fine-print">{notice}</p>}
      {pane === 'account' && <>
        <DproAccountPanel client={client}/>
        <AccountTwoFactor client={client}/>
        <details><summary>Older way to add computers</summary><ComputerEnrollment client={client}/></details>
      </>}
      {pane !== 'account' && !usable && <div className="phone-empty"><UiIcon name="screen" size={24}/><b>Sign in to your Dpro account first</b><p>Then your computers show here. Open Account and safety.</p></div>}
      {pane === 'mine' && usable && view && <>
        <div className="phone-list" role="list" aria-label="My computers">
          {view.self && <div className="phone-row" role="listitem"><span className="phone-tile"><UiIcon name={computerIcon(look, view.self.id, os(undefined, true))} size={16}/></span><span className="phone-row-text"><b>{computerName(look, view.self.id, view.self.name)}</b><small>This computer</small></span></div>}
          {devices.map(d => <div key={d.id} className="phone-row" role="listitem"><span className="phone-tile"><UiIcon name={computerIcon(look, d.id, os(d.publicKey))} size={16}/></span><span className="phone-row-text"><b>{computerName(look, d.id, d.name)}</b><small>{computerStateLabel(d.state)} · {computerPathLabel(d.path)}</small></span></div>)}
        </div>
        <ThisComputerCheck client={client}/>
        <ComputerLinkControls client={client} view={view} onNotice={setNotice}/>
        <p className="fine-print">To forget a computer, select it in Computers and choose More › Forget this computer.</p>
      </>}
      {pane === 'tasks' && usable && view && <ComputerTaskRules client={client} deviceNames={Object.fromEntries(devices.map(d => [d.id, computerName(look, d.id, d.name)]))}/>}
      {pane === 'share' && usable && view && <ComputerSyncWorkspace client={client} devices={view.devices} onApprovals={onApprovals}/>}
      {pane === 'connection' && usable && view && (devices.length
        ? devices.map(d => <section key={d.id} className="computer-connection" aria-label={d.name}><p className="section-label"><UiIcon name="screen" size={13}/> {d.name} · {computerPathLabel(d.path)}</p><ComputerDirectControls client={client} view={view} device={d} onNotice={setNotice}/></section>)
        : <p className="fine-print">Add a computer first; then you can let it use the same Wi‑Fi.</p>)}
    </div>
  </div>;
}
