import {useEffect,useMemo,useRef,useState} from 'react';
import type {SessionClient} from './session';
import type {AgentChoice,ModelOption,Project} from './conversations';
import {UiIcon} from './ui-icons';

/**
 * RUNS-01 (board RN6): "Schedule a task". A schedule only makes a task: one box for what the
 * agent should do, who does it and when; Advanced stays folded. Create makes a board card with
 * the instructions and its repeat (POST /api/runs/schedules); each run continues that task.
 */
type Every='hourly'|'daily'|'weekly';
const DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const words=(s:string)=>s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu,' ').split(/\s+/).filter(w=>w.length>2);
/** The agent the text points at: its name, or its department's words; else the Main agent. */
export function suggestAgent(text:string,agents:readonly AgentChoice[]):string{
 const w=new Set(words(text));const main=agents.find(a=>a.primary)??agents[0];
 const byName=agents.find(a=>words(a.name).some(x=>w.has(x)));if(byName)return byName.id;
 const byDept=agents.filter(a=>a.department&&words(a.department).some(x=>w.has(x)||w.has(x.replace(/s$/,''))));
 return (byDept[0]??main)?.id??'';
}
export function ScheduleTaskSheet({client,agents,projects,models=[],onClose}:{client:SessionClient;agents:readonly AgentChoice[];projects:readonly Project[];models?:readonly ModelOption[];onClose:(made?:string)=>void}){
 const dialog=useRef<HTMLDialogElement>(null),box=useRef<HTMLTextAreaElement>(null);
 const [instructions,setInstructions]=useState(''),[agentId,setAgentId]=useState(''),[picked,setPicked]=useState(false);
 const [every,setEvery]=useState<Every>('daily'),[at,setAt]=useState('09:00'),[weekday,setWeekday]=useState(1);
 const [advanced,setAdvanced]=useState(false),[projectId,setProjectId]=useState(''),[notify,setNotify]=useState<'important'|'all'|'none'>('important'),[newChat,setNewChat]=useState(true),[thinking,setThinking]=useState<'quick'|'normal'|'deep'>('normal'),[model,setModel]=useState('');
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{dialog.current?.showModal();box.current?.focus();},[]);
 const suggested=useMemo(()=>suggestAgent(instructions,agents),[instructions,agents]);
 const who=picked?agentId:suggested;
 async function create(){
  if(busy||!instructions.trim())return;setBusy(true);setError('');
  try{
   const body:Record<string,unknown>={instructions:instructions.trim(),every,at,...(every==='weekly'?{weekday}:{}),...(who?{agentId:who}:{}),notify,newChat,thinking,...(projectId?{projectId}:{}),...(model?{model}:{})};
   const r=await client.request({method:'POST',path:'/api/runs/schedules',body} as never);
   if(r.status!==201)throw Error();onClose((r.body as {id:string}).id);
  }catch{setError('The task could not be scheduled. Check the time and try again.');setBusy(false);}
 }
 const agent=agents.find(a=>a.id===who);
 return <dialog ref={dialog} className="task-sheet" aria-label="Schedule a task" onCancel={e=>{e.preventDefault();onClose();}}>
  <form onSubmit={e=>{e.preventDefault();void create();}} onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();void create();}}}>
   <header><h3>Schedule a task</h3><button type="button" className="tool" aria-label="Close" title="Close (Esc)" onClick={()=>onClose()}><UiIcon name="close" size={14}/></button></header>
   <textarea ref={box} aria-label="Instructions" placeholder="What should the agent do? Write it like you would tell a person." maxLength={5000} value={instructions} onChange={e=>setInstructions(e.target.value)}/>
   <div className="task-group">
    <label><span>Who does it{!picked&&agent?<small className="fine-print"> · picked from the text</small>:null}</span><select aria-label="Who does it" value={who} onChange={e=>{setAgentId(e.target.value);setPicked(true);}}>{!agents.length&&<option value="">The Main agent</option>}{agents.filter(a=>!a.subAgentOf).map(a=><option key={a.id} value={a.id}>{a.name}{a.department?` · ${a.department}`:''}</option>)}</select></label>
    <label><span>Repeat</span><select aria-label="Repeat" value={every} onChange={e=>setEvery(e.target.value as Every)}><option value="hourly">Every hour</option><option value="daily">Every day</option><option value="weekly">Every week</option></select></label>
    {every==='weekly'&&<label><span>Day</span><select aria-label="Day" value={weekday} onChange={e=>setWeekday(Number(e.target.value))}>{DAYS.map((d,i)=><option key={d} value={i}>{d}</option>)}</select></label>}
    <label><span>{every==='hourly'?'At minute':'Time'}</span><input type="time" aria-label="Time" value={at} onChange={e=>setAt(e.target.value||'09:00')}/></label>
   </div>
   <button type="button" className="task-advanced" aria-expanded={advanced} onClick={()=>setAdvanced(v=>!v)}>Advanced<UiIcon name="chevron" size={11}/></button>
   {advanced&&<div className="task-group">
    <label><span>Project</span><select aria-label="Project" value={projectId} onChange={e=>setProjectId(e.target.value)}><option value="">No project</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <label><span>Notifications</span><select aria-label="Notifications" value={notify} onChange={e=>setNotify(e.target.value as 'important'|'all'|'none')}><option value="important">Important only</option><option value="all">Every run</option><option value="none">None</option></select></label>
    <label><span>Start each run in a new chat</span><input type="checkbox" role="switch" aria-label="Start each run in a new chat" checked={newChat} onChange={e=>setNewChat(e.target.checked)}/></label>
    <label><span>App and model</span><select aria-label="App and model" value={model} onChange={e=>setModel(e.target.value)}><option value="">The agent’s own</option>{models.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
    <label><span>Thinking</span><select aria-label="Thinking" value={thinking} onChange={e=>setThinking(e.target.value as 'quick'|'normal'|'deep')}><option value="quick">Quick</option><option value="normal">Normal</option><option value="deep">Deep</option></select></label>
   </div>}
   <footer>{error&&<p role="alert">{error}</p>}<button type="button" onClick={()=>onClose()}>Cancel</button><button type="submit" className="primary" disabled={busy||!instructions.trim()} title="Create (⌘↩)">Create</button></footer>
  </form>
 </dialog>;
}
