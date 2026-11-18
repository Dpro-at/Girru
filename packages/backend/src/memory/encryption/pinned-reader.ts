import {readMemoryControlStep} from './control-runner.js';
import {observeEncryptedRunFieldProducer} from './run-admission.js';
/** Existing pinned-fact prompt contract on selected encrypted rows, under live run scope and read audit. */
import {all,one,type StepRunner} from '../../repositories/sql-steps.js';
import {captureAuthenticatedMemoryRun,authenticatedMemoryRunStep as importAuthStep} from './auth-capture.js';
import {createMemoryRevisionValidator} from './revision-validator.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {loadEncryptedOwnerRow} from './owner-row-loader.js';
import {decryptMemoryRow,encryptedFieldProducer} from './row-codec.js';
import {canonicalEncryptedRow} from './content-commit.js';
import {projectStep,departmentStep,GENERAL_DEPARTMENT,GENERAL_NAME} from '../scopes/store.js';
import {renderScopedPinnedFacts,pinnedScopeId,MAX_FACT_CHARS,MAX_FACTS_PER_SCOPE,type PinnedFact,type PinnedScope} from '../scopes/pinned.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
export async function readAuthenticatedEncryptedPinnedFacts(input:{runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;run:Parameters<typeof captureAuthenticatedMemoryRun>[2];recordRead:(intent:MemoryReadIntent)=>Promise<boolean>;reader?:{kind:'coding-app';id:string};callerLease?:{isCurrent:()=>boolean;validateCurrent:()=>Promise<boolean>};allow?:{company?:boolean;department?:boolean;project?:boolean}}){
 const allow=input.allow?{...input.allow}:undefined;const {runner,token,session,recordRead}=input;const reader=input.reader?{...input.reader}:undefined,caller=input.callerLease?{isCurrent:input.callerLease.isCurrent.bind(input.callerLease),validateCurrent:input.callerLease.validateCurrent.bind(input.callerLease)}:undefined;let key:Buffer|undefined;
 try{
  if(reader&&(!caller||reader.kind!=='coding-app'||typeof reader.id!=='string'||!reader.id||reader.id.length>128))throw new MemoryCipherError();
  if(caller&&(!caller.isCurrent()||await caller.validateCurrent()!==true||!caller.isCurrent()))throw new MemoryCipherError();
  const run={...input.run,delegatedFrom:[...input.run.delegatedFrom],drawers:input.run.drawers.map(drawer=>({...drawer}))},lease=session.capture(),auth=await captureAuthenticatedMemoryRun(runner,token,run);
  if(auth.ownerId!==lease.scope.ownerId||run.audience!=='owner')throw new MemoryCipherError();const pinnedFlags={company:auth.access.pinnedFacts.company&&allow?.company!==false,department:auth.access.pinnedFacts.department&&allow?.department!==false,project:auth.access.pinnedFacts.project&&allow?.project!==false};const validate=createMemoryRevisionValidator(runner,auth.revision,session.lock);
  const check=async()=>{if(caller&&(!caller.isCurrent()||await caller.validateCurrent()!==true||!caller.isCurrent()))throw new MemoryCipherError();if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1'||!lease.isCurrent()||await validate()!==true||!lease.isCurrent())throw new MemoryCipherError();};await check();
  async function selection(){const scopes:Array<{scope:PinnedScope;title:string}>=[];
   if(pinnedFlags.company)scopes.push({scope:{kind:'company',id:''},title:'Company'});
   if(pinnedFlags.project&&run.project){const project=await readMemoryControlStep(runner,projectStep(auth.ownerId,run.project));await check();if(project&&!project.archived){const department=await readMemoryControlStep(runner,departmentStep(auth.ownerId,project.departmentId));await check();if(pinnedFlags.department)scopes.push({scope:{kind:'department',id:department?.id??GENERAL_DEPARTMENT},title:`Department "${department?.name??GENERAL_NAME}"`});scopes.push({scope:{kind:'project',id:project.slug},title:`Project "${project.name}"`});}}
   const groups=[];for(const group of scopes){const ids=await runner.read(all<{id:string}>('SELECT id FROM memory_pinned_facts WHERE owner_id=? AND scope_kind=? AND scope_id=? ORDER BY position,created_at,id LIMIT ?',auth.ownerId,group.scope.kind,group.scope.id,MAX_FACTS_PER_SCOPE+1));await check();if(ids.length>MAX_FACTS_PER_SCOPE||ids.some(row=>typeof row.id!=='string'||row.id.length>256))throw new MemoryCipherError();groups.push({...group,ids:ids.map(row=>row.id)});}return groups;
  }
  const groups=await selection(),source=new Map<string,Record<string,unknown>>();let bytes=0;
  for(const group of groups)for(const id of group.ids){const row=await loadEncryptedOwnerRow(runner,'memory_pinned_facts',auth.ownerId,id);await check();if(!row||row.scope_kind!==group.scope.kind||row.scope_id!==group.scope.id)throw new MemoryCipherError();bytes+=Buffer.byteLength(canonicalEncryptedRow(row));if(bytes>1024*1024)throw new MemoryCipherError();source.set(id,row);}
  if(!source.size)return{text:'',facts:[]};if(await recordRead({readerKind:reader?.kind??'agent',readerId:reader?.id??run.agentId,purpose:'recall',records:[...source.keys()].map(id=>({table:'memory_pinned_facts',id}))})!==true)throw new MemoryCipherError();await check();
  const material=await lease.resolveKey({user_id:auth.ownerId});key=material.key;await check();const facts=new Map<string,PinnedFact>();
  for(const [id,row] of source){const plain=decryptMemoryRow('memory_pinned_facts',row,lease.scope,key,material.id);if(typeof plain.text!=='string'||plain.text.length>MAX_FACT_CHARS)throw new MemoryCipherError();observeEncryptedRunFieldProducer(encryptedFieldProducer('memory_pinned_facts',plain,'text',lease.scope),{kind:'auxiliary',id});facts.set(id,{id,scope:pinnedScopeId({kind:plain.scope_kind as PinnedScope['kind'],id:String(plain.scope_id)}),text:plain.text,position:Number(plain.position),createdBy:plain.created_by as string|null,createdAt:String(plain.created_at),updatedAt:String(plain.updated_at)});}
  if(JSON.stringify(await selection())!==JSON.stringify(groups))throw new MemoryCipherError();
  for(const [id,row] of source){const current=await loadEncryptedOwnerRow(runner,'memory_pinned_facts',auth.ownerId,id);await check();if(!current||canonicalEncryptedRow(current)!==canonicalEncryptedRow(row))throw new MemoryCipherError();}
  await runner.tx(function*(){const fresh=yield* importAuthStep(token,run);if(JSON.stringify(fresh.revision)!==JSON.stringify(auth.revision)||!lease.isCurrent()||caller&&!caller.isCurrent())throw new MemoryCipherError();
   for(const [id,row] of source){const current=yield* one<Record<string,unknown>>('SELECT * FROM memory_pinned_facts WHERE id=? AND owner_id=?',id,auth.ownerId);if(!current||canonicalEncryptedRow(current)!==canonicalEncryptedRow(row))throw new MemoryCipherError();}
  },{immediate:true});
  const group=(kind:PinnedScope['kind'])=>{const selected=groups.find(group=>group.scope.kind===kind);return selected?{title:selected.title,facts:selected.ids.map(id=>facts.get(id)!)}:null;};await check();return renderScopedPinnedFacts(group('company')?.facts??[],group('department'),group('project'));
 }catch{session.lock();throw new MemoryCipherError();}finally{key?.fill(0);}
}
