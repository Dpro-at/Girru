import {fileURLToPath as backendFixtureFileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
const backend = backendFixtureFileURLToPath(new URL('../',import.meta.url)),temporary=mkdtempSync(join(tmpdir(),'computer-multi-'));
process.env.HOME=temporary;process.env.AGENT_PLAYER_CONFIG_DIR=join(temporary,'config');process.env.DATABASE_PATH=join(temporary,'receiver.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.NODE_ENV='test';process.env.AGENT_PLAYER_BACKGROUND='off';
console.log=()=>{};console.info=()=>{};console.warn=()=>{};
const {getDatabase}=await import('../src/db/database.ts');
if(process.env.AGENT_PLAYER_DB==='postgres'){const {runPgMigrations}=await import('../src/db/pg/migrate.ts');const {getPgPool}=await import('../src/db/pg/pool.ts');await runPgMigrations(await getPgPool());}else await getDatabase().initialize();
const {q,sql,sqliteStepsOn}=await import('../src/repositories/sql-steps.ts');
const {createIdentity}=await import('../src/phone/protocol/e2e.ts');
const {createSyntheticAuthority}=await import('../src/devices/synthetic-authority.ts');
const {ComputerMembership}=await import('../src/devices/membership.ts');
const {DeviceCoopRepository}=await import('../src/repositories/device-coop.ts');
const {ComputerCoordinator}=await import('../src/devices/coordinator.ts');
const {userActor}=await import('../src/repositories/actor.ts');
const {createBoard}=await import('../src/services/task-board.ts');
const {createProject,listConversations}=await import('../src/repositories/chat-conversations.ts');
const {getApprovalDetail,approveAndRun}=await import('../src/tools/approvals.ts');
const {createRelay}=await import('../../relay/src/relay.ts');
const Database=(await import('better-sqlite3')).default;
const owner='multi_owner';
await q.run("INSERT INTO users(id,email,username,password_hash,role,status,email_verified) VALUES(?,?,?,'x','owner','active',1)",owner,'multi@example.test',owner);
await q.run("INSERT INTO agents_config(id,name,model,provider) VALUES('multi_agent','Synthetic worker','synthetic','ollama')");
await q.run("INSERT INTO agent_grant_profiles(agent_id,source) VALUES('multi_agent','owner')");
await q.run("INSERT INTO agent_tool_grants(agent_id,tool_name) VALUES('multi_agent','computer_task_accept')");
const project=await createProject(owner,{name:'Synthetic local project'}),board=await createBoard(owner,{name:'Synthetic board'});
const identities=[createIdentity(),createIdentity(),createIdentity()],authority=createSyntheticAuthority({disposable:true,ownerId:owner,identities}),actor=userActor({id:owner,role:'owner'}),dbs=[];
const minimal=(name,id)=>{const db=new Database(join(temporary,name+'.db'));db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,status TEXT)');db.prepare("INSERT INTO users VALUES(?,'owner','active')").run(owner);for(const migration of ['194_device_coop.sql','195_computer_direct.sql','197_device_custody_schedule.sql'])db.exec(readFileSync(join(backend,'src/db/migrations',migration),'utf8'));dbs.push(db);return new DeviceCoopRepository(sqliteStepsOn(db),id);};
const repos=[minimal('first',identities[0].id),new DeviceCoopRepository(sql(),identities[1].id),minimal('third',identities[2].id)];
const memberships=identities.map((id,i)=>new ComputerMembership(id,owner,'multi_workspace',repos[i],authority));
const bindings=new Map([['mobile',{projectId:project.id,agentId:'multi_agent',model:'synthetic',boardId:board.id,columnId:board.columns[0].id}]]);
const relay=createRelay({port:0}),address=await relay.listen(),url=`ws://127.0.0.1:${address.port}/v1`;
const computers=memberships.map((m,i)=>new ComputerCoordinator(m,['First computer','Second computer','Third computer'][i],bindings,url));
const until=async(fn)=>{for(let i=0;i<200;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,25));}throw Error('Multi-computer condition timed out');};
const pair=async(a,b)=>{const p=await memberships[a].invite(actor,url),request=memberships[b].request(p,'Computer '+(b+1)),challenge=await memberships[a].challenge(actor,p.id,identities[b].id,request.env),code=memberships[b].check(request,challenge.env);await memberships[a].approve(actor,p.id,code);await memberships[b].acceptHost(actor,request,challenge.env,code,'Computer '+(a+1));};
const approveEndpoint=async(a,b,endpoint,expiresAt=Date.now()+600000)=>{const p=await memberships[a].current(identities[b].id);await memberships[a].approveDirect(actor,identities[b].id,{url:endpoint,epoch:Number(p.epoch),publicKey:p.public_key,expiresAt});};
const task=id=>({taskId:id,attemptId:id+'_attempt',projectBinding:'mobile',agentBinding:'multi_agent',modelBinding:'synthetic',text:'Synthetic multi-computer handoff.'});
const submit=async(source,id)=>computers[source].dispatch(actor,identities[1].id,task(id));
const approve=async(id)=>{const a=await until(async()=>{const row=await repos[1].attempt(id);return row?.approval_id?row:false;}),detail=await getApprovalDetail(a.approval_id);return approveAndRun(a.approval_id,owner,detail.paramsHash);};
let urls=[],heartbeat;
test.after(async()=>{if(heartbeat)clearInterval(heartbeat);for(const computer of computers)computer.stop();await Promise.all(computers.map(c=>c.transport.stopDirect()));await relay.close();for(const db of dbs)db.close();if(process.env.AGENT_PLAYER_DB==='postgres'){const {closePgPool}=await import('../src/db/pg/pool.ts');await closePgPool();}});

