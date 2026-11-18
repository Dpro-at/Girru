// Deferred synthetic source fixtures. Do not execute before the entire encryption task is source-complete.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {sqliteStepsOn} from '../src/repositories/sql-steps.ts';
import {generateToken,verifyToken} from '../src/auth/jwt.ts';
import {authSessionTokenHash} from '../src/auth/sessions.ts';
import {memoryRowSurfaceManifest,encryptMemoryRow} from '../src/memory/encryption/row-codec.ts';
import {createMemoryUnlockSession} from '../src/memory/encryption/unlock-session.ts';
import {ensureLegacyGraphRecordSchemaStep,prepareLegacyGraphRecords,LEGACY_GRAPH_RECORD_TABLE} from '../src/memory/encryption/legacy-graph-records.ts';
import {projectAuthenticatedLegacyGraph} from '../src/memory/encryption/legacy-graph-gateway.ts';
import {MemoryCipherError} from '../src/memory/encryption/envelope.ts';

const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
 if(!process.env.JWT_SECRET)process.env.JWT_SECRET=randomBytes(64).toString('hex');
 const db=new Database(':memory:');t.after(()=>db.close());
 const runner=sqliteStepsOn(db),scope={ownerId:'synthetic-graph-owner',memberId:'synthetic-graph-member'},key=randomBytes(32),keyId='synthetic-graph-key';
 db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,status TEXT,token_version INTEGER);
 CREATE TABLE auth_sessions(id TEXT PRIMARY KEY,user_id TEXT,token_hash TEXT,token_version INTEGER,expires_at INTEGER,revoked_at INTEGER);
 CREATE TABLE agents_config(id TEXT PRIMARY KEY);
 CREATE TABLE agent_permissions(agent_id TEXT PRIMARY KEY,memory_read TEXT,memory_write TEXT,shared_memory INTEGER,modes TEXT,version INTEGER);
 CREATE TABLE memory_access_versions(owner_id TEXT PRIMARY KEY,version INTEGER);
 CREATE TABLE memory_access_rules(id TEXT,owner_id TEXT,scope_kind TEXT,scope_id TEXT,agent_id TEXT,drawer_kind TEXT,read_mode TEXT,write_mode TEXT,ends_at TEXT,reason TEXT,created_by TEXT,created_at TEXT);
 CREATE TABLE memory_access_scope_rules(id TEXT,owner_id TEXT,scope_kind TEXT,scope_id TEXT,agent_id TEXT,drawer_kind TEXT,read_mode TEXT,write_mode TEXT,ends_at TEXT,reason TEXT,created_by TEXT,created_at TEXT);
 CREATE TABLE memory_role_templates(id TEXT,owner_id TEXT,name TEXT,norm_name TEXT,memory_read TEXT,memory_write TEXT,scope_read TEXT,scope_write TEXT);
 CREATE TABLE memory_agent_roles(owner_id TEXT,agent_id TEXT,template_id TEXT);
 CREATE TABLE memory_project_scopes(owner_id TEXT,slug TEXT,department_id TEXT,archived_at TEXT);CREATE TABLE memory_project_kinds(owner_id TEXT,slug TEXT,kind TEXT);`);
 db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(scope.ownerId,'owner','active',1);
 db.prepare('INSERT INTO agents_config VALUES(?)').run('synthetic-graph-agent');
 db.prepare('INSERT INTO agent_permissions VALUES(?,?,?,?,?,?)').run('synthetic-graph-agent','["project"]','[]',0,'{}',1);
 const token=generateToken(scope.ownerId,1,'5m'),decoded=verifyToken(token);
 db.prepare('INSERT INTO auth_sessions VALUES(?,?,?,?,?,NULL)').run('synthetic-graph-session',scope.ownerId,authSessionTokenHash(decoded.jti),1,decoded.exp*1000);
 const surface=memoryRowSurfaceManifest().find(item=>item.table==='memories'),fields=[surface.owner,surface.id,...surface.bound,...surface.clear,...surface.text,...surface.binary];
 db.exec('CREATE TABLE memories('+fields.map(field=>field+(field===surface.id?' TEXT PRIMARY KEY':surface.binary.includes(field)?' BLOB':'')).join(',')+')');
 await runner.tx(ensureLegacyGraphRecordSchemaStep);
 const memory=(id,drawer,content)=>({...Object.fromEntries(fields.map(field=>[field,null])),id,user_id:scope.ownerId,type:'fact',content,metadata:null,status:'active',created_at:'2026-11-09 00:00:00',drawer_kind:'project',drawer_key:drawer,importance_score:0.5,last_accessed_at:0,access_count:0});
 const plain=[memory('graph-visible','allowed','SYNTHETIC_VISIBLE_MEMORY'),memory('graph-hidden','denied','SYNTHETIC_HIDDEN_MEMORY')];
 const cipher=plain.map(row=>encryptMemoryRow('memories',row,scope,key,keyId));
 const putMemory=row=>db.prepare('INSERT OR REPLACE INTO memories('+fields.join(',')+') VALUES('+fields.map(()=>'?').join(',')+')').run(...fields.map(field=>row[field]));
 for(const row of cipher)putMemory(row);
 // A successful authorized read must not try to open this hidden content envelope.
 db.prepare('UPDATE memories SET content=? WHERE id=?').run('not-an-authenticated-envelope','graph-hidden');
 const at='2026-11-09 00:00:00',entity=(id,name)=>({id,user_id:scope.ownerId,kind:'topic',name,norm_name:name.toLowerCase(),aliases:'[]',created_at:at,updated_at:at});
 const link=(id,type,status)=>({id,user_id:scope.ownerId,src_id:'entity-a',type,dst_id:'entity-b',status,created_at:at,decided_by:status==='pending'?null:'synthetic-reviewer',decided_at:status==='pending'?null:at});
 const bundle={v:1,ownerId:scope.ownerId,rows:{
  memory_graph_entities:[entity('entity-a','Visible first'),entity('entity-b','Visible second'),entity('entity-hidden','SYNTHETIC_HIDDEN_ENTITY'),{...entity('entity-shared','SYNTHETIC_HIDDEN_CANONICAL'),aliases:'["SYNTHETIC_HIDDEN_ALIAS"]'}],
  memory_graph_links:[link('link-active','depends_on','active'),link('link-pending','prefers','pending'),link('link-rejected','contradicts','rejected')],
  memory_graph_link_sources:['link-active','link-pending','link-rejected'].map(link_id=>({link_id,memory_id:'graph-visible',user_id:scope.ownerId})),
  memory_graph_mentions:[{memory_id:'graph-visible',entity_id:'entity-a',user_id:scope.ownerId},{memory_id:'graph-visible',entity_id:'entity-b',user_id:scope.ownerId},{memory_id:'graph-hidden',entity_id:'entity-hidden',user_id:scope.ownerId},{memory_id:'graph-visible',entity_id:'entity-shared',user_id:scope.ownerId},{memory_id:'graph-hidden',entity_id:'entity-shared',user_id:scope.ownerId}],
  memory_graph_state:plain.map(row=>({memory_id:row.id,user_id:scope.ownerId,content_hash:hash(row.content),method:'model',processed_at:at})),
  memory_graph_cluster_dismissals:[],
 }};
 const minimal=plain.map(row=>({id:row.id,user_id:row.user_id,content:row.content,status:row.status,drawer_kind:row.drawer_kind,drawer_key:row.drawer_key}));
 const graph=prepareLegacyGraphRecords(bundle,minimal,scope,key,keyId,'2026-11-09T00:00:00.000Z');
 for(const row of graph){const fields=Object.keys(row);db.prepare('INSERT INTO '+LEGACY_GRAPH_RECORD_TABLE+'('+fields.join(',')+') VALUES('+fields.map(()=>'?').join(',')+')').run(...fields.map(field=>row[field]));}
 let authorityCurrent=true,rootCurrent=true;
 const anchor={v:1,authorityId:'synthetic-graph-authority',...scope,keyId,epoch:1,forgetSequence:0,forgetMac:'0'.repeat(64)};
 let graphRoot={...anchor,bundleId:graph[0].bundle_id,sha256:graph[0].sha256,parts:graph.length,generation:1};
 const session=createMemoryUnlockSession();session.unlock(key,keyId,scope);t.after(()=>{session.lock();key.fill(0);});
 const audit=[],opened=[],capture=session.capture;
 session.capture=()=>{const lease=capture();return{...lease,async resolveKey(row){const material=await lease.resolveKey(row);opened.push(material.key);return material;}};};
 const input={runner,token,session,run:{agentId:'synthetic-graph-agent',delegatedFrom:[],project:'allowed',drawers:[{kind:'project',key:'allowed'}],audience:'owner'},recordRead:async intent=>{audit.push(structuredClone(intent));return true;},captureAuthority:async()=>({anchor:{...anchor},isCurrent:()=>authorityCurrent}),captureGraphRoot:async()=>({anchor:{...graphRoot},isCurrent:()=>rootCurrent})};
 return{db,runner,scope,key,keyId,plain,cipher,putMemory,graph,bundle,input,audit,opened,anchor,getRoot:()=>graphRoot,setRoot:value=>{graphRoot=value;},revokeAuthority:()=>{authorityCurrent=false;},revokeRoot:()=>{rootCurrent=false;}};
}

test('audited graph gateway opens only authorized memories and hides cross-drawer aggregates',async t=>{
 const f=await fixture(t);const result=await projectAuthenticatedLegacyGraph(f.input,(bundle,memories)=>({bundle,memories:memories.map(row=>({id:row.id,content:row.content}))}));
 assert.deepEqual(result.memories,[{id:'graph-visible',content:'SYNTHETIC_VISIBLE_MEMORY'}]);
 assert.deepEqual(result.bundle.rows.memory_graph_entities.map(row=>row.id),['entity-a','entity-b']);
 assert.deepEqual(result.bundle.rows.memory_graph_links.map(row=>row.status),['active']);
 assert.equal(JSON.stringify(result).includes('SYNTHETIC_HIDDEN'),false);
 const records=f.audit.flatMap(intent=>intent.records);
 assert.deepEqual(records.filter(row=>row.table==='memories').map(row=>row.id),['graph-visible']);
 assert.deepEqual(records.filter(row=>row.table===LEGACY_GRAPH_RECORD_TABLE).map(row=>row.id),f.graph.map(row=>row.id));
 assert.ok(f.opened.length>0);assert.ok(f.opened.every(buffer=>buffer.every(byte=>byte===0)));
 const review=await projectAuthenticatedLegacyGraph({...f.input,includeReviewStates:true},bundle=>bundle.rows.memory_graph_links.map(row=>row.status));
 assert.deepEqual(review,['active','pending','rejected']);
});

test('failed read audit or authority revocation cannot reach a projector or retain an operation key',async t=>{
 for(const failure of ['audit','authority','root']){
  const f=await fixture(t);let projected=false;
  f.input.recordRead=async intent=>{f.audit.push(intent);if(failure==='authority')f.revokeAuthority();if(failure==='root')f.revokeRoot();return failure!=='audit';};
  await assert.rejects(projectAuthenticatedLegacyGraph(f.input,()=>{projected=true;}),MemoryCipherError);
  assert.equal(projected,false);assert.equal(f.opened.length,0);assert.equal(f.input.session.isUnlocked(),false);
 }
});

test('same-transaction read-set CAS refuses source ciphertext and hidden identity changes after projection',async t=>{
 for(const changed of ['memory','graph','identity']){
  const f=await fixture(t);let projected=false;
  await assert.rejects(projectAuthenticatedLegacyGraph(f.input,bundle=>{
   projected=true;
   if(changed==='memory')f.putMemory(encryptMemoryRow('memories',{...f.plain[0],content:'Valid replacement ciphertext.'},f.scope,f.key,f.keyId));
   else if(changed==='graph')f.db.prepare('UPDATE '+LEGACY_GRAPH_RECORD_TABLE+' SET payload=? WHERE id=?').run(f.graph[0].payload+'changed',f.graph[0].id);
   else f.db.prepare('UPDATE memories SET drawer_key=? WHERE id=?').run('different-hidden-drawer','graph-hidden');
   return bundle.rows.memory_graph_entities;
  }),MemoryCipherError);
  assert.equal(projected,true);assert.equal(f.input.session.isUnlocked(),false);assert.ok(f.opened.every(buffer=>buffer.every(byte=>byte===0)));
 }
});

test('run permission revocation and fresh forget/key/root-head changes refuse an already projected result',async t=>{
 for(const changed of ['permission','forget','key','root']){
  const f=await fixture(t);
  await assert.rejects(projectAuthenticatedLegacyGraph(f.input,bundle=>{
   if(changed==='permission')f.db.prepare('UPDATE agent_permissions SET memory_read=?,version=2 WHERE agent_id=?').run('[]','synthetic-graph-agent');
   else if(changed==='forget')f.anchor.forgetSequence++;
   else if(changed==='key')f.anchor.keyId='replacement-key';
   else f.setRoot({...f.getRoot(),generation:f.getRoot().generation+1});
   return bundle.rows.memory_graph_links;
  }),MemoryCipherError);
  assert.equal(f.input.session.isUnlocked(),false);assert.ok(f.opened.every(buffer=>buffer.every(byte=>byte===0)));
 }
});

test('a missing protected graph root or deletion of every authenticated part never becomes an empty graph',async t=>{
 const absent=await fixture(t);await assert.rejects(projectAuthenticatedLegacyGraph({...absent.input,captureGraphRoot:async()=>null},()=>assert.fail()),MemoryCipherError);
 const deleted=await fixture(t);deleted.db.exec('DELETE FROM '+LEGACY_GRAPH_RECORD_TABLE);
 await assert.rejects(projectAuthenticatedLegacyGraph(deleted.input,()=>assert.fail()),MemoryCipherError);assert.equal(deleted.opened.length,0);
 const empty=await fixture(t);empty.db.exec('DELETE FROM '+LEGACY_GRAPH_RECORD_TABLE);empty.setRoot({...empty.getRoot(),bundleId:null,sha256:null,parts:0,generation:2});
 assert.deepEqual(await projectAuthenticatedLegacyGraph(empty.input,bundle=>bundle.rows.memory_graph_entities),[]);
});

test('stale supporting text remains preserved but cannot activate a migrated edge; async projectors refuse',async t=>{
 const stale=await fixture(t);stale.putMemory(encryptMemoryRow('memories',{...stale.plain[0],content:'Edited after extraction.'},stale.scope,stale.key,stale.keyId));
 assert.deepEqual(await projectAuthenticatedLegacyGraph(stale.input,bundle=>bundle.rows.memory_graph_links),[]);
 const asyncProjection=await fixture(t);await assert.rejects(projectAuthenticatedLegacyGraph(asyncProjection.input,async bundle=>bundle.rows.memory_graph_links),MemoryCipherError);
});

test('expired, future-invalid and superseded supporting memories never activate graph records',async t=>{
 for(const patch of [{expiry_timestamp:Date.now()-1},{valid_from:new Date(Date.now()+60000).toISOString()},{valid_to:new Date(Date.now()-60000).toISOString()},{superseded_by:'replacement-memory'},{status:'replaced'}]){
  const f=await fixture(t);f.putMemory(encryptMemoryRow('memories',{...f.plain[0],...patch},f.scope,f.key,f.keyId));
  const result=await projectAuthenticatedLegacyGraph(f.input,(bundle,memories)=>({links:bundle.rows.memory_graph_links,memories:memories.map(row=>row.id)}));
  assert.deepEqual(result,{links:[],memories:[]});assert.equal(f.opened.length,0);
 }
});
