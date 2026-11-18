import {GoogleAccountLink} from './GoogleAccountLink';
import {useCallback,useEffect,useRef,useState} from 'react';
import {displayName} from './session';
import type {SessionClient} from './session';
import {PreferenceGroup} from './Preferences';
import {VerificationSettings} from './VerificationSettings';
import {UiIcon} from './ui-icons';
import {SESSIONS_PATH} from './account-settings-contract.js';
import type {DeviceSession} from './account-settings-contract.js';
const roleLine:Record<string,string>={owner:'Owner of this workspace',admin:'Admin',user:'Member',guest:'Guest · read only'};
const roleHelp:Record<string,string>={
 owner:'Full control: hires agents, sets their permissions and approves memory changes.',
 admin:'Manages agents and settings, but cannot change permissions or approve memory.',
 user:'Works with the agents; cannot change the team.',
 guest:'Read-only access.',
};
const ago=(t:number)=>{const m=Math.round((Date.now()-t)/60000);if(m<2)return 'now';if(m<60)return `${m} minutes ago`;const h=Math.round(m/60);if(h<24)return `${h} hour${h===1?'':'s'} ago`;return new Date(t).toLocaleDateString(undefined,{day:'numeric',month:'short'});};
const deviceIcon=(label:string)=>/iPhone|Android/.test(label)?'phone' as const:'screen' as const;
/**
 * Settings › Account (ST2): who you are and what your role may do, two-step
 * sign-in with its recovery codes, every device signed in to this account
 * (each can be signed out on its own), and sign out everywhere.
 */
export function AccountSettings({client}:{client:SessionClient}){
 const state=client.getSnapshot(),user=state.user!;
 const [confirm,setConfirm]=useState(false),[devices,setDevices]=useState<DeviceSession[]|null|'error'>(null),[busy,setBusy]=useState(''),[notice,setNotice]=useState('');
 const load=useCallback(async()=>{try{const r=await client.request({method:'GET',path:SESSIONS_PATH} as never);const b=r.body as {sessions?:DeviceSession[]};setDevices(r.status===200&&Array.isArray(b.sessions)?b.sessions:'error');}catch{setDevices('error');}},[client]);
 useEffect(()=>{if(user.role!=='guest')void load();},[load,user.role]);
 const signOut=async(device:DeviceSession)=>{setBusy(device.id);setNotice('');try{const r=await client.request({method:'POST',path:`${SESSIONS_PATH}/${device.id}/sign-out`} as never);
  if(device.current){client.cancel();return;}
  setNotice(r.status===200?`${device.label} is signed out.`:'That device was already signed out.');await load();}catch{setNotice('Could not sign it out. Look again.');}finally{setBusy('');}};
 const others=Array.isArray(devices)?devices.filter(d=>!d.current):[];
 return <section className="account-settings" aria-label="Account">
  <div className="account-settings-head"><span className="team-avatar account-avatar" aria-hidden="true">{displayName(user).trim().slice(0,1).toUpperCase()||'?'}</span><div><strong><bdi>{displayName(user)}</bdi></strong><small><bdi>{user.email}</bdi> · {roleLine[user.role]??user.role}</small><small className="account-role-help">{roleHelp[user.role]??''}</small></div></div>
  <VerificationSettings client={client}/>
  <GoogleAccountLink client={client}/>
  <PreferenceGroup title="Signed in" note="Signing out a device ends only its sign-in; your agents keep working.">
   <div className="preference-row"><span className="preference-icon"><UiIcon name="screen" size={18}/></span><div className="preference-label"><strong>This device</strong><small>{state.mode==='live'?'Now · this installation':state.mode==='mock'?'Now · offline practice with fictional data':'Now · preview'} · this window only; the sign-in is not stored on disk.</small></div>
    {Array.isArray(devices)&&devices.some(d=>d.current)&&<div className="preference-control"><button type="button" disabled={!!busy} onClick={()=>void signOut(devices.find(d=>d.current)!)}>Sign out</button></div>}</div>
   {user.role!=='guest'&&(devices===null?<p className="preference-inline-notice" role="status">Looking for your other devices…</p>
    :devices==='error'?<div className="preference-row"><div className="preference-label"><strong>Other devices could not be read</strong></div><div className="preference-control"><button type="button" className="tool" aria-label="Look again" title="Look again" onClick={()=>void load()}><UiIcon name="refresh" size={14}/></button></div></div>
    :!others.length?<div className="preference-row"><div className="preference-label"><small>No other device is signed in.</small></div></div>
    :others.map(d=><div className="preference-row" key={d.id}><span className="preference-icon"><UiIcon name={deviceIcon(d.label)} size={18}/></span><div className="preference-label"><strong>{d.label}</strong><small>Last used {ago(d.lastSeenAt)} · signed in {new Date(d.createdAt).toLocaleDateString(undefined,{day:'numeric',month:'short'})}</small></div><div className="preference-control"><button type="button" disabled={!!busy} onClick={()=>void signOut(d)}>{busy===d.id?'Signing out…':'Sign out'}</button></div></div>))}
   {notice&&<p role="status" className="preference-inline-notice">{notice}</p>}
   <div className="preference-row"><div className="preference-label"><strong>Sign out everywhere</strong><small>Ends every session of this account, on all devices. You will need to sign in again here too.</small></div><div className="preference-control"><button type="button" onClick={()=>setConfirm(true)}>Sign out everywhere…</button></div></div>
  </PreferenceGroup>
  {confirm&&<SignOutEverywhere client={client} onClose={()=>setConfirm(false)}/>}
 </section>;
}
function SignOutEverywhere({client,onClose}:{client:SessionClient;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),[busy,setBusy]=useState(false);
 useEffect(()=>{const element=dialog.current;element?.showModal();return()=>element?.close();},[]);
 return <dialog ref={dialog} className="verification-sheet st-sheet st-confirm" aria-labelledby="sign-out-everywhere" onCancel={event=>{event.preventDefault();onClose();}}>
  <h3 id="sign-out-everywhere">Sign out on every device?</h3>
  <p>Every device, this one too, will need to sign in again. Your agents keep working.</p>
  <div className="st-sheet-actions"><button type="button" autoFocus onClick={onClose}>Cancel</button><button type="button" className="danger" disabled={busy} onClick={()=>{setBusy(true);void client.logoutAllDevices();}}>Sign out everywhere</button></div>
 </dialog>;
}
