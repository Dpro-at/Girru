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
/** A quiet, persistent owner command; installation stays in the existing update screen. */
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
 return <button type="button" className="status-item statusbar-button" onClick={onOpen} title="See what is new and update Girru" aria-label={`${text}. See what is new and update Girru`}><UiIcon name="download" size={14}/><span role="status">{text}</span></button>;
}
