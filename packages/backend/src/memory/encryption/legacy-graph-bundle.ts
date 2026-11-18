/** Pure, bounded preservation of the owner's legacy graph. No extraction, SQL or implicit authority. */
import {createHash} from 'node:crypto';
import {MemoryCipherError} from './envelope.js';

export const LEGACY_GRAPH_TABLES = ['memory_graph_entities','memory_graph_links','memory_graph_link_sources','memory_graph_mentions','memory_graph_state','memory_graph_cluster_dismissals'] as const;
export type LegacyGraphTable = typeof LEGACY_GRAPH_TABLES[number];
export type LegacyGraphRow = Record<string,string|null>;
export interface LegacyGraphMemory {id:string;user_id:string;content:string;status?:string|null;drawer_kind?:string|null;drawer_key?:string|null}
export interface LegacyGraphBundle {v:1;ownerId:string;rows:Record<LegacyGraphTable,LegacyGraphRow[]>}

const MAX_ROWS=5000,MAX_ENCODED_BYTES=8*1024*1024,MAX_STRING_BYTES=256*1024;
const MAX_MEMORY_CONTENT_BYTES=1024*1024,MAX_MEMORY_SET_BYTES=64*1024*1024;
const SHAPES:Record<LegacyGraphTable,readonly string[]>={
 memory_graph_entities:['id','user_id','kind','name','norm_name','aliases','created_at','updated_at'],
 memory_graph_links:['id','user_id','src_id','type','dst_id','status','created_at','decided_by','decided_at'],
 memory_graph_link_sources:['link_id','memory_id','user_id'],
 memory_graph_mentions:['memory_id','entity_id','user_id'],
 memory_graph_state:['memory_id','user_id','content_hash','method','processed_at'],
 memory_graph_cluster_dismissals:['user_id','cluster_id','drawer_id','dismissed_by','created_at'],
};
const KINDS=new Set(['person','project','place','topic','agent','task','decision']);
const LINK_TYPES=new Set(['works_on','prefers','decided','part_of','depends_on','replaces','contradicts']);
const LINK_STATUSES=new Set(['active','pending','rejected']);
const fail=():never=>{throw new MemoryCipherError();};
const hash=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');