test('three independent profiles require per-peer approval, prefer direct, and retain one logical event across both paths',async()=>{
 for(const computer of computers)await computer.start();
 await pair(0,1);await pair(0,2);
 await assert.rejects(()=>computers[2].dispatch(actor,identities[1].id,task('unpaired')),/stale/);
 await pair(1,2);
 urls=await Promise.all(computers.map(c=>c.transport.enableSyntheticDirect(actor)));
 for(let a=0;a<3;a++)for(let b=0;b<3;b++)if(a!==b)await approveEndpoint(a,b,urls[b]);
 const member=await memberships[0].current(identities[1].id);
 for(const endpoint of ['ws://0.0.0.0:1234/v1','ws://192.168.1.20:1234/v1','ws://localhost:1234/v1','ws://127.0.0.1:1234/other','http://127.0.0.1:1234/v1','ws://name.example:1234/v1'])await assert.rejects(()=>memberships[0].approveDirect(actor,identities[1].id,{url:endpoint,epoch:1,publicKey:member.public_key,expiresAt:Date.now()+10000}));
 await assert.rejects(()=>memberships[0].approveDirect(userActor({id:'different',role:'owner'}),identities[1].id,{url:urls[1],epoch:1,publicKey:member.public_key,expiresAt:Date.now()+10000}));
 heartbeat=setInterval(()=>{for(const c of computers)void c.advertise(actor).catch(()=>{});},200);
 await until(async()=>{const views=await Promise.all(computers.map(c=>c.view(actor)));return views.every(v=>v.devices.length===2&&v.devices.every(d=>d.path==='direct'&&d.capacity?.limit===3));});
 const before=computers[0].transport.statistics;
 await submit(0,'direct_task');await until(async()=> (await repos[1].attempt('direct_task'))?.approval_id);assert.equal((await listConversations(owner)).length,0);await approve('direct_task');await until(async()=> (await repos[0].attempt('direct_task'))?.state==='completed');assert.ok(computers[0].transport.statistics.direct>before.direct);assert.equal((await listConversations(owner)).length,1);assert.equal(await repos[2].attempt('direct_task'),undefined,'explicit task target is not a broadcast');
 // Drop signed acknowledgments long enough to force the original event onto the relay.
 const send=computers[1].transport.send.bind(computers[1].transport);let drop=true;computers[1].transport.send=e=>e.kind==='ack'&&drop?Promise.resolve(false):send(e);
 await submit(2,'ack_task');await until(async()=> (await repos[1].attempt('ack_task'))?.approval_id);const outgoing=(await repos[2].pending()).find(e=>JSON.parse(e.envelope_json).kind==='task');assert.ok(outgoing);const relayBefore=computers[2].transport.statistics.relay;
 await until(()=>computers[2].transport.pathsFor(outgoing.event_id).includes('relay'));drop=false;await approve('ack_task');await until(async()=> (await repos[2].attempt('ack_task'))?.state==='completed');computers[1].transport.send=send;
 const same=await repos[1].runner.read((await import('../src/repositories/sql-steps.ts')).all('SELECT event_id FROM computer_delivery WHERE local_device_id=? AND direction=\'in\' AND event_id=?',repos[1].localId,outgoing.event_id));assert.equal(same.length,1);assert.equal((await listConversations(owner)).length,2);
});

