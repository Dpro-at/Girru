import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {SessionClient} from './session';
import {characterKeys,GuidelinesPart,PersonalityMark,PersonalitySheet,Slider,sliderValue,SpeakingPart} from './PersonalityLibrary';
import {libraryRpc as rpc,P,useLibraryEntries,type Entry,type Profile} from './personality-library';
import type {AgentCardController,PartDone} from './agent-card';
import type {PersonalityController} from './personality';
import {PersonalityReview} from './PersonalityReview';
import {Sheet} from './desktop-ui';
import {UiIcon} from './ui-icons';
import {forgetFacts} from './agent-facts';
import {DocumentEditor} from './DocumentEditor';

type Assignment={id:string;revision:number;linked:boolean;profile:Profile}|null;

/**
 * PL5: which personality the agent has, whether it follows library changes,
 * its own small adjustments (saved as you go), its own suggestions one at a
 * time, and its versions. Lock stops every change until it is unlocked.
 */
export function AgentPersonalityLibrary({card,personality,onDone}:{card:AgentCardController;personality?:PersonalityController;onDone:PartDone}){
 const s=useSyncExternalStore(card.subscribe,card.getSnapshot,card.getSnapshot);
 const client=card.client as SessionClient,agentId=s.agentId,version=s.persona?.version??0,locked=!!s.persona?.locked;
 // STORE-MAP-01 P4 (T7c): the personality text is part of the one record (sent only with the switch on).
 const text=s.persona?.text,[editingText,setEditingText]=useState<string|null>(null);
 const [assignment,setAssignment]=useState<Assignment|undefined>(undefined),[draft,setDraft]=useState<Profile|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[choosing,setChoosing]=useState(false),[speaking,setSpeaking]=useState(false);
 const library=useLibraryEntries(client);
 const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);const saved=useRef<Profile|null>(null);
 useEffect(()=>{let live=true;void rpc<{assignment:Assignment}>(client,'GET',`${P}/assigned/${agentId}`).then(r=>{if(live){setAssignment(r.assignment);setDraft(r.assignment?structuredClone(r.assignment.profile):null);saved.current=r.assignment?structuredClone(r.assignment.profile):null;}}).catch(()=>{if(live){setAssignment(null);setNotice('Could not read the assigned personality.');}});return()=>{live=false;};},[client,agentId,version]);
 useEffect(()=>()=>clearTimeout(timer.current),[]);
 const changed=()=>{forgetFacts(client,agentId);void card.load();};
 const current=()=>card.getSnapshot().persona?.version??version;
 async function tune(profile:Profile,before:Profile|null,undo=true){
  setBusy(true);setNotice('');
  try{await rpc(client,'POST',`${P}/assigned/${agentId}/tune`,{profile,expectedVersion:current()});changed();if(undo&&before)onDone('Personality adjusted',()=>tune(before,null,false));}
  catch{setNotice('Changed elsewhere or locked. Your adjustment was not saved; the latest is shown.');changed();}
  finally{setBusy(false);}
 }
 function adjust(next:Profile){setDraft(next);clearTimeout(timer.current);const before=saved.current;timer.current=setTimeout(()=>{if(JSON.stringify(next)!==JSON.stringify(before)){saved.current=next;void tune(next,before);}},900);}
 async function follow(linked:boolean){if(!assignment)return;setBusy(true);try{await rpc(client,'POST',`${P}/assigned/${agentId}/mode`,{linked,expectedVersion:current()});setAssignment({...assignment,linked});forgetFacts(client,agentId);onDone(linked?'Follows library changes':'Keeps its own copy',()=>follow(!linked));}catch{setNotice('Could not change this. Read the agent again and try once more.');}finally{setBusy(false);}}
 async function assign(entry:{id:string;revision:number;name:string},undoTo:Assignment|undefined){
  setBusy(true);setNotice('');
  try{await rpc(client,'POST',`${P}/assigned/${agentId}`,{id:entry.id,revision:entry.revision,expectedVersion:current(),linked:assignment?.linked??true});changed();
   onDone(`Now ${entry.name}`,undoTo?()=>assign({id:undoTo.id,revision:undoTo.revision,name:undoTo.profile.name},undefined):undefined);}
  catch{setNotice('Could not change the personality. The agent or the library changed; read it again first.');}
  finally{setBusy(false);}
 }
 /** Saved at once as a new version over the version shown; Undo restores the version before. */
 async function saveText(next:string){
  if(next===text)return;const before=version;setBusy(true);setNotice('');
  try{const r=await client.request({method:'PUT',path:`/api/agents/${agentId}/personality/text`,body:{text:next,expectedVersion:before}} as never);
   if(r.status!==200){setNotice(r.status===409?'The personality changed while you were writing. The latest is shown; your text was not saved.':'The text was not saved. Try again.');changed();return;}
   changed();onDone('Personality text saved',()=>void card.rollback(before).then(()=>{forgetFacts(client,agentId);}));}
  catch{setNotice('The text was not saved. Try again.');}
  finally{setBusy(false);}
 }
 async function lock(){const next=!locked;await card.lock(next);if(card.getSnapshot().saved)onDone(next?'Personality locked':'Personality unlocked',()=>void card.lock(!next));}
 const off=locked||busy||s.phase==='saving';
 const name=assignment?.profile.name,from=assignment?library?.find(e=>e.id===assignment.id)?.profile:undefined;
 // ⌘L locks or unlocks, as the lock button's tooltip says.
 const lockRef=useRef(lock);lockRef.current=lock;const canLock=!busy&&s.phase!=='saving'&&!choosing&&!speaking;
 useEffect(()=>{if(!canLock)return;const key=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&!e.shiftKey&&!e.altKey&&e.key.toLowerCase()==='l'){e.preventDefault();void lockRef.current();}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[canLock]);
 return <div className="ag-persona">
  <div className="ag-part">
   <div className="ag-pcard"><PersonalityMark profile={from??assignment?.profile} size={46}/>
    <span className="ag-pcard-text"><b>{assignment===undefined?'Reading…':name??'Its own settings'}</b><small dir="auto">{assignment?.profile.description||(assignment===null?'Not from the library. Pick one to start from.':'')}</small></span>
    {assignment&&<label className="ag-switch-label" title={`When ${name} changes in the library, this agent gets it after your review`}><button type="button" role="switch" className="ag-switch" aria-checked={assignment.linked} aria-label="Follows library changes" disabled={off} onClick={()=>void follow(!assignment.linked)}><i/></button>Follows library changes</label>}
    <button type="button" disabled={off} onClick={()=>setChoosing(true)}>Change…</button>
    <button type="button" className="dk-icon" aria-label={locked?'Unlock the personality':'Lock the personality'} title={locked?'Unlock: allow changes again (⌘L)':'Lock: no changes until you unlock (⌘L)'} aria-pressed={locked} disabled={busy||s.phase==='saving'} onClick={()=>void lock()}><UiIcon name="lock" size={16}/></button>
   </div>
   {locked&&<p className="ag-muted"><UiIcon name="lock" size={13}/> Locked: nothing changes until you unlock it.</p>}
   {notice&&<p className="ag-alert" role="status">{notice}</p>}
   {text!==undefined&&<section aria-label="How it talks" className="ag-own"><div className="ag-head-row"><b>How it talks (its text)</b><small className="ag-muted">the same text as Files › Who it is · saving makes a new version</small><button type="button" disabled={busy||s.phase==='saving'} onClick={()=>setEditingText(text)}>Edit…</button></div>
    {text?<pre className="ag-persona-text" dir="auto">{text}</pre>:<p className="ag-muted">No text yet. It talks from its adjustments only.</p>}</section>}
   {editingText!==null&&<DocumentEditor title={`${s.agent?.name??'Agent'} · How it talks`} files={[{id:'personality',name:'PERSONALITY.md',content:editingText}]} maxLength={1024*1024} onChange={(_,t)=>setEditingText(t)} onClose={()=>{const t=editingText;setEditingText(null);void saveText(t);}}/>}
   {personality&&<PersonalityReview controller={personality} agentName={s.agent?.name??'This agent'}/>}
   {draft&&assignment&&<section aria-label="Its own adjustments" className="ag-own"><div className="ag-head-row"><b>Its own adjustments</b><small className="ag-muted">only this agent · saved as you go{from?` · the small mark is ${from.name}’s value`:''}</small></div>
    <fieldset disabled={off}><div className="pl-sliders">{characterKeys.map(k=><Slider key={k} k={k} p={draft} mark={from?sliderValue(from,k):undefined} markName={from?.name} onChange={adjust}/>)}</div>
     <button type="button" className="link-button ag-own-more" onClick={()=>setSpeaking(true)}>Speaking, language and guidelines…</button></fieldset></section>}
   {speaking&&draft&&<PersonalitySheet title="Speaking, language and guidelines" onClose={()=>setSpeaking(false)} footer={<button type="button" className="primary" onClick={()=>setSpeaking(false)}>Done</button>}>
    <fieldset className="ag-own-sheet" disabled={off}><SpeakingPart p={draft} onChange={adjust}/><GuidelinesPart p={draft} onChange={adjust}/></fieldset><p className="fine-print">Only this agent · saved as you go. A personality changes how it talks, never its skills or permissions.</p></PersonalitySheet>}
  </div>
  <aside className="ag-versions" aria-label="Versions"><small className="ag-label">Versions</small>
   {s.versions?s.versions.map(v=>{const now=v.version===version;return <div key={v.version} className="ag-version" data-current={now||undefined}><span><span>Version {v.version}{v.note?` · ${v.note}`:''}</span><small>{v.source==='seed'?'first version':(v.createdAt??'').slice(0,16).replace('T',' ')}</small></span>
    {now?<small className="ag-ok">Now</small>:<button type="button" className="dk-icon" aria-label={`Restore version ${v.version}`} title="Restore as a new version" disabled={off} onClick={()=>void card.rollback(v.version).then(()=>{if(card.getSnapshot().saved){forgetFacts(client,agentId);onDone(`Version ${v.version} restored`);}})}><UiIcon name="history" size={14}/></button>}</div>;}):<p className="ag-muted" role="status">Reading versions…</p>}
   <small className="ag-muted">A personality changes how it talks, never its skills or permissions.</small>
  </aside>
  {choosing&&<ChoosePersonality client={client} current={assignment?.id} onClose={()=>setChoosing(false)} onPick={e=>{setChoosing(false);void assign({id:e.id,revision:e.revision,name:e.profile.name},assignment??undefined);}}/>}
 </div>;
}

