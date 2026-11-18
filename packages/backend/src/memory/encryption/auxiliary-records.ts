/** Lossless owner auxiliary transport. Ordered authenticated parts stay below the common row-envelope limit. */
import {createHash} from 'node:crypto';
import {all,one,run,dialect,tableColumns,type Step,type SqlParam} from '../../repositories/sql-steps.js';
import {encryptMemoryRow,decryptMemoryRow,type MemoryRowScope} from './row-codec.js';
import {captureOwnerAuxiliaryBundle,type OwnerAuxiliaryBundle,type AuxiliaryParents} from './auxiliary-bundle.js';
import {canonicalEncryptedRow} from './content-commit.js';
import {MemoryCipherError} from './envelope.js';
export const AUXILIARY_RECORD_TABLE='memory_encryption_auxiliary';
// Ciphertext plus double base64 transport must remain within the declared8MiB source-table bound.
export const MAX_STORED_OWNER_AUXILIARY_BYTES=4*1024*1024;
const PART_BYTES=384*1024,MAX_BYTES=MAX_STORED_OWNER_AUXILIARY_BYTES,MAX_PARTS=Math.ceil(MAX_BYTES/PART_BYTES),FIELDS=['id','owner_id','bundle_id','ordinal','parts','sha256','format','created_at','payload'];
type Row=Record<string,unknown>;
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
export function* ensureAuxiliaryRecordSchemaStep():Step<void>{yield* run(`CREATE TABLE IF NOT EXISTS ${AUXILIARY_RECORD_TABLE}(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,bundle_id TEXT NOT NULL,ordinal INTEGER NOT NULL,parts INTEGER NOT NULL,sha256 TEXT NOT NULL,format TEXT NOT NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(owner_id,ordinal))`);}
export function prepareAuxiliaryPlainRecords(bundle:OwnerAuxiliaryBundle,parents:AuxiliaryParents,scope:MemoryRowScope,at:string):Row[]{
 const captured=captureOwnerAuxiliaryBundle(bundle,parents);if(captured.ownerId!==scope.ownerId||typeof at!=='string'||!Number.isFinite(Date.parse(at)))throw new MemoryCipherError();
 const bytes=Buffer.from(JSON.stringify(captured));try{if(bytes.length>MAX_BYTES)throw new MemoryCipherError();const digest=hash(bytes),parts=Math.max(1,Math.ceil(bytes.length/PART_BYTES)),bundleId=hash(JSON.stringify(['girru-owner-auxiliary',captured.v,scope.ownerId,digest]));
 return Array.from({length:parts},(_,ordinal)=>({id:hash(bundleId+'\n'+ordinal),owner_id:scope.ownerId,bundle_id:bundleId,ordinal,parts,sha256:digest,format:'owner-auxiliary-bundle-v'+captured.v,created_at:at,payload:bytes.subarray(ordinal*PART_BYTES,(ordinal+1)*PART_BYTES).toString('base64')}));
 }finally{bytes.fill(0);}
}
export function prepareAuxiliaryRecords(bundle:OwnerAuxiliaryBundle,parents:AuxiliaryParents,scope:MemoryRowScope,key:Buffer,keyId:string,at:string):Row[]{return prepareAuxiliaryPlainRecords(bundle,parents,scope,at).map(row=>encryptMemoryRow(AUXILIARY_RECORD_TABLE,row,scope,key,keyId));}
export function openAuxiliaryRecords(rows:readonly Row[],parents:AuxiliaryParents,scope:MemoryRowScope,key:Buffer,keyId:string):OwnerAuxiliaryBundle|null{
 if(!Array.isArray(rows)||rows.length>MAX_PARTS)throw new MemoryCipherError();if(!rows.length)return null;
 const plain=rows.map(row=>decryptMemoryRow(AUXILIARY_RECORD_TABLE,row,scope,key,keyId)).sort((a,b)=>Number(a.ordinal)-Number(b.ordinal)),first=plain[0],buffers:Buffer[]=[];
 try{if(!Number.isInteger(first.parts)||first.parts!==plain.length||typeof first.sha256!=='string'||!/^[a-f0-9]{64}$/.test(first.sha256))throw new MemoryCipherError();let total=0;
 for(let ordinal=0;ordinal<plain.length;ordinal++){const row=plain[ordinal];if(row.ordinal!==ordinal||row.parts!==first.parts||row.bundle_id!==first.bundle_id||row.sha256!==first.sha256||row.created_at!==first.created_at||!['owner-auxiliary-bundle-v1','owner-auxiliary-bundle-v2'].includes(String(row.format))||row.format!==first.format||row.id!==hash(String(first.bundle_id)+'\n'+ordinal)||typeof row.payload!=='string'||row.payload.length>Math.ceil(PART_BYTES/3)*4)throw new MemoryCipherError();const bytes=Buffer.from(row.payload,'base64');buffers.push(bytes);total+=bytes.length;if(bytes.toString('base64')!==row.payload||bytes.length>PART_BYTES||ordinal<plain.length-1&&bytes.length!==PART_BYTES||total>MAX_BYTES)throw new MemoryCipherError();}
 const bytes=Buffer.concat(buffers);buffers.push(bytes);if(hash(bytes)!==first.sha256||first.bundle_id!==hash(JSON.stringify(['girru-owner-auxiliary',first.format==='owner-auxiliary-bundle-v2'?2:1,scope.ownerId,first.sha256])))throw new MemoryCipherError();const text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes))throw new MemoryCipherError();const captured=captureOwnerAuxiliaryBundle(JSON.parse(text),parents);if(first.format!=='owner-auxiliary-bundle-v'+captured.v)throw new MemoryCipherError();return captured;
 }finally{for(const buffer of buffers)buffer.fill(0);}
}
export function* loadAuxiliaryRecordsStep(ownerId:string):Step<Row[]>{
 const driver=yield* dialect();if(driver==='postgres')yield* run(`LOCK TABLE ${AUXILIARY_RECORD_TABLE} IN SHARE MODE`);const columns=driver==='sqlite'?(yield* all<{name:string}>('SELECT name FROM pragma_table_xinfo(?)',AUXILIARY_RECORD_TABLE)).map(row=>row.name):yield* tableColumns(AUXILIARY_RECORD_TABLE);if(columns.sort().join(',')!==[...FIELDS].sort().join(','))throw new MemoryCipherError();
 const size=yield* one<{n:number|string;b:number|string|null}>(`SELECT count(*) n,SUM(${driver==='sqlite'?'length(CAST(payload AS BLOB))':'octet_length(payload)'}) b FROM ${AUXILIARY_RECORD_TABLE} WHERE owner_id=?`,ownerId);if(!size||!Number.isSafeInteger(Number(size.n))||Number(size.n)<0||Number(size.n)>MAX_PARTS||!Number.isSafeInteger(Number(size.b??0))||Number(size.b??0)<0||Number(size.b??0)>16*1024*1024)throw new MemoryCipherError();const rows=yield* all<Row>(`SELECT * FROM ${AUXILIARY_RECORD_TABLE} WHERE owner_id=? ORDER BY ordinal`,ownerId);if(rows.length!==Number(size.n))throw new MemoryCipherError();return rows;
}
/** Compare-and-replace the full bundle within the caller's owner/authority transaction. */
export function* replaceAuxiliaryRecordsStep(ownerId:string,before:readonly Row[],after:readonly Row[]):Step<void>{
 if((yield* dialect())==='postgres')yield* run(`LOCK TABLE ${AUXILIARY_RECORD_TABLE} IN SHARE ROW EXCLUSIVE MODE`);const current=yield* loadAuxiliaryRecordsStep(ownerId),orderedBefore=[...before].sort((a,b)=>Number(a.ordinal)-Number(b.ordinal)),orderedAfter=[...after].sort((a,b)=>Number(a.ordinal)-Number(b.ordinal));if(current.length!==orderedBefore.length||current.some((row,index)=>canonicalEncryptedRow(row)!==canonicalEncryptedRow(orderedBefore[index])))throw new MemoryCipherError();yield* run(`DELETE FROM ${AUXILIARY_RECORD_TABLE} WHERE owner_id=?`,ownerId);
 for(const row of after){if(row.owner_id!==ownerId||Object.keys(row).sort().join(',')!==[...FIELDS].sort().join(','))throw new MemoryCipherError();yield* run(`INSERT INTO ${AUXILIARY_RECORD_TABLE}(${FIELDS.join(',')}) VALUES(${FIELDS.map(()=>'?').join(',')})`,...FIELDS.map(field=>row[field] as SqlParam));}
 const stored=yield* loadAuxiliaryRecordsStep(ownerId);if(stored.length!==orderedAfter.length||stored.some((row,index)=>canonicalEncryptedRow(row)!==canonicalEncryptedRow(orderedAfter[index])))throw new MemoryCipherError();
}
