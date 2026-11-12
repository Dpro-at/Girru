import {useEffect,useState} from 'react';
import {appUpdateBridge} from './AppUpdateSettings';
import type {AppUpdateView} from './AppUpdateSettings';
import {UiIcon} from './ui-icons';

type Bridge=NonNullable<ReturnType<typeof appUpdateBridge>>;
export function updateNoticeText(view:AppUpdateView|null):string|null {
 if(!view?.update)return null;
 if(view.busy)return ({checking:'Checking for updates…',downloading:'Downloading update…','backing-up':'Backing up before update…',installing:'Installing update…'})[view.busy];
 return view.error?'Update needs attention':`Girru ${view.update.version} is available`;
}
/** A quiet owner command in the top bar (Mohamed): "Update" when a new version is ready, a short line while it
 *  updates. Pressing Update starts it at once (the app asks once: back up and update); where this computer can't
 *  update from inside Girru, or while it is busy or needs attention, it opens the update screen instead. */
export function AppUpdateNotice({onOpen,bridge=appUpdateBridge()}:{onOpen:()=>void;bridge?:Bridge|null}) {
 const [view,setView]=useState<AppUpdateView|null>(null);
 useEffect(()=>{
  setView(null);
  if(!bridge)return;
  let live=true,received=false;
  const off=bridge.onState(next=>{received=true;if(live)setView(next);});
  void bridge.state().then(next=>{if(live&&!received)setView(next);}).catch(()=>{});
  return()=>{live=false;off();};
 },[bridge]);
 const text=updateNoticeText(view);
 if(!text)return null;
 const label=view?.busy?text:view?.error?'Update needs attention':'Update';
 return <button type="button" className="titlebar-update" data-busy={view?.busy?true:undefined} onClick={()=>{if(view?.update?.canInstall&&!view.busy&&!view.error&&bridge)void bridge.install().catch(()=>onOpen());else onOpen();}} title={`${text}. See what is new and update Girru`} aria-label={`${text}. See what is new and update Girru`}><UiIcon name="download" size={13}/><span role="status">{label}</span></button>;
}
