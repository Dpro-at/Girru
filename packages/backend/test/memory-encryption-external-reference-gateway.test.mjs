import {fileURLToPath as backendFixtureFileURLToPath} from 'node:url';
import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import {mkdtempSync,mkdirSync,rmSync,realpathSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const backend = backendFixtureFileURLToPath(new URL('../',import.meta.url)),root=realpathSync(mkdtempSync(join(tmpdir(),'girru-external-gateway-')));mkdirSync(join(root,'data'));process.chdir(root);process.env.HOME=root;process.env.USERPROFILE=root;process.env.DATABASE_PATH=join(root,'data/test.sqlite');process.env.AGENT_PLAYER_DATA_DIR=join(root,'data');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.GIRRU_STORE_P3='1';
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('No network in synthetic gateway test');};
const load=p=>import(join(backend,'src',p));
const {getDatabase,closeDatabase}=await load('db/database.ts'),db=getDatabase();await db.initialize();
const {sqliteStepsOn}=await load('repositories/sql-steps.ts'),runner=sqliteStepsOn(db.getDb());
const {generateToken}=await load('auth/jwt.ts'),{recordSession}=await load('auth/sessions.ts');
const {createMemoryUnlockSession}=await load('memory/encryption/unlock-session.ts'),{openMemoryText}=await load('memory/encryption/envelope.ts');
const {captureExternalCopyReferencesStep}=await load('memory/encryption/external-copy-manifest.ts'),{captureAuthenticatedExternalReferencePlan}=await load('memory/encryption/external-reference-gateway.ts');
const scope={ownerId:'external-owner',memberId:'external-member'},key=randomBytes(32),keyId='external-key';
db.prepare("INSERT INTO users(id,email,username,password_hash,role,status,token_version) VALUES('external-owner','external@example.test','external-owner','x','owner','active',1)").run();
db.prepare("INSERT INTO chat_projects(id,user_id,name,slug,folder) VALUES('external-project','external-owner','Synthetic','legacy-slug',?)").run(join(root,'synthetic-project'));
db.prepare("INSERT INTO change_scopes(scope,owner_id,project_id,enabled) VALUES('project:external-project','external-owner','external-project',1)").run();
const {claimEncryptedProjectionHoldStep}=await load('memory/encryption/projection-hold.ts'),claimed=await runner.tx(()=>claimEncryptedProjectionHoldStep(scope.ownerId,'project:external-project'));
const references=await runner.tx(()=>captureExternalCopyReferencesStep(scope.ownerId)),holds=[{scope:'project:external-project',...claimed}],token=generateToken(scope.ownerId,1,'5m');await recordSession(token,'Unknown device');
db.prepare("INSERT INTO memory_key_state(owner_id,keyed_by,moved_at) VALUES(?,?,?)").run(scope.ownerId,'id',Date.now());
function request(){const session=createMemoryUnlockSession();session.unlock(key,keyId,scope);return{runner,token,session,snapshotId:'synthetic-plan',references,holds,authorizeRoot:async()=>true,recordIntent:async()=>true};}
test('owner-authenticated capture audits identifiers only and returns an owner-bound encrypted plan',async()=>{
 const input=request();let intent,opened;const capture=input.session.capture;input.session.capture=()=>{const lease=capture();return{...lease,async resolveKey(row){const m=await lease.resolveKey(row);opened=m.key;return m;}};};
 const {createExternalPlanIntentStore}=await load('memory/encryption/external-plan-intent-store.ts'),intentStore=createExternalPlanIntentStore(runner,scope.ownerId);await intentStore.initialize();input.recordIntent=async event=>{intent=event;return intentStore.append(event);};
 const result=await captureAuthenticatedExternalReferencePlan(input);assert.ok(!result.ciphertext.includes(root));assert.ok(!JSON.stringify(intent).includes(root));assert.equal(intent.purpose,'external-forget-plan');
 const plan=JSON.parse(openMemoryText(result.ciphertext,key,keyId,{...scope,recordId:input.snapshotId,field:'external-reference-plan'}));assert.equal(plan.plan[0].scope,'project:external-project');assert.ok(opened.every(b=>b===0));input.session.lock();
});
test('audit refusal and session revocation during audit prevent permission and key access',async()=>{
 for(const revoke of [false,true]){
  const input=request();let permissions=0;input.authorizeRoot=async()=>{permissions++;return true;};input.recordIntent=async()=>{if(revoke)db.prepare('UPDATE auth_sessions SET revoked_at=1').run();return revoke;};
  await assert.rejects(captureAuthenticatedExternalReferencePlan(input));assert.equal(permissions,0);assert.equal(input.session.isUnlocked(),false);db.prepare('UPDATE auth_sessions SET revoked_at=NULL').run();
 }
});
test('revocation during root permission check refuses encrypted plan and locks lease',async()=>{
 const input=request();input.authorizeRoot=async()=>{db.prepare('UPDATE auth_sessions SET revoked_at=1').run();return true;};
 try{await assert.rejects(captureAuthenticatedExternalReferencePlan(input));assert.equal(input.session.isUnlocked(),false);}finally{db.prepare('UPDATE auth_sessions SET revoked_at=NULL').run();}
});
test('explicit owner root grants deny by default, isolate exact roots and revoke without discovery inheritance',async()=>{
 const {createExternalRootPermissionService}=await load('memory/encryption/external-root-permissions.ts');
 const service=createExternalRootPermissionService({runner,token,lookupKey:randomBytes(32)});await service.initialize();
 const request={purpose:'encrypted-forget-plan',ownerId:scope.ownerId,scope:'project:external-project',root:references[0].path,reference:references[0]};
 assert.equal(await service.authorizeRoot(request),false);
 await service.grant(request.scope,request.root,Date.now()+60000);assert.equal(await service.authorizeRoot(request),true);
 assert.equal(await service.authorizeRoot({...request,root:request.root+'/child'}),false);assert.equal(await service.authorizeRoot({...request,ownerId:'other-owner'}),false);
 await service.revoke(request.scope,request.root);assert.equal(await service.authorizeRoot(request),false);
 const renewed=await service.grant(request.scope,request.root,Date.now()+60000);assert.equal(renewed.generation,2);
 db.prepare('UPDATE memory_encryption_external_root_grants SET expires_at=1').run();assert.equal(await service.authorizeRoot(request),false);
 const stored=JSON.stringify(db.prepare('SELECT * FROM memory_encryption_external_root_grants').all());assert.ok(!stored.includes(request.root));
 db.prepare('UPDATE auth_sessions SET revoked_at=1').run();await assert.rejects(service.authorizeRoot(request));db.prepare('UPDATE auth_sessions SET revoked_at=NULL').run();
 service.close();await assert.rejects(service.authorizeRoot(request));
});
test('explicit planning host wires actual grants and intent store without automatic consent',async()=>{
 const {createAuthenticatedExternalPlanHost}=await load('memory/encryption/external-plan-host.ts');
 const session=createMemoryUnlockSession();session.unlock(key,keyId,scope);
 const host=createAuthenticatedExternalPlanHost({runner,token,session,lookupKey:randomBytes(32)}),plan={snapshotId:'host-plan',references,holds};
 await assert.rejects(host.capture(plan));await host.initialize();assert.equal(host.status(),'ready');
 await assert.rejects(host.capture(plan));session.unlock(key,keyId,scope);
 await host.grantRoot('project:external-project',references[0].path,Date.now()+60000);
 assert.ok((await host.capture(plan)).ciphertext);mkdirSync(references[0].path,{recursive:true});
 const rooted=await host.captureRoots({...plan,snapshotId:'host-root-plan'});const decoded=JSON.parse(openMemoryText(rooted.ciphertext,key,keyId,{...scope,recordId:'host-root-plan',field:'external-reference-plan'}));assert.equal(decoded.v,2);assert.equal(decoded.identities.length,1);assert.equal(decoded.identities[0].root,references[0].path);assert.match(decoded.identities[0].inode,/^\d+$/);
 mkdirSync(join(references[0].path,'.girru'));writeFileSync(join(references[0].path,'.girru','brief.outside-2.md'),'SYNTHETIC_FORGOTTEN_COPY');
 const inventoried=await host.captureInventory({...plan,snapshotId:'host-inventory-plan'}),inventory=JSON.parse(openMemoryText(inventoried.ciphertext,key,keyId,{...scope,recordId:'host-inventory-plan',field:'external-reference-plan'}));assert.equal(inventory.v,4);const {parseExternalPlanSnapshot}=await load('memory/encryption/external-plan-schema.ts');assert.equal(parseExternalPlanSnapshot(JSON.stringify(inventory),scope.ownerId,'host-inventory-plan').v,4);const observations=db.prepare('SELECT snapshot_id,ciphertext FROM memory_encryption_external_plan_checkpoints').all();assert.ok(observations.some(r=>r.snapshot_id==='host-inventory-plan'));assert.ok(!JSON.stringify(observations).includes('SYNTHETIC_FORGOTTEN_COPY'));
 const checkpoint=db.prepare('SELECT id,ciphertext FROM memory_encryption_external_plan_checkpoints WHERE snapshot_id=?').get('host-inventory-plan');
 assert.equal((await host.revalidateCheckpoint(checkpoint.id)).v,4);assert.equal(db.prepare("SELECT count(*) n FROM memory_encryption_external_plan_intents WHERE purpose='external-forget-plan-history' AND snapshot_id=?").get(checkpoint.id).n,1);
 db.prepare('UPDATE memory_encryption_external_plan_checkpoints SET ciphertext=? WHERE id=?').run('{}',checkpoint.id);await assert.rejects(host.revalidateCheckpoint(checkpoint.id));assert.equal(session.isUnlocked(),false);db.prepare('UPDATE memory_encryption_external_plan_checkpoints SET ciphertext=? WHERE id=?').run(checkpoint.ciphertext,checkpoint.id);session.unlock(key,keyId,scope);
 const {revalidateAuthenticatedExternalPlanCheckpoint}=await load('memory/encryption/external-plan-reader.ts');let opened=false,permissions=0;const denied=createMemoryUnlockSession();denied.unlock(key,keyId,scope);const oldCapture=denied.capture;denied.capture=()=>{const lease=oldCapture();return{...lease,resolveKey:async row=>{opened=true;return lease.resolveKey(row);}};};await assert.rejects(revalidateAuthenticatedExternalPlanCheckpoint({runner,token,session:denied,checkpointId:checkpoint.id,recordIntent:async()=>false,authorizeRoot:async()=>{permissions++;return true;}}));assert.equal(opened,false);assert.equal(permissions,0);
assert.equal(inventory.inventories[0].files[0].path,'.girru/brief.outside-2.md');assert.equal(inventory.inventories[0].files[0].classification,'historical-copy-unverified');assert.ok(!JSON.stringify(inventory).includes('SYNTHETIC_FORGOTTEN_COPY'));
assert.ok(db.prepare('SELECT count(*) n FROM memory_encryption_external_plan_intents WHERE snapshot_id=?').get(plan.snapshotId).n>=1);
 db.exec("CREATE TRIGGER refuse_plan_checkpoint AFTER INSERT ON memory_encryption_external_plan_checkpoints BEGIN SELECT RAISE(ABORT,'synthetic checkpoint refusal'); END");await assert.rejects(host.capture({...plan,snapshotId:'checkpoint-fails'}));assert.equal(session.isUnlocked(),false);assert.equal(db.prepare('SELECT count(*) n FROM memory_encryption_external_plan_checkpoints WHERE snapshot_id=?').get('checkpoint-fails').n,0);db.exec('DROP TRIGGER refuse_plan_checkpoint');session.unlock(key,keyId,scope);
 db.exec("CREATE TRIGGER revoke_at_checkpoint AFTER INSERT ON memory_encryption_external_plan_checkpoints BEGIN UPDATE auth_sessions SET revoked_at=1; END");await assert.rejects(host.capture({...plan,snapshotId:'checkpoint-revoked'}));assert.equal(session.isUnlocked(),false);assert.equal(db.prepare('SELECT count(*) n FROM memory_encryption_external_plan_checkpoints WHERE snapshot_id=?').get('checkpoint-revoked').n,1);db.exec('DROP TRIGGER revoke_at_checkpoint');db.prepare('UPDATE auth_sessions SET revoked_at=NULL').run();session.unlock(key,keyId,scope);
 db.getDb().function('invalidate_checkpoint_lease',()=>{session.lock();return 0;});db.exec('CREATE TRIGGER invalidate_at_checkpoint AFTER INSERT ON memory_encryption_external_plan_checkpoints BEGIN SELECT invalidate_checkpoint_lease(); END');await assert.rejects(host.capture({...plan,snapshotId:'checkpoint-lease-revoked'}));assert.equal(session.isUnlocked(),false);db.exec('DROP TRIGGER invalidate_at_checkpoint');session.unlock(key,keyId,scope);
 const previousReadonly=process.env.AGENT_PLAYER_READONLY;db.getDb().function('readonly_checkpoint_boundary',()=>{process.env.AGENT_PLAYER_READONLY='1';return 0;});db.exec('CREATE TRIGGER readonly_at_checkpoint AFTER INSERT ON memory_encryption_external_plan_checkpoints BEGIN SELECT readonly_checkpoint_boundary(); END');try{await assert.rejects(host.capture({...plan,snapshotId:'checkpoint-readonly'}));assert.equal(session.isUnlocked(),false);}finally{db.exec('DROP TRIGGER readonly_at_checkpoint');if(previousReadonly===undefined)delete process.env.AGENT_PLAYER_READONLY;else process.env.AGENT_PLAYER_READONLY=previousReadonly;}session.unlock(key,keyId,scope);
 const nextRoot=join(root,'synthetic-new-project');mkdirSync(join(nextRoot,'.girru'),{recursive:true});writeFileSync(join(nextRoot,'.girru','brief.md'),'NEW_ROOT_SYNTHETIC_COPY');db.prepare('UPDATE chat_projects SET folder=? WHERE id=?').run(nextRoot,'external-project');const nextReferences=await runner.tx(()=>captureExternalCopyReferencesStep(scope.ownerId));await host.grantRoot('project:external-project',nextRoot,Date.now()+60000);await host.captureInventory({snapshotId:'host-moved-root',references:nextReferences,holds});
 const tracked=await host.trackHistoricalCopies();assert.equal(tracked.completeHistoricalCoverage,false);assert.equal(tracked.executionAuthorized,false);assert.ok(tracked.files.some(f=>f.root===references[0].path&&f.path==='.girru/brief.outside-2.md'));assert.ok(tracked.files.some(f=>f.root===nextRoot&&f.path==='.girru/brief.md'));
 const totalHistorical=db.prepare('SELECT count(*) n FROM memory_encryption_external_plan_checkpoints WHERE owner_id=?').get(scope.ownerId).n,originalTx=runner.tx;let observedLoads=0,injectedFinalRevoke=false;
 runner.tx=async(...args)=>{const result=await originalTx(...args);if(result&&typeof result==='object'&&typeof result.ciphertext==='string'&&typeof result.id==='string')observedLoads++;if(!injectedFinalRevoke&&observedLoads===totalHistorical*2&&result===true){injectedFinalRevoke=true;db.prepare('UPDATE auth_sessions SET revoked_at=1').run();}return result;};
 try{await assert.rejects(host.trackHistoricalCopies());assert.equal(injectedFinalRevoke,true);assert.equal(session.isUnlocked(),false);}finally{runner.tx=originalTx;db.prepare('UPDATE auth_sessions SET revoked_at=NULL').run();session.unlock(key,keyId,scope);}
 await host.revokeRoot('project:external-project',nextRoot);await assert.rejects(host.trackHistoricalCopies());session.unlock(key,keyId,scope);db.prepare('UPDATE chat_projects SET folder=? WHERE id=?').run(references[0].path,'external-project');
 await host.revokeRoot('project:external-project',references[0].path);await assert.rejects(host.capture(plan));session.unlock(key,keyId,scope);await assert.rejects(host.revalidateCheckpoint(checkpoint.id));
 await host.close();assert.equal(host.status(),'closed');assert.equal(session.isUnlocked(),false);await assert.rejects(host.grantRoot('project:external-project',references[0].path,Date.now()+60000));
});
test.after(()=>{closeDatabase();process.chdir(backend);globalThis.fetch=originalFetch;rmSync(root,{recursive:true,force:true});});
