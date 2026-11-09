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
import {mutateAuthenticatedLegacyGraph,legacyGraphMutationActionDigest} from '../src/memory/encryption/legacy-graph-mutation.ts';
import {openLegacyGraphRecords} from '../src/memory/encryption/legacy-graph-records.ts';
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
 CREATE TABLE memory_project_scopes(owner_id TEXT,slug TEXT,department_id TEXT,archived_at TEXT);`);
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


function mutation(f,overrides={}){
 f.db.prepare('UPDATE agent_permissions SET memory_write=?').run('["project"]');
 let approved=true,pending=false,commits=0;
 const action={kind:'decide-link',linkId:'link-pending',decision:'approve'};
 const input={...f.input,action,authorizeReview:async intent=>({...intent,actorId:f.scope.ownerId,rootGeneration:intent.root.generation,isCurrent:()=>approved}),graphMutationJournal:async(before,after)=>{
  assert.deepEqual(before,f.graph);pending=true;f.revokeRoot();
  return{isCurrent:()=>pending,commit:async()=>{commits++;assert.deepEqual(f.db.prepare('SELECT * FROM '+LEGACY_GRAPH_RECORD_TABLE+' ORDER BY ordinal').all(),after);pending=false;return true;}};
 },...overrides};
 return{input,revoke:()=>{approved=false;},commits:()=>commits};
}
function open(f){return openLegacyGraphRecords(f.db.prepare('SELECT * FROM '+LEGACY_GRAPH_RECORD_TABLE+' ORDER BY ordinal').all(),f.plain.map(row=>({id:row.id,user_id:row.user_id,content:''})),f.scope,f.key,f.keyId);}
test('explicit owner decision survives old root invalidation and preserves hidden bundle data',async t=>{
 const f=await fixture(t),m=mutation(f),result=await mutateAuthenticatedLegacyGraph(m.input);
 assert.deepEqual(result,{id:'link-pending',status:'active'});assert.equal(m.commits(),1);
 const expected=structuredClone(f.bundle),actual=open(f),link=actual.rows.memory_graph_links.find(row=>row.id==='link-pending');
 expected.rows.memory_graph_links.find(row=>row.id==='link-pending').status='active';
 expected.rows.memory_graph_links.find(row=>row.id==='link-pending').decided_by=f.scope.ownerId;
 expected.rows.memory_graph_links.find(row=>row.id==='link-pending').decided_at=link.decided_at;
 assert.deepEqual(actual,expected);assert.ok(!JSON.stringify(result).includes('SYNTHETIC_HIDDEN'));
});
test('read scope and owner identity never substitute for explicit review or write authority',async t=>{
 for(const mode of ['missing','wrong-digest','wrong-actor','write-denied']){
  const f=await fixture(t),m=mutation(f);let prepared=false;
  m.input.graphMutationJournal=async()=>{prepared=true;throw Error('unexpected');};
  if(mode==='missing')m.input.authorizeReview=async()=>null;
  if(mode==='wrong-digest'||mode==='wrong-actor')m.input.authorizeReview=async intent=>({...intent,actionDigest:mode==='wrong-digest'?'wrong':intent.actionDigest,actorId:mode==='wrong-actor'?'other':f.scope.ownerId,rootGeneration:intent.root.generation,isCurrent:()=>true});
  if(mode==='write-denied')f.db.prepare('UPDATE agent_permissions SET memory_write=?').run('[]');
  await assert.rejects(mutateAuthenticatedLegacyGraph(m.input),MemoryCipherError);assert.equal(prepared,false);assert.deepEqual(open(f),f.bundle);
 }
});
test('pending journal revocation or stale ciphertext prevents SQL replacement and native commit',async t=>{
 for(const mode of ['pending','review','memory','graph','rollback']){
  const f=await fixture(t),m=mutation(f);let commits=0;
  m.input.graphMutationJournal=async()=>{
   f.revokeRoot();if(mode==='review')m.revoke();
   if(mode==='memory')f.db.prepare('UPDATE memories SET importance_score=99 WHERE id=?').run('graph-visible');
   if(mode==='graph')f.db.prepare('UPDATE '+LEGACY_GRAPH_RECORD_TABLE+' SET payload=?').run('stale');
   if(mode==='rollback')f.db.exec("CREATE TRIGGER refuse_graph_insert BEFORE INSERT ON "+LEGACY_GRAPH_RECORD_TABLE+" BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END");
   return{isCurrent:()=>mode!=='pending',commit:async()=>{commits++;return true;}};
  };
  await assert.rejects(mutateAuthenticatedLegacyGraph(m.input),MemoryCipherError);assert.equal(commits,0);
  if(mode!=='graph')assert.deepEqual(open(f),f.bundle);
 }
});
test('hidden aggregate targets and arbitrary cluster support sets cannot be mutated',async t=>{
 for(const action of [{kind:'decide-link',linkId:'link-rejected',decision:'approve'},{kind:'dismiss-cluster',clusterId:hash(JSON.stringify(['project:allowed',['entity-shared']])).slice(0,32),drawer:'project:allowed',entityIds:['entity-shared'],memoryIds:['graph-visible']}]){
  const f=await fixture(t),m=mutation(f,{action});let prepared=false;m.input.graphMutationJournal=async()=>{prepared=true;throw Error('unexpected');};
  await assert.rejects(mutateAuthenticatedLegacyGraph(m.input),MemoryCipherError);assert.equal(prepared,false);assert.deepEqual(open(f),f.bundle);
 }
});
test('fixed action digest normalizes ID sets and refuses unknown action fields',()=>{
 const action={kind:'dismiss-cluster',drawer:'project:allowed',entityIds:['entity-b','entity-a'],memoryIds:['memory-b','memory-a'],clusterId:hash(JSON.stringify(['project:allowed',['entity-a','entity-b']])).slice(0,32)};
 assert.equal(legacyGraphMutationActionDigest(action),legacyGraphMutationActionDigest({...action,entityIds:[...action.entityIds].reverse(),memoryIds:[...action.memoryIds].reverse()}));
 assert.throws(()=>legacyGraphMutationActionDigest({...action,allowWrite:true}),MemoryCipherError);
});
