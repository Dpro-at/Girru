/** Bounded no-content outcomes through the existing non-throwing audit writer. */
import {logAudit} from './audit-logger.js';
export function auditMcpOutcome(owner:string|undefined,action:string,resourceType:string,resourceId:unknown,outcome:'created'|'applied'|'published'|'submitted'|'replayed'|'refused'|'uncertain',status?:number){
 // Audit failures must never turn an already-durable write into a reported mutation failure.
 try{logAudit({event_type:'data.update',event_category:'data_modification',severity:outcome==='refused'||outcome==='uncertain'?'warning':'info',user_id:owner,resource_type:resourceType,resource_id:typeof resourceId==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(resourceId)?resourceId:undefined,action,success:outcome!=='refused'&&outcome!=='uncertain',metadata:{outcome,...(Number.isInteger(status)?{status}:{}),contentIncluded:false}});}catch{/* The audit writer already records storage failures safely; preserve the mutation outcome. */}
}