/** The library's personalities as faces; one click picks. */
export function PersonalityFaces({client,value,onPick,disabled,autoPick}:{client:SessionClient;value?:string;onPick:(e:Entry)=>void;disabled?:boolean;autoPick?:string}){
 const [entries,setEntries]=useState<Entry[]|null>(null),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0);
 useEffect(()=>{let live=true;setFailed(false);void rpc<{personalities:Entry[]}>(client,'GET',P).then(r=>{if(!live)return;const all=r.personalities.filter(e=>!e.archived);setEntries(all);const first=autoPick&&!value&&all.find(e=>e.id===autoPick);if(first)onPick(first);}).catch(()=>{if(live)setFailed(true);});return()=>{live=false;};},[client,retry]);
 if(failed)return <p role="status">The personality library could not be read. <button type="button" className="link-button" onClick={()=>setRetry(n=>n+1)}>Try again</button></p>;
 if(!entries)return <p className="ag-muted" role="status">Reading personalities…</p>;
 return <div className="ag-faces" role="radiogroup" aria-label="Personality">{entries.map(e=><button type="button" role="radio" aria-checked={value===e.id} key={e.id} className="ag-face-card" disabled={disabled} onClick={()=>onPick(e)}><PersonalityMark profile={e.profile} size={34}/><b>{e.profile.name}</b><small dir="auto">{e.profile.description}</small></button>)}</div>;
}
function ChoosePersonality({client,current,onPick,onClose}:{client:SessionClient;current?:string;onPick:(e:Entry)=>void;onClose:()=>void}){
 return <Sheet title="Choose a personality" wide onClose={onClose} actions={<button type="button" onClick={onClose}>Cancel</button>}><PersonalityFaces client={client} value={current} onPick={onPick}/><p className="fine-print">Edit the library's personalities in Personalities.</p></Sheet>;
}
