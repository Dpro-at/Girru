/** Inactive keyed topic index. Not an authorization source; verify token after decrypting any candidate. */
import {one,run,dialect,type Step} from '../../repositories/sql-steps.js';
import {normalizeDrawer,defaultDrawerForType,type DrawerRef} from '../drawers.js';
import {memoryTopicLookupToken} from './topic-lookup.js';
import {MemoryCipherError} from './envelope.js';
const TABLE='memory_encryption_topics';
export function* initializeEncryptedTopicIndexStep():Step<void>{
 yield* run(`CREATE TABLE IF NOT EXISTS ${TABLE} (owner_id TEXT NOT NULL,memory_id TEXT NOT NULL,drawer_kind TEXT NOT NULL,drawer_key TEXT NOT NULL,topic_token TEXT NOT NULL,PRIMARY KEY(owner_id,memory_id),UNIQUE(owner_id,drawer_kind,drawer_key,topic_token))`);
}
/** Caller already authorized/audited/decrypted this row. Run with its memory write in ONE transaction. */
export function* syncEncryptedTopicIndexStep(row:Readonly<Record<string,unknown>>,lookupKey:Buffer):Step<void>{
 const ownerId=row.user_id,id=row.id;
 if(typeof ownerId!=='string'||!ownerId||typeof id!=='string'||!id||id.length>256||typeof row.topic_key!=='string'&&row.topic_key!==null)throw new MemoryCipherError();
 const drawer=row.drawer_kind==null?defaultDrawerForType(typeof row.type==='string'?row.type:undefined):normalizeDrawer({kind:row.drawer_kind,key:row.drawer_key??''});
 const token=memoryTopicLookupToken(row.topic_key,lookupKey,ownerId,drawer);
 if(token===null||(row.status??'active')==='replaced'){yield* run(`DELETE FROM ${TABLE} WHERE owner_id=? AND memory_id=?`,ownerId,id);return;}
 yield* run(`INSERT INTO ${TABLE}(owner_id,memory_id,drawer_kind,drawer_key,topic_token) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,memory_id) DO UPDATE SET drawer_kind=excluded.drawer_kind,drawer_key=excluded.drawer_key,topic_token=excluded.topic_token`,ownerId,id,drawer.kind,drawer.key??'',token);
}
/** Returns an untrusted candidate id only; never return its content without authorization + token verification. */
export function* findEncryptedTopicCandidateStep(ownerId:string,drawer:DrawerRef,topic:string,lookupKey:Buffer):Step<string|null>{
 const normalized=normalizeDrawer(drawer),token=memoryTopicLookupToken(topic,lookupKey,ownerId,normalized);
 const bytes=(yield* dialect())==='sqlite'?'length(CAST(memory_id AS BLOB))':'octet_length(memory_id)';
 const row=yield* one<{memory_id:string|null}>(`SELECT CASE WHEN ${bytes}<=256 THEN memory_id ELSE NULL END AS memory_id FROM ${TABLE} WHERE owner_id=? AND drawer_kind=? AND drawer_key=? AND topic_token=?`,ownerId,normalized.kind,normalized.key??'',token);
 return row?.memory_id??null;
}
/** Verify an existing claim; content-only edits must never silently repair missing/corrupt claims. */
export function* verifyEncryptedTopicClaimStep(row:Readonly<Record<string,unknown>>,lookupKey:Buffer):Step<void>{
 if(typeof row.user_id!=='string'||typeof row.id!=='string'||typeof row.topic_key!=='string'&&row.topic_key!==null)throw new MemoryCipherError();
 const drawer=row.drawer_kind==null?defaultDrawerForType(typeof row.type==='string'?row.type:undefined):normalizeDrawer({kind:row.drawer_kind,key:row.drawer_key??''});
 const token=memoryTopicLookupToken(row.topic_key,lookupKey,row.user_id,drawer),expected=token!==null&&(row.status??'active')!=='replaced';
 const stored=yield* one<{drawer_kind:string;drawer_key:string;topic_token:string}>(`SELECT drawer_kind,drawer_key,topic_token FROM ${TABLE} WHERE owner_id=? AND memory_id=?`,row.user_id,row.id);
 if(expected?(!stored||stored.drawer_kind!==drawer.kind||stored.drawer_key!==(drawer.key??'')||stored.topic_token!==token):!!stored)throw new MemoryCipherError();
}
