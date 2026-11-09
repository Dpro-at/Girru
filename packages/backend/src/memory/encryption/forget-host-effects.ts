/** Explicit-profile host effects. Construction does not open an app or discover a profile. */
import {realpath,readdir,lstat} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {one,run,tableExists,type StepRunner} from '../../repositories/sql-steps.js';
import {recordMemoryForget,readLedger,textMac,LEDGER_FILE} from '../forget-ledger.js';
import {dropContextCache} from '../context/cache.js';
import {clearEmbeddingCache} from '../embedding.js';
import {forgetRecallIndex} from '../recall-index.js';
import {createEncryptedForgetFileCleaner} from './forget-files.js';
import type {ForgetCleanupEffects} from './forget-cleanup.js';
import {drawerFileName,isValidAgentId} from '../memory-files.js';
import {normalizeDrawer} from '../drawers.js';
import {MemoryCipherError} from './envelope.js';
export function createEncryptedForgetHostEffects(options:{profileRoot:string;memoryRoot:string;exportFiles:readonly string[];indexRunner:StepRunner|null}):ForgetCleanupEffects{
 const profile=resolve(options.profileRoot),memory=resolve(options.memoryRoot),index=options.indexRunner,clean=createEncryptedForgetFileCleaner(memory,[...options.exportFiles]);
 const assertProfile=async()=>{const selected=await realpath(profile),selectedMemory=await realpath(memory),rel=relative(selected,selectedMemory);if(selected!==profile||selectedMemory!==memory||!rel||rel.startsWith('..')||isAbsolute(rel))throw new MemoryCipherError();};
 return{
  ledger:async plan=>{await assertProfile();recordMemoryForget(plan.ownerId,plan.memoryId,plan.texts,profile);const lines=readLedger(resolve(profile,LEDGER_FILE)).filter(l=>l.userId===plan.ownerId&&l.memoryId===plan.memoryId&&l.kind==='memory');if(!plan.texts.length)return lines.length>0;return plan.texts.every(text=>{const mac=textMac(text,false,profile);return !!mac&&lines.some(l=>l.mac===mac);});},
  files:async plan=>{await assertProfile();
   const agentsRoot=resolve(profile,'agents');let agents:string[]=[];
   try{const rootInfo=await lstat(agentsRoot);if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory())throw new MemoryCipherError();agents=await readdir(agentsRoot);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   if(agents.length>1000)throw new MemoryCipherError();
   const file=drawerFileName(normalizeDrawer(plan.drawer)),copies:string[]=[];
   for(const name of agents){if(typeof name!=='string'||!isValidAgentId(name)||name==='public')continue;const entry=await lstat(resolve(agentsRoot,name));if(entry.isSymbolicLink())throw new MemoryCipherError();if(entry.isDirectory())copies.push(['agents',name,'memory',plan.ownerId,file].join('/'));}
   // The existing agents/<agent>/memory/<owner>/<drawer>.md namespace is derived from current source.
   if(copies.length)await createEncryptedForgetFileCleaner(profile,copies)({...plan,types:[]});
   return clean(plan);
  },
  caches:async plan=>{await assertProfile();dropContextCache(plan.ownerId);clearEmbeddingCache();forgetRecallIndex(plan.ownerId);return true;},
  index:async plan=>{await assertProfile();if(!index)return true;await index.tx(function*(){
   const queries:[string,string,unknown[]][]=[['memory_chunks','DELETE FROM memory_chunks WHERE memory_id=?',[plan.memoryId]],['memory_fts','DELETE FROM memory_fts WHERE memory_id=?',[plan.memoryId]],['memory_relations','DELETE FROM memory_relations WHERE source_id=? OR target_id=?',[plan.memoryId,plan.memoryId]],['memory_index','DELETE FROM memory_index WHERE memory_id=?',[plan.memoryId]]];
   for(const [table,query,params] of queries)if(yield* tableExists(table)){yield* run(query,...params as string[]);const predicate=table==='memory_relations'?'source_id=? OR target_id=?':'memory_id=?';const remaining=yield* one<{n:number|string}>(`SELECT count(*) n FROM ${table} WHERE ${predicate}`,...params as string[]);if(!remaining||Number(remaining.n)!==0)throw new MemoryCipherError();}
  },{immediate:true});return true;}
 };
}
