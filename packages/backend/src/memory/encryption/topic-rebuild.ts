/** Bounded copied-data derived index rebuild; caller authenticates/audits source decrypts. */
import {MEMORY_COPY_MAX_ROWS,MEMORY_COPY_READ_LIMIT} from './copy-limits.js';
import {all,one,run,dialect,type Step} from '../../repositories/sql-steps.js';
import {decryptMemoryRow,type MemoryRowScope} from './row-codec.js';
import {normalizeDrawer,defaultDrawerForType} from '../drawers.js';
import {memoryTopicLookupToken} from './topic-lookup.js';
import {initializeEncryptedTopicIndexStep} from './topic-index.js';
import {MemoryCipherError} from './envelope.js';
const TABLE='memory_encryption_topics';
export function prepareEncryptedTopicRebuild(rows:Record<string,unknown>[],scope:MemoryRowScope,key:Buffer,keyId:string,lookupKey:Buffer){
 if(!Buffer.isBuffer(key)||key.length!==32||!Buffer.isBuffer(lookupKey)||lookupKey.length!==32||!Array.isArray(rows)||rows.length>MEMORY_COPY_MAX_ROWS)throw new MemoryCipherError();
 const claims:Array<Record<string,string>>=[],ids=new Set<string>();
 for(const cipher of rows){
  const row=decryptMemoryRow('memories',cipher,scope,key,keyId);
  if(typeof row.id!=='string'||ids.has(row.id)||typeof row.topic_key!=='string'&&row.topic_key!==null)throw new MemoryCipherError();ids.add(row.id);
  const drawer=row.drawer_kind==null?defaultDrawerForType(typeof row.type==='string'?row.type:undefined):normalizeDrawer({kind:row.drawer_kind,key:row.drawer_key??''});
  const token=memoryTopicLookupToken(row.topic_key,lookupKey,scope.ownerId,drawer);
  if(token!==null&&(row.status??'active')!=='replaced')claims.push({owner_id:scope.ownerId,memory_id:row.id,drawer_kind:drawer.kind,drawer_key:drawer.key??'',topic_token:token});
 }
 const canonical=(items:Record<string,unknown>[])=>JSON.stringify(items.map(r=>[r.owner_id,r.memory_id,r.drawer_kind,r.drawer_key,r.topic_token]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
 const expected=canonical(claims);
 const verify=function*():Step<void>{const stored=yield* all<Record<string,unknown>>(`SELECT owner_id,memory_id,drawer_kind,drawer_key,topic_token FROM ${TABLE} LIMIT ${MEMORY_COPY_READ_LIMIT}`);if(canonical(stored)!==expected)throw new MemoryCipherError();};
 return {
  build:function*():Step<void>{
   yield* initializeEncryptedTopicIndexStep();if((yield* dialect())==='postgres')yield* run(`LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE`);
   if(yield* one(`SELECT 1 AS occupied FROM ${TABLE} LIMIT 1`))throw new MemoryCipherError();
   for(const r of claims)yield* run(`INSERT INTO ${TABLE}(owner_id,memory_id,drawer_kind,drawer_key,topic_token) VALUES(?,?,?,?,?)`,r.owner_id,r.memory_id,r.drawer_kind,r.drawer_key,r.topic_token);
   yield* verify();
  },verify,
 };
}