/** Data properties only: unknown keys, accessors and nested row values never enter an authenticated bundle. */
function object(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return fail();
 const keys=Reflect.ownKeys(value),allowed=new Set([...required,...optional]);
 if(keys.length>allowed.size||keys.some(key=>typeof key!=='string'||!allowed.has(key)))return fail();
 const descriptors=Object.getOwnPropertyDescriptors(value);
 if(required.some(key=>!Object.hasOwn(descriptors,key))||keys.some(key=>!Object.hasOwn(descriptors[String(key)],'value')))return fail();
 return Object.fromEntries(keys.map(key=>[String(key),descriptors[String(key)].value]));
}
function array(value:unknown):unknown[]{
 if(!Array.isArray(value)||value.length>MAX_ROWS||Reflect.ownKeys(value).length!==value.length+1)return fail();
 const result:unknown[]=[];
 for(let i=0;i<value.length;i++){
  const descriptor=Object.getOwnPropertyDescriptor(value,String(i));
  if(!descriptor||!Object.hasOwn(descriptor,'value'))return fail();
  result.push(descriptor.value);
 }
 return result;
}
function text(value:unknown,max=MAX_STRING_BYTES):string{
 if(typeof value!=='string'||Buffer.byteLength(value,'utf8')>max)return fail();
 return value;
}
function id(value:unknown):string{
 const selected=text(value,256);
 if(!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(selected))return fail();
 return selected;
}
function timestamp(value:unknown):string{
 const selected=text(value,256);if(!selected)return fail();return selected;
}
function unique(rows:readonly LegacyGraphRow[],key:(row:LegacyGraphRow)=>unknown){
 const seen=new Set<string>();for(const row of rows){const value=JSON.stringify(key(row));if(typeof value!=='string'||seen.has(value))return fail();seen.add(value);}
}
function memoryMap(input:readonly LegacyGraphMemory[],ownerId:string):Map<string,LegacyGraphMemory>{
 const result=new Map<string,LegacyGraphMemory>();let bytes=0;
 for(const value of array(input)){
  const source=object(value,['id','user_id','content'],['status','drawer_kind','drawer_key']);
  const memory:LegacyGraphMemory={id:id(source.id),user_id:id(source.user_id),content:text(source.content,MAX_MEMORY_CONTENT_BYTES)};
  if(memory.user_id!==ownerId||result.has(memory.id))return fail();
  for(const field of ['status','drawer_kind','drawer_key'] as const){
   if(Object.hasOwn(source,field))memory[field]=source[field]===null?null:text(source[field],256);
  }
  bytes+=Buffer.byteLength(memory.content,'utf8');if(bytes>MAX_MEMORY_SET_BYTES)return fail();
  result.set(memory.id,memory);
 }
 return result;
}
function drawerOf(memory:LegacyGraphMemory):string|null{
 const kind=memory.drawer_kind,key=memory.drawer_key;
 // Without a resolved drawer, do not guess a legacy type-derived scope for a dismissal.
 if(kind===undefined||kind===null)return null;
 if(kind==='owner'||kind==='experience'){if(key!==undefined&&key!==null&&key!=='')return fail();return kind;}
 if(!['project','task','people'].includes(kind)||typeof key!=='string')return fail();
 if(kind==='project'?!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key):!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(key)||key.includes('..'))return fail();
 return kind+':'+key;
}
function dismissalDrawer(value:unknown):string{
 const selected=text(value,256),colon=selected.indexOf(':'),kind=colon<0?selected:selected.slice(0,colon),key=colon<0?'':selected.slice(colon+1);
 if(drawerOf({id:'scope',user_id:'scope',content:'',drawer_kind:kind,drawer_key:key})!==selected)return fail();
 return selected;
}
const live=(memory:LegacyGraphMemory)=>memory.status===undefined||memory.status===null||memory.status==='active';

/** Validate internal ownership/FKs without requiring hidden memories to be presented by a scoped reader. */
function bundleOf(input:unknown,memories?:ReadonlyMap<string,LegacyGraphMemory>):LegacyGraphBundle{
 const source=object(input,['v','ownerId','rows']);if(source.v!==1)return fail();
 const ownerId=id(source.ownerId),tables=object(source.rows,LEGACY_GRAPH_TABLES),rows={} as LegacyGraphBundle['rows'];
 let encodedBytes=Buffer.byteLength(JSON.stringify({v:1,ownerId,rows:Object.fromEntries(LEGACY_GRAPH_TABLES.map(table=>[table,[]]))}),'utf8');
 for(const table of LEGACY_GRAPH_TABLES){
  rows[table]=array(tables[table]).map((value,index)=>{
   const raw=object(value,SHAPES[table]),row:LegacyGraphRow={};
   for(const field of SHAPES[table]){
    if(raw[field]===null){if(table!=='memory_graph_links'||!['decided_by','decided_at'].includes(field))return fail();row[field]=null;}
    else row[field]=text(raw[field]);
   }
   if(row.user_id!==ownerId)return fail();
   for(const field of ['id','memory_id','entity_id','link_id','src_id','dst_id'])if(Object.hasOwn(row,field))id(row[field]);
   for(const field of ['created_at','updated_at','processed_at'])if(Object.hasOwn(row,field))timestamp(row[field]);
   if(row.decided_at!==undefined&&row.decided_at!==null)timestamp(row.decided_at);
   if(row.decided_by!==undefined&&row.decided_by!==null)text(row.decided_by,256);
   encodedBytes+=Buffer.byteLength(JSON.stringify(row),'utf8')+(index?1:0);if(encodedBytes>MAX_ENCODED_BYTES)return fail();
   return row;
  });
 }
 const entities=rows.memory_graph_entities,links=rows.memory_graph_links,mentions=rows.memory_graph_mentions,sources=rows.memory_graph_link_sources,state=rows.memory_graph_state,dismissals=rows.memory_graph_cluster_dismissals;
 unique(entities,row=>row.id);unique(entities,row=>row.norm_name);
 unique(links,row=>row.id);unique(links,row=>[row.src_id,row.type,row.dst_id]);
 unique(mentions,row=>[row.memory_id,row.entity_id]);unique(sources,row=>[row.link_id,row.memory_id]);unique(state,row=>row.memory_id);unique(dismissals,row=>row.cluster_id);
 const entityIds=new Set(entities.map(row=>row.id)),linkIds=new Set(links.map(row=>row.id));
 for(const row of entities){if(!KINDS.has(String(row.kind))||!row.name||!row.norm_name)return fail();}
 for(const row of links)if(!entityIds.has(row.src_id)||!entityIds.has(row.dst_id)||!LINK_TYPES.has(String(row.type))||!LINK_STATUSES.has(String(row.status)))return fail();
 for(const row of mentions)if(!entityIds.has(row.entity_id))return fail();
 for(const row of sources)if(!linkIds.has(row.link_id))return fail();
 for(const row of state)if(!/^[a-f0-9]{64}$/.test(String(row.content_hash))||!['model','fallback'].includes(String(row.method)))return fail();
 for(const row of dismissals){if(!/^[a-f0-9]{32}$/.test(String(row.cluster_id)))return fail();dismissalDrawer(row.drawer_id);text(row.dismissed_by,256);}
 if(memories)for(const row of [...mentions,...sources,...state])if(!memories.has(String(row.memory_id))||memories.get(String(row.memory_id))!.user_id!==ownerId)return fail();
 const supportedLinks=new Set(sources.map(row=>row.link_id)),supportedEntities=new Set([...mentions.map(row=>row.entity_id),...links.flatMap(row=>[row.src_id,row.dst_id])]);
 if(links.some(row=>!supportedLinks.has(row.id))||entities.some(row=>!supportedEntities.has(row.id)))return fail();
 const result:LegacyGraphBundle={v:1,ownerId,rows};
 if(Buffer.byteLength(JSON.stringify(result),'utf8')>MAX_ENCODED_BYTES)return fail();
 return result;
}

