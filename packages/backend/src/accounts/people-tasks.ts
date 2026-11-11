/**
 * CP17 D: tasks with people from other Girru accounts.
 *
 * A person's computer may only offer a task or return an answer. Nothing runs until this
 * computer's owner presses Allow (never "always allow" for people), and the task then runs
 * in a normal "Ask me" chat of the owner's own agent. Only the task text goes out. The answer
 * never leaves by itself: the owner reads the draft (secrets removed, at most 8000 characters),
 * may edit it, and presses Send answer. Never agents, settings, memory, chats, files or
 * backups. The relay passes messages and stores nothing.
 */
import {randomUUID} from 'node:crypto';
import type {Actor} from '../repositories/actor.js';
import {q} from '../repositories/sql-steps.js';
import {createConversation,findConversation} from '../repositories/chat-conversations.js';
import type {ComputerOwnerChannel} from '../devices/control-channel.js';
import {deviceIdOf} from '../phone/protocol/encoding.js';
import {peerKey} from '../phone/protocol/e2e.js';
import {chatRuns} from '../services/chat-runs.js';
import {onSessionRunFinished} from '../services/session-run-hooks.js';
import {redactImportText} from '../memory/import/redact.js';

export const PERSON_TASK_CHARS=4000;
export const PERSON_ANSWER_CHARS=8000;
const MAX_WAITING_PER_PERSON=20;
/** People get their own small pool of relay slots, so they can never use up the owner's own computers' slots. */
const MAX_PEOPLE_PINS=16;

export interface PeopleComputer {deviceId:string;publicKey:string;label:string;osFamily:string;viaGoogle?:boolean;presence:string}
export interface PeopleLink {linkId:string;person:{publicId:string;nickname:string|null};computers:PeopleComputer[]}
export interface PersonTaskRow {id:string;direction:'out'|'in';link_id:string;person_id:string;person_name:string;device_id:string;text:string;state:'waiting'|'running'|'review'|'done'|'declined'|'failed';answer:string;session_id:string|null;delivered:number;created_at:number;updated_at:number}

interface Deps {
  ownerId:()=>string;
  scope:()=>string;
  actor:()=>Actor;
  control:()=>ComputerOwnerChannel|null;
  /** The linked people from the account service (cached by the caller for a few seconds unless forced). */
  linked:(force:boolean)=>Promise<PeopleLink[]>;
  /** Where tasks from people run: the project and agent this computer works on, if chosen. */
  destination:()=>{projectId?:string|null;agentId?:string|null}|null;
  start?:typeof import('../api/routes/chat-conversations.js').startTurn;
}

const nameOf=(p:PeopleLink['person'])=>p.nickname??p.publicId;
const peerOf=(c:PeopleComputer)=>deviceIdOf(peerKey(c.publicKey));
const ID=/^[a-f0-9-]{36}$/;
function cleanAnswer(text:string){return redactImportText(text).text.replace(/\[SECRET:[^\]]+\]/gi,'[redacted]').slice(0,PERSON_ANSWER_CHARS);}

export class PeopleTasks {
  private stopHook:(()=>void)|null=null;
  /** Computers this module pinned for linked people (never the owner's own computers). */
  private peoplePins=new Set<string>();
  constructor(private deps:Deps){}

  start(){if(!this.stopHook)this.stopHook=onSessionRunFinished((sessionId,runId,status)=>this.sessionFinished(sessionId,runId,status));}
  stop(){this.stopHook?.();this.stopHook=null;}

  /** Pins linked people's computers so the relay lets them reach this one. Every task from them still waits for the owner's Allow, and every answer for the owner's Send. */
  async pinLinked(force=false){
    const control=this.deps.control();if(!control)return [];
    const links=await this.deps.linked(force);
    /* Rebuilt from the current links each time: a removed person's computers lose their slot at once. */
    const wanted=new Map<string,string>();
    for(const link of links)for(const c of link.computers)if(wanted.size<MAX_PEOPLE_PINS)wanted.set(peerOf(c),c.publicKey);
    for(const id of [...this.peoplePins])if(!wanted.has(id)){control.unpin(id);this.peoplePins.delete(id);}
    for(const [id,key] of wanted){if(this.peoplePins.has(id)||control.pinnedPublicKey(id))continue;try{control.pin(key);this.peoplePins.add(id);}catch{/* the channel is full: this one waits */}}
    await this.retryUndelivered().catch(()=>{});
    return links;
  }

  private where(){return [this.deps.ownerId(),this.deps.scope()] as const;}
  private async row(direction:'out'|'in',deviceId:string,id:string){const [u,a]=this.where();return q.one<PersonTaskRow>('SELECT * FROM people_tasks WHERE user_id=? AND account_id=? AND direction=? AND device_id=? AND id=?',u,a,direction,deviceId,id);}
  private async set(r:PersonTaskRow,fields:Partial<Pick<PersonTaskRow,'state'|'answer'|'session_id'|'delivered'>>){
    const [u,a]=this.where(),next={...r,...fields};
    await q.run('UPDATE people_tasks SET state=?,answer=?,session_id=?,delivered=?,updated_at=? WHERE user_id=? AND account_id=? AND direction=? AND device_id=? AND id=?',next.state,next.answer,next.session_id,next.delivered,Date.now(),u,a,r.direction,r.device_id,r.id);
    return next;
  }

