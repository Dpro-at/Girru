/** Owner-reviewed graph projections live inside authenticated encrypted memory metadata, never a plaintext graph index. */
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {fallbackExtraction} from '../graph/extract.js';
import {containsName,normalizeName,type GraphExtraction} from '../graph/types.js';
import {lexicalTokens} from '../text-normalize.js';
import {normalizeDrawer,defaultDrawerForType} from '../drawers.js';
import {memoryFromDecryptedRow} from '../row-memory.js';
import type {MemorySearchResult} from '../types.js';
import {MemoryCipherError} from './envelope.js';
const FIELD='__girru_reviewed_graph_v1',MAX_FRONTIER=25,MAX_HITS=50;
type Row=Record<string,unknown>;
type Projection={v:1;contentHash:string;extraction:GraphExtraction;mac:string};
function metadata(row:Row):Record<string,unknown>{
 if(row.metadata===null)return{};if(typeof row.metadata!=='string'||Buffer.byteLength(row.metadata)>1024*1024)throw new MemoryCipherError();
 const value=JSON.parse(row.metadata);if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>1000)throw new MemoryCipherError();return value;
}
function stamp(row:Row,value:Omit<Projection,'mac'>,key:Buffer){
 if(!Buffer.isBuffer(key)||key.length!==32||typeof row.id!=='string'||typeof row.user_id!=='string')throw new MemoryCipherError();
 return createHmac('sha256',key).update(JSON.stringify(['girru-reviewed-graph',1,row.user_id,row.id,value])).digest('hex');
}
const contentHash=(row:Row)=>{if(typeof row.content!=='string')throw new MemoryCipherError();return createHash('sha256').update(row.content).digest('hex');};
export function encryptedGraphReview(row:Row,key:Buffer){
 const drawer=row.drawer_kind==null?defaultDrawerForType(String(row.type)):normalizeDrawer({kind:row.drawer_kind,key:row.drawer_key??''});
 const raw=fallbackExtraction(String(row.content),drawer),entities=raw.entities.slice(0,12).map(entity=>({...entity,name:entity.name.slice(0,80),...(entity.aliases?{aliases:entity.aliases.slice(0,8).map(alias=>alias.slice(0,80))}:{})})),names=new Set(entities.map(entity=>entity.name));
 const extraction:GraphExtraction={...raw,entities,links:raw.links.filter(link=>names.has(link.from)&&names.has(link.to)).slice(0,12)};
 const reviewHash=createHmac('sha256',key).update('girru-graph-review-v1\0').update(JSON.stringify(row)).update('\0').update(JSON.stringify(extraction)).digest('hex');
 return{memoryId:String(row.id),reviewHash,entities:extraction.entities,links:extraction.links};
}
export function reviewedEncryptedGraphMetadata(row:Row,key:Buffer,reviewHash:string,decision:'approve'|'reject'){
 const preview=encryptedGraphReview(row,key);if(typeof reviewHash!=='string'||!/^[a-f0-9]{64}$/.test(reviewHash)||!timingSafeEqual(Buffer.from(preview.reviewHash,'hex'),Buffer.from(reviewHash,'hex'))||!['approve','reject'].includes(decision))throw new MemoryCipherError();
 const next={...metadata(row)};if(decision==='reject')delete next[FIELD];else{
  const value:Omit<Projection,'mac'>={v:1,contentHash:contentHash(row),extraction:{entities:preview.entities,links:preview.links,method:'fallback'}};
  next[FIELD]={...value,mac:stamp(row,value,key)};
 }
 return JSON.stringify(next);
}
function projection(row:Row,key:Buffer):GraphExtraction|null{
 const value=metadata(row)[FIELD] as Projection|undefined;if(value===undefined)return null;
 if(!value||Object.keys(value).sort().join(',')!=='contentHash,extraction,mac,v'||value.v!==1||typeof value.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(value.contentHash)||typeof value.mac!=='string'||!/^[a-f0-9]{64}$/.test(value.mac))throw new MemoryCipherError();
 const body={v:1 as const,contentHash:value.contentHash,extraction:value.extraction},expected=stamp(row,body,key);
 if(!timingSafeEqual(Buffer.from(value.mac,'hex'),Buffer.from(expected,'hex')))throw new MemoryCipherError();
 // Content edits invalidate their old approved projection; they never inherit relationships from old text.
 if(value.contentHash!==contentHash(row))return null;
 if(!value.extraction||value.extraction.method!=='fallback'||!Array.isArray(value.extraction.entities)||value.extraction.entities.length>12||!Array.isArray(value.extraction.links)||value.extraction.links.length>12)throw new MemoryCipherError();
 return value.extraction;
}
/** Only rows already authorized/audited by the caller participate, including every hop's supporting memory. */
export function recallReviewedEncryptedGraph(rows:readonly Row[],key:Buffer,query:string,limit=10):MemorySearchResult[]{
 if(typeof query!=='string'||Buffer.byteLength(query)>4096||!Number.isInteger(limit)||limit<1||limit>MAX_HITS||rows.length>5000)throw new MemoryCipherError();
 const tokens=lexicalTokens(query),weights=new Map<string,number>(),mentions=new Map<string,Set<string>>(),edges:Array<[string,string]>=[],byId=new Map<string,Row>();
 for(const row of rows){
  if(row.status!=='active'||typeof row.content!=='string'||row.expiry_timestamp!=null&&Number(row.expiry_timestamp)<=Date.now())continue;
  const graph=projection(row,key);if(!graph)continue;byId.set(String(row.id),row);
  for(const entity of graph.entities){const id=normalizeName(entity.name);if(!id)continue;let attached=mentions.get(id);if(!attached){attached=new Set();mentions.set(id,attached);}attached.add(String(row.id));
   if(containsName(tokens,id)||(entity.aliases??[]).some(alias=>containsName(tokens,normalizeName(alias))))weights.set(id,1);
  }
  for(const link of graph.links)edges.push([normalizeName(link.from),normalizeName(link.to)]);
 }
 let frontier=[...weights.keys()].sort().slice(0,MAX_FRONTIER);const scopedWeights=new Map(frontier.map(id=>[id,1]));
 for(const weight of [0.6,0.35]){const next=new Set<string>(),previous=new Set(frontier);
  for(const [from,to] of edges){for(const id of [previous.has(from)?to:null,previous.has(to)?from:null]){if(!id||scopedWeights.has(id)||next.size>=MAX_FRONTIER)continue;next.add(id);scopedWeights.set(id,weight);}}
  frontier=[...next];
 }
 const scores=new Map<string,number>();for(const [entity,weight] of scopedWeights)for(const id of mentions.get(entity)??[])scores.set(id,Math.max(scores.get(id)??0,0.45*weight));
 return [...scores].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,limit).map(([id,similarity])=>({memory:memoryFromDecryptedRow(byId.get(id)!),similarity}));
}
