// Pure synthetic fixtures. Execution is deferred until the complete encryption source task is ready.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {captureLegacyGraphBundle,projectLegacyGraphBundle,forgetLegacyGraphMemory,LEGACY_GRAPH_TABLES} from '../src/memory/encryption/legacy-graph-bundle.ts';

const hash=text=>createHash('sha256').update(text,'utf8').digest('hex');
function fixture(){
 const ownerId='owner-synthetic',at='2026-11-08 00:00:00';
 const memories=[
  {id:'memory-1',user_id:ownerId,content:'Synthetic project relationship.',status:'active',drawer_kind:'project',drawer_key:'alpha'},
  {id:'memory-2',user_id:ownerId,content:'Synthetic owner relationship.',status:'active',drawer_kind:'owner',drawer_key:''},
  {id:'memory-3',user_id:ownerId,content:'Synthetic trashed relationship.',status:'trashed',drawer_kind:'people',drawer_key:'person-3'},
 ];
 const entity=(id,name)=>({id,user_id:ownerId,kind:'topic',name,norm_name:name.toLowerCase(),aliases:'[ "spelling retained" ]',created_at:at,updated_at:at});
 const link=(id,from,to,status)=>({id,user_id:ownerId,src_id:from,type:'depends_on',dst_id:to,status,created_at:at,decided_by:status==='pending'?null:'reviewer-synthetic',decided_at:status==='pending'?null:at});
 const bundle={v:1,ownerId,rows:{
  memory_graph_entities:[entity('entity-1','First'),entity('entity-2','Second'),entity('entity-3','Third'),entity('entity-4','Fourth')],
  memory_graph_links:[link('link-active','entity-1','entity-2','active'),link('link-pending','entity-2','entity-3','pending'),link('link-rejected','entity-3','entity-1','rejected')],
  memory_graph_link_sources:[{link_id:'link-active',memory_id:'memory-1',user_id:ownerId},{link_id:'link-active',memory_id:'memory-2',user_id:ownerId},{link_id:'link-pending',memory_id:'memory-2',user_id:ownerId},{link_id:'link-rejected',memory_id:'memory-1',user_id:ownerId}],
  memory_graph_mentions:[{memory_id:'memory-1',entity_id:'entity-1',user_id:ownerId},{memory_id:'memory-1',entity_id:'entity-2',user_id:ownerId},{memory_id:'memory-2',entity_id:'entity-2',user_id:ownerId},{memory_id:'memory-2',entity_id:'entity-3',user_id:ownerId},{memory_id:'memory-3',entity_id:'entity-4',user_id:ownerId}],
  memory_graph_state:memories.map((memory,index)=>({memory_id:memory.id,user_id:ownerId,content_hash:hash(memory.content),method:index===1?'model':'fallback',processed_at:at})),
  memory_graph_cluster_dismissals:[{user_id:ownerId,cluster_id:'a'.repeat(32),drawer_id:'project:alpha',dismissed_by:'topic:synthetic',created_at:at},{user_id:ownerId,cluster_id:'b'.repeat(32),drawer_id:'owner',dismissed_by:'reviewer-synthetic',created_at:at},{user_id:ownerId,cluster_id:'c'.repeat(32),drawer_id:'people:person-3',dismissed_by:'reviewer-synthetic',created_at:at}],
 }};
 return{ownerId,memories,bundle};
}

test('legacy graph capture preserves exact identities, decisions, raw aliases, method and timestamps in owned data',()=>{
 const {bundle,memories}=fixture(),captured=captureLegacyGraphBundle(bundle,memories);
 assert.deepEqual(captured,bundle);assert.notEqual(captured,bundle);
 for(const table of LEGACY_GRAPH_TABLES){assert.notEqual(captured.rows[table],bundle.rows[table]);for(let i=0;i<captured.rows[table].length;i++)assert.notEqual(captured.rows[table][i],bundle.rows[table][i]);}
 bundle.rows.memory_graph_entities[0].name='Changed after capture';assert.equal(captured.rows.memory_graph_entities[0].name,'First');
 assert.equal(captured.rows.memory_graph_entities[0].aliases,'[ "spelling retained" ]');
 assert.equal(captured.rows.memory_graph_links[2].status,'rejected');assert.equal(captured.rows.memory_graph_state[1].method,'model');
});