/** Preserve all six sets, including stale/rejected state; no IDs or extraction data are regenerated. */
export function captureLegacyGraphBundle(input:unknown,memories:readonly LegacyGraphMemory[]):LegacyGraphBundle{
 const source=object(input,['v','ownerId','rows']);const ownerId=id(source.ownerId);
 return bundleOf(source,memoryMap(memories,ownerId));
}

/** A projected bundle is an authorized view, never a replacement for the preserved full owner bundle. */
export function projectLegacyGraphBundle(input:LegacyGraphBundle,authorizedMemories:readonly LegacyGraphMemory[],options:{includeReviewStates?:boolean}={}):LegacyGraphBundle{
 const settings=object(options,[],['includeReviewStates']);
 if(settings.includeReviewStates!==undefined&&typeof settings.includeReviewStates!=='boolean')return fail();
 const bundle=bundleOf(input),memories=memoryMap(authorizedMemories,bundle.ownerId),state=new Map(bundle.rows.memory_graph_state.map(row=>[String(row.memory_id),row]));
 const current=new Set<string>(),drawers=new Set<string>();
 for(const memory of memories.values()){
  if(!live(memory))continue;
  const drawer=drawerOf(memory);if(drawer)drawers.add(drawer);
  if(state.get(memory.id)?.content_hash===hash(memory.content))current.add(memory.id);
 }
 const rows=bundle.rows;
 // Legacy names, aliases and decisions aggregate across memories without field-level provenance.
 // One readable source cannot authorize fields which another, hidden source may have contributed.
 const linkSupport=new Map<string,Set<string>>(),entitySupport=new Map<string,Set<string>>();
 const attach=(map:Map<string,Set<string>>,record:string,memory:string)=>{let set=map.get(record);if(!set){set=new Set();map.set(record,set);}set.add(memory);};
 for(const row of rows.memory_graph_link_sources)attach(linkSupport,String(row.link_id),String(row.memory_id));
 for(const row of rows.memory_graph_mentions)attach(entitySupport,String(row.entity_id),String(row.memory_id));
 for(const row of rows.memory_graph_links)for(const memory of linkSupport.get(String(row.id))??[])for(const endpoint of [row.src_id,row.dst_id])attach(entitySupport,String(endpoint),memory);
 const complete=(support:Set<string>|undefined)=>!!support?.size&&[...support].every(memory=>current.has(memory));
 const visibleEntities=new Set(rows.memory_graph_entities.filter(row=>complete(entitySupport.get(String(row.id)))).map(row=>row.id));
 rows.memory_graph_mentions=rows.memory_graph_mentions.filter(row=>current.has(String(row.memory_id))&&visibleEntities.has(row.entity_id));
 const statuses=settings.includeReviewStates===true?LINK_STATUSES:new Set(['active']);
 const allowedLinks=new Set(rows.memory_graph_links.filter(row=>statuses.has(String(row.status))&&complete(linkSupport.get(String(row.id)))&&visibleEntities.has(row.src_id)&&visibleEntities.has(row.dst_id)).map(row=>row.id));
 rows.memory_graph_link_sources=rows.memory_graph_link_sources.filter(row=>current.has(String(row.memory_id))&&allowedLinks.has(row.link_id));
 const supportedLinks=new Set(rows.memory_graph_link_sources.map(row=>row.link_id));
 rows.memory_graph_links=rows.memory_graph_links.filter(row=>supportedLinks.has(row.id));
 const entityIds=new Set([...rows.memory_graph_mentions.map(row=>row.entity_id),...rows.memory_graph_links.flatMap(row=>[row.src_id,row.dst_id])]);
 rows.memory_graph_entities=rows.memory_graph_entities.filter(row=>entityIds.has(row.id));
 rows.memory_graph_state=rows.memory_graph_state.filter(row=>current.has(String(row.memory_id)));
 rows.memory_graph_cluster_dismissals=rows.memory_graph_cluster_dismissals.filter(row=>drawers.has(String(row.drawer_id)));
 return bundleOf(bundle);
}

