import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import type {ReactNode} from 'react';
import type {SessionClient} from './session';
import {ScheduledTaskPermissionController} from './scheduled-task-permission-controller';
import {ScheduledDefinitionSheet} from './ScheduledDefinitionSheet';
import {ScheduleConsentSheet} from './ScheduleConsentSheet';
import {UiIcon} from './ui-icons';
type Job={id:string;name:string;description?:string;responsibility?:string;cronExpression:string;actionType:string;enabled:boolean;lastRun:string|null;nextRun:string|null};
type Run={success:boolean;executedAt:string|null;duration:number|null};
const kinds:Record<string,string>={'execute-skill':'Skill','send-message':'Message delivery','api-call':'Service request','run-workflow':'Workflow','evolve-agent':'Agent review','memory-job':'Memory maintenance',custom:'Workspace job'};
export const scheduleTitle=(job:Pick<Job,'name'>)=>/^memory-weekly-summary-/.test(job.name)?'Weekly memory summary':/^memory-retention-/.test(job.name)?'Memory retention':/^agent-evolution-/.test(job.name)?'Agent review':/^memory-trash-/.test(job.name)?'Empty memory Trash':job.name;
const when=(value:string|null)=>value?new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'Not reported';
export function scheduleLabel(expression:string){
 if(expression==='* * * * *')return 'Every minute';
 const interval=/^\*\/(\d+) \* \* \* \*$/.exec(expression);if(interval)return `Every ${interval[1]} minutes`;
 const daily=/^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(expression);if(daily)return `Daily at ${daily[2].padStart(2,'0')}:${daily[1].padStart(2,'0')}`;
 return 'Custom schedule';
}
const typing=(t:EventTarget|null)=>t instanceof HTMLElement&&(t.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(t.tagName));
/**
 * RUNS-01: the selected system schedule in Runs › Scheduled (it was Settings › Scheduled tasks).
 * Every control of the old page stays: Pause/Resume with Undo, Run now… (one confirmation),
 * Allow to run…, ⋯ › Edit… and Take back the permission…, the cron line and internal name,
 * and the facts. Permission and consent checks are unchanged (owner only).
 */
