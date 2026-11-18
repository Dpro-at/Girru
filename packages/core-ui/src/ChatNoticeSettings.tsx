import {useEffect,useState} from 'react';
import type {SessionClient} from './session';
import {PreferenceGroup,PreferenceRow} from './Preferences';

/** CH10: Settings › General › Notifications. A desktop notice when work of a minute or more ends while Girru is in the back; saves at once. */
export function ChatNoticeSettings({client}:{client:SessionClient}){
 const [on,setOn]=useState<boolean|null>(null),[failed,setFailed]=useState(false);
 useEffect(()=>{let live=true;void client.request({method:'GET',path:'/api/chat/settings'} as never).then(r=>{if(live)setOn(r.status===200?(r.body as {settings?:{notifyDone?:boolean}})?.settings?.notifyDone!==false:true);}).catch(()=>{if(live)setOn(true);});return()=>{live=false;};},[client]);
 const change=async(next:boolean)=>{const before=on;setOn(next);setFailed(false);try{const r=await client.request({method:'PUT',path:'/api/chat/settings',body:{notifyDone:next}} as never);if(r.status!==200){setOn(before);setFailed(true);}}catch{setOn(before);setFailed(true);}};
 return <PreferenceGroup title="Notifications">
  <PreferenceRow title="When long work is done" description={failed?'It was not saved. Try again.':'A notice on this computer when work of a minute or more ends while Girru is in the back.'} icon="inbox">
   <input type="checkbox" role="switch" aria-label="Notify me when long work is done" checked={on??true} disabled={on===null} onChange={e=>void change(e.target.checked)}/>
  </PreferenceRow>
  <ComputerNoticeRow client={client}/>
 </PreferenceGroup>;
}

/** CP11c: one switch for the notices from your other computers (a task finished, stopped, or waits for your Allow). */
function ComputerNoticeRow({client}:{client:SessionClient}){
 const [on,setOn]=useState<boolean|null>(null),[failed,setFailed]=useState(false);
 useEffect(()=>{let live=true;void client.request({method:'GET',path:'/api/computers/look'} as never).then(r=>{if(live)setOn(r.status===200?(r.body as {notices?:boolean})?.notices!==false:null);}).catch(()=>{if(live)setOn(null);});return()=>{live=false;};},[client]);
 if(on===null)return null;
 const change=async(next:boolean)=>{const before=on;setOn(next);setFailed(false);try{const r=await client.request({method:'POST',path:'/api/computers/look',body:{notices:next}} as never);if(r.status!==200){setOn(before);setFailed(true);}}catch{setOn(before);setFailed(true);}};
 return <PreferenceRow title="From my other computers" description={failed?'It was not saved. Try again.':'A notice when a task you sent finishes or stops, or another computer sends one for your Allow.'} icon="screen">
  <input type="checkbox" role="switch" aria-label="Notices from my other computers" checked={on} onChange={e=>void change(e.target.checked)}/>
 </PreferenceRow>;
}