/** Detach one memory and prune only unsupported graph records, without mutating decision provenance. */
export function forgetLegacyGraphMemory(input:LegacyGraphBundle,memoryId:string):LegacyGraphBundle{
 const selected=id(memoryId),bundle=bundleOf(input),rows=bundle.rows;
 // Aggregate names and aliases have no field-level provenance. Removing only the
 // supporting edge would retain text learned from the forgotten memory.
 const affectedLinks=new Set(rows.memory_graph_link_sources.filter(row=>row.memory_id===selected).map(row=>row.link_id));
 const affectedEntities=new Set(rows.memory_graph_mentions.filter(row=>row.memory_id===selected).map(row=>row.entity_id));
 for(const row of rows.memory_graph_links)if(affectedLinks.has(row.id)){affectedEntities.add(row.src_id);affectedEntities.add(row.dst_id);}
 for(const row of rows.memory_graph_links)if(affectedEntities.has(row.src_id)||affectedEntities.has(row.dst_id))affectedLinks.add(row.id);
 rows.memory_graph_mentions=rows.memory_graph_mentions.filter(row=>row.memory_id!==selected&&!affectedEntities.has(row.entity_id));
 rows.memory_graph_link_sources=rows.memory_graph_link_sources.filter(row=>row.memory_id!==selected&&!affectedLinks.has(row.link_id));
 rows.memory_graph_state=rows.memory_graph_state.filter(row=>row.memory_id!==selected);
 const links=new Set(rows.memory_graph_link_sources.map(row=>row.link_id));
 rows.memory_graph_links=rows.memory_graph_links.filter(row=>!affectedLinks.has(row.id)&&links.has(row.id));
 const entities=new Set([...rows.memory_graph_mentions.map(row=>row.entity_id),...rows.memory_graph_links.flatMap(row=>[row.src_id,row.dst_id])]);
 rows.memory_graph_entities=rows.memory_graph_entities.filter(row=>!affectedEntities.has(row.id)&&entities.has(row.id));
 // Dismissal identifiers contain no names or aliases and do not create edges.
 return bundleOf(bundle);
}
