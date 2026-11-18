import {observeEncryptedRunFieldProducer} from './run-admission.js';
/** Bounded audited bulk reads for existing storage consumers; no owner-wide plaintext fallback. */
import {all,dialect,run as sqlRun,type StepRunner} from '../../repositories/sql-steps.js';
import {captureAuthenticatedMemoryRun,authenticatedMemoryRunStep} from './auth-capture.js';
import {createMemoryRevisionValidator} from './revision-validator.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {loadEncryptedMemoryCandidates} from './candidate-loader.js';
import {decryptMemoryRow,encryptedFieldProducer} from './row-codec.js';
import {canonicalEncryptedRow} from './content-commit.js';
import type {MemoryReadIntent} from './read-audit.js';
import {MemoryCipherError} from './envelope.js';
type Input={runner:StepRunner;token:string;session:ReturnType<typeof createMemoryUnlockSession>;run:Parameters<typeof captureAuthenticatedMemoryRun>[2];ids?:readonly string[];recordRead:(intent:MemoryReadIntent)=>Promise<boolean>};
export const listAuthenticatedEncryptedRunMemories=(input:Input)=>projectAuthenticatedEncryptedRunMemories(input,rows=>rows);
/** Synchronous projections are computed before the final source/permission CAS; no key or SQL handle escapes. */
export async function projectAuthenticatedEncryptedRunMemories<T>(input:Input,project:(rows:Record<string,unknown>[])=>T):Promise<T>{
 const {runner,token,session,recordRead}=input;let key:Buffer|undefined;
 try{
  const ids=input.ids?[...input.ids]:undefined;if(ids&&(ids.length>5000||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(id))))throw new MemoryCipherError();
  const run={...input.run,delegatedFrom:[...input.run.delegatedFrom],drawers:input.run.drawers.map(drawer=>({...drawer}))},lease=session.capture(),auth=await captureAuthenticatedMemoryRun(runner,token,run);
  if(auth.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();
  const validate=createMemoryRevisionValidator(runner,auth.revision,session.lock),check=async()=>{if(runner.inTransaction?.()!==false||process.env.AGENT_PLAYER_READONLY==='1'||!lease.isCurrent()||await validate()!==true||!lease.isCurrent())throw new MemoryCipherError();};await check();
  const requested=ids?new Set(ids):null,candidates=await loadEncryptedMemoryCandidates(runner,auth.ownerId);await check();const selected=candidates.filter(row=>(!requested||requested.has(String(row.id)))&&auth.access.authorize(row));
  if(!selected.length)return project([]);const expected=new Map(selected.map(row=>[String(row.id),canonicalEncryptedRow(row)]));
  for(let offset=0;offset<selected.length;offset+=500){await check();if(await recordRead({readerKind:'agent',readerId:run.agentId,purpose:'tool',records:selected.slice(offset,offset+500).map(row=>({table:'memories',id:String(row.id)}))})!==true)throw new MemoryCipherError();await check();}
  const material=await lease.resolveKey({user_id:auth.ownerId});key=material.key;await check();const result:Record<string,unknown>[]=[];let bytes=0;
  for(const [index,candidate] of selected.entries()){
   if(!lease.isCurrent())throw new MemoryCipherError();if(index%64===0)await check();const row=decryptMemoryRow('memories',candidate,lease.scope,key,material.id);if(!auth.access.authorize(row))throw new MemoryCipherError();
   bytes+=Object.values(row).reduce<number>((n,value)=>n+(typeof value==='string'?Buffer.byteLength(value):Buffer.isBuffer(value)?value.length:16),0);if(bytes>8*1024*1024)throw new MemoryCipherError();observeEncryptedRunFieldProducer(encryptedFieldProducer('memories',row,'content',lease.scope),{kind:'memory',id:String(row.id)});result.push(row);
  }
  const projected=project(result);await check();await runner.tx(function*(){const fresh=yield* authenticatedMemoryRunStep(token,run);if(JSON.stringify(fresh.revision)!==JSON.stringify(auth.revision)||!lease.isCurrent())throw new MemoryCipherError();if((yield* dialect())==='postgres')yield* sqlRun('LOCK TABLE memories IN SHARE MODE');
   const identities=[...expected.keys()];for(let offset=0;offset<identities.length;offset+=500){const batch=identities.slice(offset,offset+500),rows=yield* all<Record<string,unknown>>(`SELECT * FROM memories WHERE user_id=? AND id IN (${batch.map(()=>'?').join(',')})`,auth.ownerId,...batch);if(rows.length!==batch.length||rows.some(row=>!fresh.access.authorize(row)||canonicalEncryptedRow(row)!==expected.get(String(row.id))))throw new MemoryCipherError();}
   if(!lease.isCurrent()||Date.now()>=auth.revision.validUntil)throw new MemoryCipherError();
  },{immediate:true});await check();return projected;
 }catch{throw new MemoryCipherError();}finally{key?.fill(0);}
}
