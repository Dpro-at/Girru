/** Existing learning policy on encrypted runtime. Important changes refuse automatic save; never queue plaintext proposals. */
import {classifyLearning,MAX_LEARNED_CONTENT} from '../learning.js';
import {isMemoryType} from '../types.js';
import {normalizeDrawer,type DrawerRef} from '../drawers.js';
import {redactImportText} from '../import/redact.js';
import type {createEncryptedMemoryRuntime} from './runtime-host.js';
import type {captureAuthenticatedMemoryRun} from './auth-capture.js';
import {MemoryCipherError} from './envelope.js';
type Runtime=ReturnType<typeof createEncryptedMemoryRuntime>;
export async function learnEncryptedRoutine(input:{runtime:Runtime;run:Parameters<typeof captureAuthenticatedMemoryRun>[2];drawer:DrawerRef;content:string;type?:string;importance?:number}){
 const {runtime}=input,run={...input.run,delegatedFrom:[...input.run.delegatedFrom],drawers:input.run.drawers.map(d=>({...d}))},drawer=normalizeDrawer(input.drawer),type=input.type??'fact',importance=input.importance??5;
 if(typeof input.content!=='string'||input.content.length>MAX_LEARNED_CONTENT||!isMemoryType(type)||!Number.isInteger(importance)||importance<1||importance>10||!run.drawers.some(d=>d.kind===drawer.kind&&(d.key??'')===(drawer.key??'')))throw new MemoryCipherError();
 const content=redactImportText(input.content).text;if(!content.trim())throw new MemoryCipherError();
 const similar=await runtime.recall({run:{...run,drawers:[drawer]},query:Buffer.from(content,'utf8').subarray(0,4000).toString('utf8'),limit:50});
 const classification=classifyLearning({content,type,drawer,origin:'agent'},{similar:similar.map(row=>({id:row.id,content:row.content,similarity:row.score}))});
 if(classification.kind==='duplicate')return{status:'duplicate' as const,duplicateOf:classification.duplicateOf??null};
 if(!runtime.canAutomaticallyCreate(run.agentId))return{status:'owner-review-required' as const,reasons:[...classification.reasons,'Run inputs require explicit fresh owner admission before persistence'],queued:false as const};
 if(classification.conflictsWith.length===1){const queued=await runtime.queueConflict({run,drawer,memoryId:classification.conflictsWith[0],entry:{content,type,importance},reasons:classification.reasons});return{status:'owner-review-required' as const,reasons:classification.reasons,queued:true as const,proposalId:queued.id};}
 if(classification.conflictsWith.length>1)return{status:'owner-review-required' as const,reasons:classification.reasons,queued:false as const};
 if(classification.kind==='important'||importance>=8){const queued=await runtime.queueAddition({run,drawer,entry:{content,type,importance},reasons:classification.reasons});return{status:'owner-review-required' as const,reasons:classification.reasons,queued:true as const,proposalId:queued.id};}
 const saved=await runtime.createMemory({run,drawer,entry:{content,type,importance}});return{status:'saved' as const,id:saved.id};
}