  /** The owner's list: tasks sent to people and tasks people sent here (newest first). */
  async list(){const [u,a]=this.where();return (await q.all<PersonTaskRow>('SELECT * FROM people_tasks WHERE user_id=? AND account_id=? ORDER BY created_at DESC LIMIT 100',u,a)).map(r=>({id:r.id,direction:r.direction,linkId:r.link_id,person:{publicId:r.person_id,name:r.person_name},text:r.text,state:r.state,answer:r.answer,sessionId:r.direction==='in'?r.session_id:null,createdAt:r.created_at,updatedAt:r.updated_at}));}

  /** Sends a task to one of the person's computers that is on now; nothing waits on the relay. */
  async send(linkId:unknown,text:unknown){
    const control=this.deps.control();if(!control)throw Error('account_sign_in_required');
    if(typeof linkId!=='string'||!ID.test(linkId))throw Error('account_input_invalid');
    const body=typeof text==='string'?text.trim():'';if(!body||body.length>PERSON_TASK_CHARS)throw Error('account_people_task_text');
    const link=(await this.pinLinked(true)).find(l=>l.linkId===linkId);if(!link)throw Error('account_people_unavailable');
    const targets=[...link.computers].sort((x,y)=>(y.presence==='online'?1:0)-(x.presence==='online'?1:0));
    if(!targets.length)throw Error('account_people_offline');
    const id=randomUUID(),[u,a]=this.where(),now=Date.now();
    for(const target of targets){
      const device=peerOf(target);
      try{
        const r=await control.request(device,'person.task.offer',{taskId:id,text:body});
        if(r?.received!==true)continue;
        await q.run("INSERT INTO people_tasks(id,user_id,account_id,direction,link_id,person_id,person_name,device_id,text,state,answer,session_id,delivered,created_at,updated_at) VALUES(?,?,?,'out',?,?,?,?,?,'waiting','',NULL,1,?,?)",id,u,a,link.linkId,link.person.publicId,nameOf(link.person),device,body,now,now);
        return {sent:true,taskId:id,to:{name:nameOf(link.person),computer:target.label}};
      }catch{/* That computer is off or did not answer: try the next one. */}
    }
    throw Error('account_people_offline');
  }

  /** A request from another computer on the shared channel; only linked people's computers get here. */
  async receive(peer:string,request:{operation:string;input:unknown}){
    const links=await this.deps.linked(false).then(l=>l.some(x=>x.computers.some(c=>peerOf(c)===peer))?l:this.deps.linked(true));
    const link=links.find(l=>l.computers.some(c=>peerOf(c)===peer));
    if(!link)throw Error('account_people_unavailable');
    const input=request.input as Record<string,unknown>;
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('account_input_invalid');
    const [u,a]=this.where(),now=Date.now();
    if(request.operation==='person.task.offer'){
      if(Object.keys(input).sort().join(',')!=='taskId,text'||typeof input.taskId!=='string'||!ID.test(input.taskId)||typeof input.text!=='string')throw Error('account_input_invalid');
      const text=input.text.trim();if(!text||text.length>PERSON_TASK_CHARS)throw Error('account_input_invalid');
      if(await this.row('in',peer,input.taskId))return {received:true};
      const waiting=await q.one<{n:number}>("SELECT COUNT(*) AS n FROM people_tasks WHERE user_id=? AND account_id=? AND direction='in' AND person_id=? AND state='waiting'",u,a,link.person.publicId);
      if(Number(waiting?.n??0)>=MAX_WAITING_PER_PERSON)throw Error('account_people_capacity');
      await q.run("INSERT INTO people_tasks(id,user_id,account_id,direction,link_id,person_id,person_name,device_id,text,state,answer,session_id,delivered,created_at,updated_at) VALUES(?,?,?,'in',?,?,?,?,?,'waiting','',NULL,1,?,?)",input.taskId,u,a,link.linkId,link.person.publicId,nameOf(link.person),peer,text,now,now);
      return {received:true};
    }
    if(request.operation==='person.task.answer'){
      if(Object.keys(input).sort().join(',')!=='answer,state,taskId'||typeof input.taskId!=='string'||!ID.test(input.taskId)||!['done','declined','failed'].includes(String(input.state))||typeof input.answer!=='string')throw Error('account_input_invalid');
      const r=await this.row('out',peer,input.taskId);
      if(!r||r.link_id!==link.linkId)throw Error('account_people_unavailable');
      if(r.state==='waiting'||r.state==='running')await this.set(r,{state:input.state as PersonTaskRow['state'],answer:input.answer.slice(0,PERSON_ANSWER_CHARS)});
      return {received:true};
    }
    throw Error('account_input_invalid');
  }

