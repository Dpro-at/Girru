/** Recall from a current, authorized, active-only lossless graph projection. */
import type {LegacyGraphBundle} from './legacy-graph-bundle.js';
import {containsName,normalizeName} from '../graph/types.js';
import {lexicalTokens} from '../text-normalize.js';
import {memoryFromDecryptedRow} from '../row-memory.js';
import type {MemorySearchResult} from '../types.js';
import {MemoryCipherError} from './envelope.js';
export function recallLegacyGraph(bundle:LegacyGraphBundle,memories:readonly Record<string,unknown>[],query:string,limit=10):MemorySearchResult[]{
 if(typeof query!=='string'||Buffer.byteLength(query)>4096||!Number.isInteger(limit)||limit<1||limit>50)throw new MemoryCipherError();const tokens=lexicalTokens(query),rows=bundle.rows,byId=new Map(memories.filter(row=>row.status==='active'&&(row.expiry_timestamp==null||Number(row.expiry_timestamp)>Date.now())).map(row=>[String(row.id),row])),weights=new Map<string,number>();
 for(const entity of rows.memory_graph_entities){let aliases:string[]=[];try{const raw=JSON.parse(String(entity.aliases));if(Array.isArray(raw))aliases=raw.filter(value=>typeof value==='string');}catch{/* Invalid legacy aliases stay preserved without recall expansion. */}if(containsName(tokens,normalizeName(String(entity.name)))||aliases.some(alias=>containsName(tokens,normalizeName(alias))))weights.set(String(entity.id),1);}
 let frontier=[...weights.keys()].sort().slice(0,25);const scoped=new Map(frontier.map(id=>[id,1]));for(const weight of [0.6,0.35]){const previous=new Set(frontier),next=new Set<string>();for(const link of rows.memory_graph_links){if(link.status!=='active')continue;for(const id of [previous.has(String(link.src_id))?String(link.dst_id):null,previous.has(String(link.dst_id))?String(link.src_id):null]){if(!id||scoped.has(id)||next.size>=25)continue;next.add(id);scoped.set(id,weight);}}frontier=[...next];}
 const scores=new Map<string,number>();for(const mention of rows.memory_graph_mentions){const id=String(mention.memory_id),weight=scoped.get(String(mention.entity_id));if(weight!==undefined&&byId.has(id))scores.set(id,Math.max(scores.get(id)??0,0.45*weight));}
 return[...scores].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,limit).map(([id,similarity])=>({memory:memoryFromDecryptedRow(byId.get(id)!),similarity}));
}