test('legacy graph capture refuses unknown shapes, accessors, owners, orphan references and uniqueness violations',()=>{
 const cases=[
  b=>{b.extra=true;},b=>{b.rows.extra=[];},b=>{b.rows.memory_graph_entities[0].extra='unknown';},
  b=>{b.rows.memory_graph_entities[0].user_id='other-owner';},b=>{b.rows.memory_graph_link_sources[0].user_id='other-owner';},
  b=>{b.rows.memory_graph_links[0].src_id='missing-entity';},b=>{b.rows.memory_graph_link_sources[0].link_id='missing-link';},
  b=>{b.rows.memory_graph_mentions[0].memory_id='missing-memory';},b=>{b.rows.memory_graph_state[0].memory_id='missing-memory';},
  b=>{b.rows.memory_graph_links[0].status='approved';},b=>{b.rows.memory_graph_state[0].method='unknown';},
  b=>{b.rows.memory_graph_entities.push({...b.rows.memory_graph_entities[0]});},
  b=>{b.rows.memory_graph_entities[1].norm_name=b.rows.memory_graph_entities[0].norm_name;},
  b=>{b.rows.memory_graph_links.push({...b.rows.memory_graph_links[0],id:'different-id'});},
  b=>{b.rows.memory_graph_link_sources.push({...b.rows.memory_graph_link_sources[0]});},
  b=>{b.rows.memory_graph_mentions.push({...b.rows.memory_graph_mentions[0]});},
  b=>{b.rows.memory_graph_state.push({...b.rows.memory_graph_state[0]});},
  b=>{b.rows.memory_graph_cluster_dismissals.push({...b.rows.memory_graph_cluster_dismissals[0]});},
  b=>{b.rows.memory_graph_link_sources=b.rows.memory_graph_link_sources.filter(row=>row.link_id!=='link-active');},
  b=>{b.rows.memory_graph_entities.push({...b.rows.memory_graph_entities[0],id:'orphan-entity',norm_name:'unreferenced'});},
 ];
 for(const change of cases){const {bundle,memories}=fixture();change(bundle);assert.throws(()=>captureLegacyGraphBundle(bundle,memories));}
 const {bundle,memories}=fixture();let accessed=false;Object.defineProperty(bundle.rows.memory_graph_entities[0],'name',{get(){accessed=true;return'bad';},enumerable:true});
 assert.throws(()=>captureLegacyGraphBundle(bundle,memories));assert.equal(accessed,false);
 const other=fixture();other.memories[0].user_id='other-owner';assert.throws(()=>captureLegacyGraphBundle(other.bundle,other.memories));
});

test('graph capture refuses row, string and aggregate byte overflow without truncating a set',()=>{
 const largeRows=fixture();largeRows.bundle.rows.memory_graph_state=Array.from({length:5001},(_,i)=>({...largeRows.bundle.rows.memory_graph_state[0],memory_id:'m-'+i}));
 assert.throws(()=>captureLegacyGraphBundle(largeRows.bundle,largeRows.memories));
 const largeString=fixture();largeString.bundle.rows.memory_graph_entities[0].aliases='x'.repeat(256*1024+1);assert.throws(()=>captureLegacyGraphBundle(largeString.bundle,largeString.memories));
 const aggregate=fixture();for(let i=0;i<40;i++){
  aggregate.bundle.rows.memory_graph_entities.push({...aggregate.bundle.rows.memory_graph_entities[0],id:'large-'+i,name:'Large '+i,norm_name:'large '+i,aliases:JSON.stringify(['x'.repeat(220*1024)])});
  aggregate.bundle.rows.memory_graph_mentions.push({memory_id:'memory-1',entity_id:'large-'+i,user_id:aggregate.ownerId});
 }
 assert.throws(()=>captureLegacyGraphBundle(aggregate.bundle,aggregate.memories));
 const nested=fixture();nested.bundle.rows.memory_graph_entities[0].aliases={nested:{not:'text'}};assert.throws(()=>captureLegacyGraphBundle(nested.bundle,nested.memories));
});

test('scoped graph projection uses only live current-content support and active links by default',()=>{
 const {bundle,memories}=fixture(),captured=captureLegacyGraphBundle(bundle,memories),before=JSON.stringify(captured);
 const selected=projectLegacyGraphBundle(captured,[memories[1]]);
 assert.deepEqual(selected.rows.memory_graph_links,[]);
 assert.deepEqual(selected.rows.memory_graph_link_sources,[]);
 assert.deepEqual(selected.rows.memory_graph_mentions,[]);
 assert.deepEqual(selected.rows.memory_graph_entities,[]);
 assert.deepEqual(selected.rows.memory_graph_state.map(row=>row.memory_id),['memory-2']);
 assert.deepEqual(selected.rows.memory_graph_cluster_dismissals.map(row=>row.drawer_id),['owner']);
 assert.equal(JSON.stringify(captured),before);
 const stale=projectLegacyGraphBundle(captured,[{...memories[0],content:'Current edited content.'}]);
 assert.equal(stale.rows.memory_graph_links.length,0);assert.equal(stale.rows.memory_graph_mentions.length,0);assert.equal(stale.rows.memory_graph_state.length,0);
 assert.equal(captured.rows.memory_graph_state[0].content_hash,hash(memories[0].content));
 const trashed=projectLegacyGraphBundle(captured,[memories[2]],{includeReviewStates:true});
 assert.equal(trashed.rows.memory_graph_entities.length,0);assert.equal(trashed.rows.memory_graph_cluster_dismissals.length,0);
});