  /** Allow: the task runs here in a new "Ask me" chat of this computer's own agent. */
  async allow(taskId:unknown){
    const r=await this.incoming(taskId);if(r.state!=='waiting')throw Error('account_people_unavailable');
    const owner=this.deps.ownerId(),dest=this.deps.destination();
    const made=await createConversation(owner,{title:`From ${r.person_name}: ${r.text.replace(/\s+/g,' ').slice(0,60)}`,agentId:dest?.agentId??null,projectId:dest?.projectId??null,mode:'ask'});
    const c=await findConversation(owner,made.id);if(!c)throw Error('account_people_task_start');
    const message=`${r.text}\n\n(A task from ${r.person_name}, a person you work with on another Girru account. Only your final answer goes back to them, so end with a clear, short report. Never include secrets, keys or private notes.)`;
    const start=this.deps.start??(await import('../api/routes/chat-conversations.js')).startTurn;
    const runId=`person-${randomUUID()}`;/* Only this run and later runs in this one chat can fill the draft; the owner still sends it. */
    await this.set(r,{state:'running',session_id:c.id});
    const out=await start({userId:owner,role:'owner',c,runId,message,displayMessage:r.text,onFinished:async status=>{await this.sessionFinished(c.id,runId,status);}});
    if(out.code!==202){await this.set({...r,state:'running',session_id:c.id},{state:'waiting',session_id:null});throw Error('account_people_task_start');}
    return {allowed:true,sessionId:c.id};
  }

  async decline(taskId:unknown){const r=await this.incoming(taskId);if(r.state!=='waiting')throw Error('account_people_unavailable');await this.finish(r,'declined','');return {declined:true};}

  private async incoming(taskId:unknown){
    if(typeof taskId!=='string'||!ID.test(taskId))throw Error('account_input_invalid');
    const [u,a]=this.where(),r=await q.one<PersonTaskRow>("SELECT * FROM people_tasks WHERE user_id=? AND account_id=? AND direction='in' AND id=?",u,a,taskId);
    if(!r)throw Error('account_people_unavailable');return r;
  }

  /** A run in a person's task chat ended: its reply becomes the draft answer the owner reviews.
   *  Nothing is sent from here; a later run in the same chat only replaces the draft. */
  private async sessionFinished(sessionId:string,runId:string,status:string){
    const [u,a]=this.where();
    const r=await q.one<PersonTaskRow>("SELECT * FROM people_tasks WHERE user_id=? AND account_id=? AND direction='in' AND session_id=? AND state IN ('running','review')",u,a,sessionId);
    if(!r)return;
    if(status==='complete'){
      const waits=await q.one<{n:number}>("SELECT COUNT(*) AS n FROM tool_approvals WHERE user_id=? AND session_id=? AND status='pending'",u,sessionId).catch(()=>({n:0}));
      if(Number(waits?.n??0)>0)return;
    }
    const draft=status==='complete'?cleanAnswer(chatRuns.get(runId)?.answer??''):'';
    await this.set(r,{state:'review',answer:draft||r.answer});
  }

  /** The owner read the draft and sends it (edited or not); it is cleaned once more before it leaves. */
  async sendAnswer(taskId:unknown,text:unknown){
    const r=await this.incoming(taskId);if(r.state!=='review'&&r.state!=='running')throw Error('account_people_unavailable');
    const answer=typeof text==='string'?cleanAnswer(text.trim()):'';if(!answer)throw Error('account_people_task_text');
    await this.finish(r,'done',answer);return {sent:true};
  }
  /** The owner chose not to send an answer: the person only learns it did not finish. */
  async dropAnswer(taskId:unknown){const r=await this.incoming(taskId);if(r.state!=='review'&&r.state!=='running')throw Error('account_people_unavailable');await this.finish(r,'failed','It did not finish on their computer.');return {sent:false};}

  private async finish(r:PersonTaskRow,state:'done'|'declined'|'failed',answer:string){
    await this.set(r,{state,answer,delivered:0});
    /* Pins the person's computers if needed, then sends every answer still waiting (this one included). */
    await this.pinLinked(false).catch(()=>{});
  }
  private async deliver(r:PersonTaskRow){
    const control=this.deps.control();if(!control)return;
    const res=await control.request(r.device_id,'person.task.answer',{taskId:r.id,state:r.state,answer:r.answer});
    if(res?.received===true)await this.set(r,{delivered:1});
  }
  /** Answers that could not reach a person's computer go when it is seen again. */
  async retryUndelivered(){const [u,a]=this.where();for(const r of await q.all<PersonTaskRow>("SELECT * FROM people_tasks WHERE user_id=? AND account_id=? AND direction='in' AND delivered=0 LIMIT 10",u,a))await this.deliver(r).catch(()=>{});}
}