test('direct refusal, expiry and mid-task loss fall back without new attempts; per-peer revocation and restore remain closed',async()=>{
 clearInterval(heartbeat);heartbeat=null;
 // Disable physical sockets before changing direct metadata; no discovery or network scan occurs.
 await Promise.all(computers.map(c=>c.transport.stopDirect()));
 const before=computers[0].transport.statistics.relay;
 await submit(0,'fallback_task');await approve('fallback_task');await until(async()=> (await repos[0].attempt('fallback_task'))?.state==='completed');assert.ok(computers[0].transport.statistics.relay>before);assert.equal((await listConversations(owner)).length,3);
 urls=await Promise.all(computers.map(c=>c.transport.enableSyntheticDirect(actor)));for(let a=0;a<3;a++)for(let b=0;b<3;b++)if(a!==b)await approveEndpoint(a,b,urls[b]);
 heartbeat=setInterval(()=>{for(const c of computers)void c.advertise(actor).catch(()=>{});},200);await until(async()=> (await computers[0].view(actor)).devices.every(d=>d.path==='direct'));
 await submit(0,'switch_task');await approve('switch_task');await Promise.all(computers.map(c=>c.transport.stopDirect()));await until(async()=> (await repos[0].attempt('switch_task'))?.state==='completed');assert.equal((await listConversations(owner)).length,4);await computers[0].dispatch(actor,identities[1].id,task('switch_task'));assert.equal((await listConversations(owner)).length,4);
 // A receiver restart cannot repeat the accepted attempt, even while direct endpoints persist.
 urls=await Promise.all(computers.map(c=>c.transport.enableSyntheticDirect(actor)));for(let a=0;a<3;a++)for(let b=0;b<3;b++)if(a!==b)await approveEndpoint(a,b,urls[b]);
 await submit(0,'restart_direct');await approve('restart_direct');computers[1].stop();computers[1]=new ComputerCoordinator(memberships[1],'Second computer',bindings,url);await computers[1].start();await until(async()=> (await repos[0].attempt('restart_direct'))?.state==='unknown');assert.equal((await repos[1].attempt('restart_direct')).fence,'');await computers[0].dispatch(actor,identities[1].id,task('restart_direct'));assert.equal((await listConversations(owner)).length,5);
 await Promise.all(computers.map(c=>c.transport.stopDirect()));
 // The wrong direct endpoint cannot impersonate the target key; its handshake times out to relay.
 const wrong=await computers[0].transport.enableSyntheticDirect(actor);await approveEndpoint(2,1,wrong);await submit(2,'refused_direct');await approve('refused_direct');await until(async()=> (await repos[2].attempt('refused_direct'))?.state==='completed');assert.equal((await listConversations(owner)).length,6);
 // A stale approved endpoint is never silently refreshed, and execution still needs current owner approval.
 await approveEndpoint(2,1,urls[1],Date.now()+10);await new Promise(r=>setTimeout(r,15));assert.equal(await memberships[2].direct(identities[1].id),null);
 await submit(2,'expired_task');const pending=await until(async()=> (await repos[1].attempt('expired_task'))?.approval_id);const detail=await getApprovalDetail(pending);await assert.rejects(()=>approveAndRun(pending,owner,'wrong'));await approveAndRun(pending,owner,detail.paramsHash);await until(async()=> (await repos[2].attempt('expired_task'))?.state==='completed');assert.equal((await listConversations(owner)).length,7);
 const snapshot=dbs[1].serialize();await memberships[2].nextSequence();const restored=new Database(snapshot);const stale=new ComputerMembership(identities[2],owner,'multi_workspace',new DeviceCoopRepository(sqliteStepsOn(restored),identities[2].id),authority);await assert.rejects(()=>stale.current(identities[0].id),/freshness/);restored.close();
 await memberships[0].revoke(actor,identities[2].id);await assert.rejects(()=>computers[2].dispatch(actor,identities[0].id,task('revoked_pair')),/stale/);assert.ok(await memberships[2].current(identities[1].id));await submit(2,'isolated_task');await approve('isolated_task');await until(async()=> (await repos[2].attempt('isolated_task'))?.state==='completed');assert.equal((await listConversations(owner)).length,8);
});

test('capacity is bounded per target across simultaneous approved sources',async()=>{
 const {chatRuns}=await import('../src/services/chat-runs.ts');const start=chatRuns.start.bind(chatRuns);let release;const gate=new Promise(r=>{release=r;});chatRuns.start=input=>start({...input,execute:async reply=>{await gate;return input.execute(reply);}});
 try{
  for(let i=0;i<4;i++)await submit(2,'capacity_'+i);
  await until(async()=>{const rows=await Promise.all([0,1,2,3].map(i=>repos[1].attempt('capacity_'+i)));return rows.every(r=>r?.approval_id);});
  const results=await Promise.all([0,1,2,3].map(i=>approve('capacity_'+i)));assert.equal(results.filter(r=>!r.result.error).length,3);assert.equal(results.filter(r=>r.result.error).length,1);
  await computers[1].advertise(actor);await until(async()=>{await computers[1].advertise(actor);const d=(await computers[2].view(actor)).devices.find(d=>d.id===identities[1].id);return d?.state==='busy'&&d.capacity?.active===3;});
 }finally{release();chatRuns.start=start;}
 await until(async()=>{const rows=await Promise.all([0,1,2,3].map(i=>repos[1].attempt('capacity_'+i)));return rows.filter(r=>r?.state==='completed').length===3;});assert.equal((await listConversations(owner)).length,11);
});