export function ScheduledJobInspector({client,jobId,active=true,onChanged,onOpenConnections,lastRuns}:{client:SessionClient;jobId:string;active?:boolean;onChanged?:()=>void;onOpenConnections?:()=>void;lastRuns?:ReactNode}){
 const session=useSyncExternalStore(client.subscribe,client.getSnapshot,client.getSnapshot);
 const owner=session.phase==='authenticated'&&session.user?.role==='owner';
 const permission=useMemo(()=>new ScheduledTaskPermissionController(client),[client,active,session.epoch,owner]);
 const access=useSyncExternalStore(permission.subscribe,permission.getSnapshot,permission.getSnapshot);
 const [consent,setConsent]=useState<{id:string;name:string;action:'authorize'|'revoke'}|null>(null);
 const [editor,setEditor]=useState(false);
 const advanced=useRef<HTMLDetailsElement>(null),editButton=useRef<HTMLButtonElement>(null),restoreEditorFocus=useRef(false);
 useEffect(()=>()=>permission.close(),[permission]);
 const [detail,setDetail]=useState<Job|null>(null),[history,setHistory]=useState<Run[]|null>(null);
 const [refresh,setRefresh]=useState(0),[error,setError]=useState(''),[detailError,setDetailError]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[undo,setUndo]=useState<{id:string;enabled:boolean}|null>(null),[confirm,setConfirm]=useState(false);
 const reviewButton=useRef<HTMLButtonElement>(null),restoreReviewFocus=useRef(false);
 useEffect(()=>{if(!consent&&detail&&access.phase==='ready'&&access.selected?.id===detail.id&&reviewButton.current&&restoreReviewFocus.current){restoreReviewFocus.current=false;reviewButton.current.focus();}},[consent,access,detail]);
 useEffect(()=>{if(editor||consent||!restoreEditorFocus.current)return;if(access.phase==='ready'&&editButton.current){if(advanced.current)advanced.current.open=true;restoreEditorFocus.current=false;editButton.current.focus();}},[editor,consent,access,detail]);
 const dialog=useRef<HTMLDialogElement>(null);const epoch=useRef(0);
 useEffect(()=>{if(confirm)dialog.current?.showModal();else dialog.current?.close();},[confirm]);
 useEffect(()=>{permission.invalidate();void permission.select(null);if(!active||!owner||!jobId){setDetail(null);setHistory(null);return;}let stopped=false;setDetail(null);setHistory(null);setDetailError(false);const path='/api/scheduler/jobs/'+encodeURIComponent(jobId);
 void Promise.all([client.request({method:'GET',path}),client.request({method:'GET',path:path+'/history'})]).then(([d,h])=>{if(stopped)return;if(d.status!==200||h.status!==200)throw Error();const job=(d.body as {job:Job}).job;setDetail(job);void permission.select({id:job.id,actionType:job.actionType,enabled:job.enabled});setHistory((h.body as {history:Run[]}).history);}).catch(()=>{if(!stopped)setDetailError(true);});return()=>{stopped=true;};},[client,owner,active,jobId,refresh,permission]);
 useEffect(()=>{epoch.current++;setConfirm(false);setConsent(null);setEditor(false);setUndo(null);setNotice('');setError('');return()=>{epoch.current++;};},[active,client,owner,session.epoch,jobId]);
 async function action(id:string,command:'enable'|'disable'|'execute',isUndo=false){
  if(busy||consent||editor||!owner||!active)return;const current=epoch.current;setBusy(true);setError('');setNotice('');setUndo(null);setConfirm(false);
  try{if(command!=='disable'){const check=new ScheduledTaskPermissionController(client);try{const metadata=await client.request({method:'GET',path:`/api/scheduler/jobs/${encodeURIComponent(id)}`});if(current!==epoch.current||metadata.status!==200)throw Error();const job=(metadata.body as {job:Job}).job;if(job.id!==id)throw Error();await check.select({id:job.id,actionType:job.actionType,enabled:job.enabled});const allowed=check.getSnapshot().commands;if(current!==epoch.current||!(command==='execute'?allowed.run:allowed.resume))throw Error();}finally{check.close();}}if(current!==epoch.current)return;const r=await client.request({method:'POST',path:`/api/scheduler/jobs/${encodeURIComponent(id)}/${command}`,body:{}});if(current!==epoch.current)return;if(r.status!==200||(r.body as {success:boolean}).success!==true)throw Error();setNotice(command==='execute'?'Run completed.':command==='enable'?'Schedule resumed.':'Schedule paused.');if(command!=='execute'&&!isUndo)setUndo({id,enabled:command==='disable'});setRefresh(n=>n+1);onChanged?.();}
  catch{if(current===epoch.current)setError(command==='execute'?'The run did not complete. Its reason shows under Last runs.':'The schedule could not be changed.');}
  finally{setBusy(false);}
 }
 const currentAccess=!!detail&&jobId===detail.id&&access.selected?.id===detail.id&&access.selected.actionType===detail.actionType&&access.selected.enabled===detail.enabled&&!consent&&!editor;
 const canRun=currentAccess&&access.commands.run,canResume=currentAccess&&access.commands.resume;
 function openConsent(action:'authorize'|'revoke'){if(!detail||!currentAccess||!access.commands[action])return;permission.invalidate();setConfirm(false);setConsent({id:detail.id,name:scheduleTitle(detail),action});}
 function openEditor(){if(!active||busy||consent||editor||!owner||!currentAccess||!access.commands.edit)return;permission.invalidate();setConfirm(false);setUndo(null);setEditor(true);}
 // Shortcuts of the selected schedule (board RN4c): ⌘⇧P pause/resume, ⌘↩ Run now…, ⌘E Edit…, ⌘Z undo.
 useEffect(()=>{if(!active||!owner)return;const onKey=(e:KeyboardEvent)=>{if(!(e.metaKey||e.ctrlKey)||!detail||confirm||consent||editor)return;const k=e.key.toLowerCase();
  if(e.shiftKey&&k==='p'){e.preventDefault();if(detail.enabled||canResume)void action(detail.id,detail.enabled?'disable':'enable');}
  else if(!e.shiftKey&&k==='enter'&&canRun){e.preventDefault();setConfirm(true);}
  else if(!e.shiftKey&&k==='e'){e.preventDefault();openEditor();}
  else if(!e.shiftKey&&k==='z'&&undo&&!typing(e.target)){e.preventDefault();void action(undo.id,undo.enabled?'enable':'disable',true);}};
  window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);});
 if(!owner)return <p className="fine-print">Only the workspace owner can manage system schedules.</p>;
 return <div className="schedule-inspector runs-job" aria-label="Selected schedule" aria-busy={!detail&&!detailError}>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status" className="schedule-notice">{notice}{undo&&<button onClick={()=>void action(undo.id,undo.enabled?'enable':'disable',true)} disabled={busy}>Undo <kbd>⌘Z</kbd></button>}</p>}
  {detailError?<p role="alert">This schedule could not be loaded.</p>:!detail?<p role="status">Loading schedule…</p>:<>
   <p className="runs-insp-kind">System job · {detail.enabled?'On':'Paused'}</p><h3>{scheduleTitle(detail)}</h3>
   <dl className="runs-facts"><dt>What it does</dt><dd>{detail.description||kinds[detail.actionType]||'Workspace job'}</dd><dt>Done by</dt><dd>{detail.responsibility??'Workspace service'}</dd><dt>When</dt><dd>{scheduleLabel(detail.cronExpression)}{detail.enabled?` · next: ${when(detail.nextRun)}`:' · paused'}</dd><dt>Last</dt><dd>{when(detail.lastRun)}</dd><dt>Allowed</dt><dd>{access.permission==='authorized'?'Yes · by your code':access.permission==='authorization_required'?'Not yet · needs your OK with a code':access.permission==='not_required'?'No OK needed':access.phase==='unavailable'?'Could not check':'Checking…'}</dd></dl>
   {access.permission==='authorization_required'&&<p className="fine-print">Running it needs your OK with a code once, for a time you choose.</p>}{access.phase==='unavailable'&&<p className="fine-print">The run permission could not be checked.</p>}
   <section className="runs-sect"><h4>Last runs</h4>{lastRuns??(!history?.length?<p className="fine-print">No runs yet.</p>:<ol className="schedule-history">{history.map((run,i)=><li key={i}><span className="st-state" data-state={run.success?'ready':'warn'}><i aria-hidden="true"/>{run.success?'Done':'Did not finish'}</span><time>{when(run.executedAt)}</time>{run.duration!==null&&<small>{(run.duration/1000).toLocaleString(undefined,{maximumFractionDigits:1})} s</small>}</li>)}</ol>)}</section>
   <details className="runs-tech"><summary><UiIcon name="chevron" size={11}/>Technical details</summary><code>{detail.cronExpression}</code>{scheduleTitle(detail)!==detail.name&&<p>{detail.name}</p>}<p className="fine-print">Times follow the server's clock; dates show in this device's time zone.</p></details>
   <div className="schedule-actions runs-actions">{currentAccess&&access.commands.authorize?<button ref={reviewButton} className="primary" disabled={busy} onClick={()=>openConsent('authorize')}><UiIcon name="lock" size={14}/>Allow to run…</button>:null}
    <button disabled={busy||!!consent||!!editor||(!detail.enabled&&!canResume)} title={detail.enabled?'Pause (⌘⇧P)':'Resume (⌘⇧P)'} onClick={()=>void action(detail.id,detail.enabled?'disable':'enable')}><UiIcon name={detail.enabled?'pause':'power'} size={14}/>{detail.enabled?'Pause':'Resume'}</button>
    <button disabled={busy||!canRun} title="Run now… (⌘↩)" onClick={()=>setConfirm(true)}><UiIcon name="play" size={14}/>Run now…</button>
    <details ref={advanced} className="schedule-advanced st-menu"><summary className="tool" aria-label="More" title="More"><UiIcon name="more" size={15}/></summary><div role="menu">{currentAccess&&access.commands.edit&&<button ref={editButton} role="menuitem" disabled={busy} onClick={openEditor}>Edit… <kbd>⌘E</kbd></button>}{currentAccess&&access.commands.revoke&&<button role="menuitem" disabled={busy} onClick={()=>openConsent('revoke')}>Take back the permission…</button>}</div></details></div>
  </>}
  <dialog ref={dialog} className="schedule-confirm" onCancel={()=>setConfirm(false)} onClose={()=>setConfirm(false)}><h3>Run {detail?scheduleTitle(detail):'schedule'} now?</h3><p>This starts its existing {kinds[detail?.actionType??'']?.toLowerCase()??'workspace action'} immediately.</p><div><button autoFocus onClick={()=>setConfirm(false)}>Cancel</button><button className="primary" disabled={busy||!detail||!canRun} onClick={()=>detail&&void action(detail.id,'execute')}>Run now</button></div></dialog>
  {editor&&active&&owner&&detail&&<ScheduledDefinitionSheet client={client} jobId={detail.id} creating={false} onOpenConnections={onOpenConnections} onClose={()=>{restoreEditorFocus.current=true;permission.invalidate();setEditor(false);setRefresh(n=>n+1);onChanged?.();}}/>}
  {consent&&active&&owner&&<ScheduleConsentSheet client={client} jobId={consent.id} jobName={consent.name} action={consent.action} onClose={()=>{restoreReviewFocus.current=true;permission.invalidate();setConsent(null);setRefresh(n=>n+1);onChanged?.();}}/>}
 </div>;
}
