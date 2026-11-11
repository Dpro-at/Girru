import {memoryControlQuery} from './control-runner.js';
/** Internal permission-checked planning only; no file access, cleanup or coverage-gate bypass. */
import path from 'node:path';
import {all,one,tableExists,type Step,type StepRunner} from '../../repositories/sql-steps.js';
import {keyStateStep} from '../project-keys.js';
import {MemoryCipherError} from './envelope.js';
import {assertExternalCopyReferencesCurrentStep,assertExternalProjectionHoldsCurrentStep,type ExternalCopyReference,type ExternalProjectionHold} from './external-copy-manifest.js';
export type AuthorizedExternalReference={reference:ExternalCopyReference;scope:string;root:string;hold:ExternalProjectionHold};
export type ExternalRootPermissionRequest={purpose:'encrypted-forget-plan';ownerId:string;scope:string;root:string;reference:ExternalCopyReference};
function* bindingsStep(ownerId:string,references:readonly ExternalCopyReference[],holds:readonly ExternalProjectionHold[]):Step<AuthorizedExternalReference[]>{
 yield* assertExternalCopyReferencesCurrentStep(ownerId,references);
 const result:AuthorizedExternalReference[]=[],used=new Set<string>();
 for(const reference of references){
  const {scope,root}=yield* externalReferenceLocationStep(ownerId,reference);
  const hold=holds.find(h=>h.scope===scope);if(!hold)throw new MemoryCipherError();
  used.add(scope);result.push({reference:{...reference},scope,root,hold:{...hold}});
 }
 if(used.size!==holds.length)throw new MemoryCipherError();
 if(holds.length)yield* assertExternalProjectionHoldsCurrentStep(ownerId,holds);
 else if(references.length)throw new MemoryCipherError();
 return result;
}
/** ownerId must be server-authenticated. Host permission callback is mandatory and uncached.
 * Discovery scan consent is not cleanup consent; host must authorize this explicit purpose.
 * Returned plan is not a capability: effects must revalidate it and permissions at use time. */
export async function prepareAuthorizedExternalReferencePlan(input:{runner:StepRunner;ownerId:string;references:readonly ExternalCopyReference[];holds:readonly ExternalProjectionHold[];authorizeRoot:(request:ExternalRootPermissionRequest)=>Promise<boolean>}):Promise<AuthorizedExternalReference[]>{
 const {runner,ownerId,authorizeRoot}=input;
 if(typeof authorizeRoot!=='function'||runner.inTransaction?.()!==false)throw new MemoryCipherError();
 const references=structuredClone(input.references),holds=structuredClone(input.holds);
 const capture=()=>runner.tx(()=>bindingsStep(ownerId,references,holds),{immediate:true});
 const first=await capture();
 for(const item of first)if(await authorizeRoot({purpose:'encrypted-forget-plan',ownerId,scope:item.scope,root:item.root,reference:{...item.reference}})!==true)throw new MemoryCipherError();
 const current=await capture();if(JSON.stringify(first)!==JSON.stringify(current))throw new MemoryCipherError();
 for(const item of current)if(await authorizeRoot({purpose:'encrypted-forget-plan',ownerId,scope:item.scope,root:item.root,reference:{...item.reference}})!==true)throw new MemoryCipherError();
 const final=await capture();if(JSON.stringify(current)!==JSON.stringify(final))throw new MemoryCipherError();
 return final;
}

/** Current metadata association only; grants no filesystem access and does not certify historical coverage. */
export function* externalReferenceLocationStep(ownerId:string,reference:ExternalCopyReference):Step<{scope:string;root:string}>{
  let scope:string;
  if(reference.kind==='projection-file')scope=reference.scope;
  else{
   const chats=(yield* memoryControlQuery(()=>tableExists('chat_projects')))?yield* memoryControlQuery(()=>all<{id:string;slug:string}>('SELECT id,slug FROM chat_projects WHERE user_id=? AND (id=? OR slug=?) LIMIT 2',ownerId,reference.scope,reference.scope)):[];
   if(chats.length>1)throw new MemoryCipherError();
   if(chats.length)scope='project:'+((yield* keyStateStep(ownerId))==='id'?chats[0]!.id:chats[0]!.slug);
   else{
    let key=reference.scope;
    if((yield* keyStateStep(ownerId))==='id'&&(yield* tableExists('memory_project_keys'))){
     const rows=yield* all<{project_id:string}>('SELECT project_id FROM memory_project_keys WHERE owner_id=? AND slug=? LIMIT 2',ownerId,key);
     if(rows.length>1)throw new MemoryCipherError();if(rows.length)key=rows[0]!.project_id;
    }
    scope='project:'+key;
   }
  }
  const ownership=yield* one<{owner_id:string}>('SELECT owner_id FROM change_scopes WHERE scope=?',scope);
  if(!ownership||ownership.owner_id!==ownerId)throw new MemoryCipherError();
  if(!path.isAbsolute(reference.path)||path.resolve(reference.path)!==reference.path)throw new MemoryCipherError();
  let root=reference.path;
  if(reference.kind==='projection-file'){
   if(path.basename(reference.path)!=='brief.md'||path.basename(path.dirname(reference.path))!=='.girru')throw new MemoryCipherError();
   root=path.dirname(path.dirname(reference.path));
  }
  if(root===path.parse(root).root)throw new MemoryCipherError();
  return{scope,root};
}
