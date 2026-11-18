/** Server-only tool binding. All unsupported encrypted verbs refuse; never invoke a plaintext fallback. */
import {learnEncryptedRoutine} from './learning-gateway.js';
import {parseDrawerId,defaultDrawerForType} from '../drawers.js';
import type {ToolExecutionContext,ToolResult} from '../../tools/types.js';
import {toolMemoryUser,toolMemoryDrawers,toolOwnerTurn} from '../../tools/memory/scope.js';
import type {createEncryptedMemoryRuntime} from './runtime-host.js';
import type {captureAuthenticatedMemoryRun} from './auth-capture.js';
type Runtime=ReturnType<typeof createEncryptedMemoryRuntime>;
export function createEncryptedMemoryToolBinding(input:{runtime:Runtime;resolveRun:(context:ToolExecutionContext)=>Promise<Parameters<typeof captureAuthenticatedMemoryRun>[2]>}):NonNullable<ToolExecutionContext['encryptedMemory']>{
 const {runtime,resolveRun}=input;
 const refused=():ToolResult=>({content:[{type:'text',text:'Encrypted memory operation unavailable for this run.'}],error:'encrypted_memory_unavailable'});
 return{async execute(name,params,context){try{
  if(toolMemoryUser(context)!==runtime.ownerId||!context.agentId||context.actor?.kind!=='agent'||context.actor.agentId!==context.agentId||context.toolPolicy)return refused();
  const allowed=toolMemoryDrawers(context),run=await resolveRun(context);
  if(run.agentId!==context.agentId||run.audience!=='owner'||run.delegatedFrom.join('\0')!==(context.delegatedFrom??[]).join('\0')||run.drawers.some(drawer=>!allowed.some(open=>open.kind===drawer.kind&&(open.key??'')===(drawer.key??'')&&(open.readOnly!==true||drawer.readOnly===true))))return refused();
  if(name==='handoff_save'||name==='handoff_read'){
   if(context.delegation||context.handoffTools===false||!toolOwnerTurn(context))return refused();
   const scope=context.taskId&&context.taskRun?{kind:'task' as const,id:context.taskId,runId:context.taskRun.runId}:context.chatPlan===true&&context.sessionId?{kind:'conversation' as const,id:context.sessionId}:null;if(!scope)return refused();
   if(name==='handoff_read'){if(Object.keys(params).length)return refused();const note=await runtime.readHandoffForRun({run,scope});return{content:[{type:'text',text:note?JSON.stringify(note):'No handoff note yet.'}]};}
   if(Object.keys(params).some(key=>!['done','left','next','questions','blockers','files'].includes(key)))return refused();const saved=await runtime.saveHandoffForRun({run,scope,body:params});return{content:[{type:'text',text:JSON.stringify(saved)}],data:{success:true,...saved}};
  }
  if(name==='memory_search'){
   if(Object.keys(params).some(key=>!['query','limit'].includes(key))||typeof params.query!=='string'||params.limit!==undefined&&(!Number.isInteger(params.limit)||Number(params.limit)<1||Number(params.limit)>50))return refused();
   const rows=await runtime.recall({run,query:params.query,limit:params.limit as number|undefined});return{content:[{type:'text',text:JSON.stringify(rows)}],data:{memories:rows}};
  }
  if(name==='memory_forget'||name==='memory_restore'){
   if(!toolOwnerTurn(context)||Object.keys(params).some(key=>key!=='id')||typeof params.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(params.id))return refused();
   const result=await runtime.mutateForRun({run,id:params.id,operation:name==='memory_forget'?'forget':'restore'});return{content:[{type:'text',text:JSON.stringify(result)}],data:{success:true}};
  }
  if(name==='memory_save'){
   if(Object.keys(params).some(key=>!['content','type','importance','drawer'].includes(key))||typeof params.content!=='string'||params.type!==undefined&&typeof params.type!=='string'||params.drawer!==undefined&&typeof params.drawer!=='string'||params.importance!==undefined&&typeof params.importance!=='number')return refused();
   const drawer=typeof params.drawer==='string'?parseDrawerId(params.drawer):defaultDrawerForType(typeof params.type==='string'?params.type:undefined);
   const result=await learnEncryptedRoutine({runtime,run,drawer,content:params.content,type:params.type as string|undefined,importance:params.importance as number|undefined});
   return{content:[{type:'text',text:JSON.stringify(result)}],data:result};
  }
  return refused();
 }catch{return refused();}}};
}
