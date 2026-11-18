import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'girru-host-apps-')),old=process.cwd();
process.chdir(dir);process.env.HOME=dir;process.env.AGENT_PLAYER_DATA_DIR=path.join(dir,'data');process.env.DATABASE_PATH=path.join(dir,'data','agent-player.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.NODE_ENV='test';
const {getDatabase}=await import('../src/db/index.ts');const db=getDatabase();await db.initialize();
const {installedAppsRoot,installedAppDir}=await import('../src/config/backend-root.ts');
const {storeHostEnabled,storeHostStatus,markStoreHostStarted,retireStoreHostApp}=await import('../src/services/store-host-apps.ts');
const {moveLegacyAppTables,MOVED_APPS}=await import('../src/services/legacy-app-tables.ts');
test('reviewed optional app stays disabled until explicit activation and stops after retirement',async()=>{
 const root=path.join(installedAppsRoot(),'trading');fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'index.js'),'export default {};');fs.writeFileSync(path.join(root,'app-host.npm'),JSON.stringify({schema:1,host:'trading',protocolVersion:1}));
 assert.equal(storeHostEnabled('trading'),false);assert.equal((await storeHostStatus('trading')).installed,false);
 db.exec('CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)');
 const hash=createHash('sha256').update('synthetic-package').digest('hex'),client=createHash('sha256').update('synthetic-client').digest('hex');
 db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('store.installed.trading',JSON.stringify({source:'store',packageSha256:hash}),Date.now());
 db.prepare("INSERT INTO extension_configs(extension_id,enabled) VALUES('trading',0)").run();
 fs.writeFileSync(path.join(root,'.girru-store.json'),JSON.stringify({source:'store',id:'trading',packageSha256:hash,files:[{path:'client.js',sha256:client}]}));
 assert.deepEqual(await storeHostStatus('trading'),{id:'trading',installed:true,enabled:false,ready:true,clientHash:client,needsRestart:false});
 db.prepare("UPDATE extension_configs SET enabled=1 WHERE extension_id='trading'").run();assert.equal(storeHostEnabled('trading'),true);assert.equal((await storeHostStatus('trading')).needsRestart,true);
 markStoreHostStarted('trading');assert.equal((await storeHostStatus('trading')).needsRestart,false);
 retireStoreHostApp('trading');assert.equal(storeHostEnabled('trading'),false);assert.equal((await storeHostStatus('trading')).needsRestart,true);

 fs.rmSync(root,{recursive:true});assert.equal(storeHostEnabled('trading'),false);
});
test('Call Center legacy data requires successful backup and gains missing fixed columns without erasing rows',async()=>{
 const app=MOVED_APPS.find(a=>a.id==='call-center');assert.ok(app);
 db.exec("INSERT INTO phone_numbers(id,phone_number) VALUES('saved','+15550001111')");db.prepare("INSERT INTO extension_configs(extension_id,enabled) VALUES('call-center',0)").run();
 assert.deepEqual(await moveLegacyAppTables({apps:[app],backup:async()=>{throw Error('backup unavailable');}}),[]);assert.equal(db.prepare('SELECT count(*) n FROM phone_numbers').get().n,1);
 let backups=0;assert.deepEqual(await moveLegacyAppTables({apps:[app],backup:async()=>{backups++;}}),['call-center']);assert.equal(backups,1);
 const row=db.prepare('SELECT * FROM app_call_center__phone_numbers').get();assert.equal(row.id,'saved');assert.equal(row.phone_number,'+15550001111');assert.equal(row.total_calls,0);assert.equal(row.tts_provider,'twilio');assert.equal(row.stt_provider,'twilio');
 assert.deepEqual(await moveLegacyAppTables({apps:[app],backup:async()=>{throw Error('must not repeat');}}),[]);
});
test('an operator app path still obeys a durable owner off switch',async()=>{
 const root=path.join(dir,'operator-browser');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'index.js'),'export default {}');fs.writeFileSync(path.join(root,'app-host.npm'),JSON.stringify({schema:1,host:'browser',protocolVersion:1}));process.env.GIRRU_BROWSER_APP_DIR=root;
 try{db.prepare("INSERT INTO extension_configs(extension_id,enabled) VALUES('browser',1)").run();assert.equal(storeHostEnabled('browser'),true);db.prepare("UPDATE extension_configs SET enabled=0 WHERE extension_id='browser'").run();assert.equal(storeHostEnabled('browser'),false);assert.equal((await storeHostStatus('browser')).enabled,false);}finally{delete process.env.GIRRU_BROWSER_APP_DIR;}
});
test('populated core telephony tables move even without an extension configuration row',async()=>{
 db.prepare("DELETE FROM app_settings WHERE key IN ('store.moved.call-center','store.reinstall.call-center')").run();db.prepare("DELETE FROM extension_configs WHERE extension_id='call-center'").run();db.prepare("DELETE FROM extension_migrations WHERE extension_id='call-center'").run();db.exec('ALTER TABLE app_call_center__phone_numbers RENAME TO phone_numbers');
 let backups=0;assert.deepEqual(await moveLegacyAppTables({apps:[MOVED_APPS.find(a=>a.id==='call-center')],backup:async()=>{backups++;}}),['call-center']);assert.equal(backups,1);assert.equal(db.prepare('SELECT id FROM app_call_center__phone_numbers').get().id,'saved');
});
test('legacy/new collisions retain both populated copies, while an empty target can be replaced after backup',async()=>{
 const app=MOVED_APPS.find(a=>a.id==='call-center');db.prepare("DELETE FROM app_settings WHERE key IN ('store.moved.call-center','store.reinstall.call-center')").run();db.exec("CREATE TABLE phone_numbers(id TEXT PRIMARY KEY,phone_number TEXT);INSERT INTO phone_numbers VALUES('legacy-second','+15550002222')");
 let backups=0;assert.deepEqual(await moveLegacyAppTables({apps:[app],backup:async()=>{backups++;}}),[]);assert.equal(backups,0);assert.equal(db.prepare('SELECT id FROM phone_numbers').get().id,'legacy-second');assert.equal(db.prepare('SELECT id FROM app_call_center__phone_numbers').get().id,'saved');
 db.exec('DELETE FROM app_call_center__phone_numbers');assert.deepEqual(await moveLegacyAppTables({apps:[app],backup:async()=>{backups++;}}),['call-center']);assert.equal(backups,1);assert.equal(db.prepare('SELECT id FROM app_call_center__phone_numbers').get().id,'legacy-second');
});
test.after(()=>{db.close();process.chdir(old);fs.rmSync(dir,{recursive:true,force:true});});