test('review projection retains pending/rejected provenance only with visible current source support',()=>{
 const {bundle,memories}=fixture(),captured=captureLegacyGraphBundle(bundle,memories);
 const review=projectLegacyGraphBundle(captured,memories,{includeReviewStates:true});
 assert.deepEqual(review.rows.memory_graph_links.map(row=>row.status),['active','pending','rejected']);
 assert.deepEqual(review.rows.memory_graph_links[2],captured.rows.memory_graph_links[2]);
 const ownerOnly=projectLegacyGraphBundle(captured,[memories[1]],{includeReviewStates:true});
 assert.deepEqual(ownerOnly.rows.memory_graph_links,[]);
 assert.equal(captured.rows.memory_graph_links[2].status,'rejected');
 const missingState=structuredClone(captured);missingState.rows.memory_graph_state=[];
 const inactive=projectLegacyGraphBundle(missingState,memories,{includeReviewStates:true});assert.equal(inactive.rows.memory_graph_links.length,0);
 assert.throws(()=>projectLegacyGraphBundle(captured,[{...memories[0],user_id:'other-owner'}]));
 assert.throws(()=>projectLegacyGraphBundle(captured,memories,{includeReviewStates:'yes'}));
});

test('forget removes unproven aggregate fields and incident decisions while preserving unrelated identities',()=>{
 const {bundle,memories}=fixture(),captured=captureLegacyGraphBundle(bundle,memories),before=JSON.stringify(captured);
 const next=forgetLegacyGraphMemory(captured,'memory-1');
 assert.equal(JSON.stringify(captured),before);
 assert.ok(next.rows.memory_graph_mentions.every(row=>row.memory_id!=='memory-1'));
 assert.ok(next.rows.memory_graph_link_sources.every(row=>row.memory_id!=='memory-1'));
 assert.ok(next.rows.memory_graph_state.every(row=>row.memory_id!=='memory-1'));
 assert.deepEqual(next.rows.memory_graph_links,[]);
 assert.deepEqual(next.rows.memory_graph_entities.map(row=>row.id),['entity-4']);
 assert.equal(JSON.stringify(next).includes('spelling retained'),true); // Unrelated entity remains intact.
 assert.deepEqual(next.rows.memory_graph_cluster_dismissals,captured.rows.memory_graph_cluster_dismissals);
 const sharedRejection=structuredClone(captured);sharedRejection.rows.memory_graph_link_sources.push({link_id:'link-rejected',memory_id:'memory-2',user_id:captured.ownerId});
 const retainedRejection=forgetLegacyGraphMemory(sharedRejection,'memory-1').rows.memory_graph_links.find(row=>row.id==='link-rejected');
 assert.equal(retainedRejection,undefined); // A shared edge cannot retain aggregate fields from a forgotten source.
 const after=forgetLegacyGraphMemory(next,'memory-2');
 assert.equal(after.rows.memory_graph_links.length,0);
 assert.deepEqual(after.rows.memory_graph_entities.map(row=>row.id),['entity-4']);
 assert.deepEqual(after.rows.memory_graph_mentions.map(row=>row.memory_id),['memory-3']);
 assert.deepEqual(forgetLegacyGraphMemory(captured,'absent-memory'),captured);
 assert.throws(()=>forgetLegacyGraphMemory(captured,'bad\u0000id'));
});

test('cross-drawer aggregate names, aliases and decision provenance require every original support',()=>{
 const {bundle,memories}=fixture();bundle.rows.memory_graph_entities[0].name='SYNTHETIC_PRIVATE_CANONICAL';bundle.rows.memory_graph_entities[0].norm_name='synthetic private canonical';bundle.rows.memory_graph_entities[0].aliases='["SYNTHETIC_PRIVATE_ALIAS"]';
 bundle.rows.memory_graph_links[0].decided_by='SYNTHETIC_PRIVATE_REVIEWER';
 const captured=captureLegacyGraphBundle(bundle,memories),before=JSON.stringify(captured);
 for(const selected of [[memories[0]],[memories[1]],[memories[0],{...memories[1],content:'Edited since graph extraction.'}]]){
  const scoped=projectLegacyGraphBundle(captured,selected,{includeReviewStates:true}),text=JSON.stringify(scoped);
  for(const secret of ['SYNTHETIC_PRIVATE_CANONICAL','synthetic private canonical','SYNTHETIC_PRIVATE_ALIAS','SYNTHETIC_PRIVATE_REVIEWER'])assert.equal(text.includes(secret),false);
  assert.equal(scoped.rows.memory_graph_links.length,0);
 }
 const full=projectLegacyGraphBundle(captured,[memories[0],memories[1]],{includeReviewStates:true});
 assert.equal(full.rows.memory_graph_entities.find(row=>row.id==='entity-1').aliases,'["SYNTHETIC_PRIVATE_ALIAS"]');
 assert.equal(full.rows.memory_graph_links.find(row=>row.id==='link-active').decided_by,'SYNTHETIC_PRIVATE_REVIEWER');
 assert.equal(JSON.stringify(captured),before);
});
