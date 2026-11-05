import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'channel-runtime-store-'));process.env.HOME=root;process.env.USERPROFILE=root;process.env.AGENT_PLAYER_DATA_DIR=root;process.env.DATABASE_PATH=path.join(root,'db.sqlite');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');delete process.env.GIRRU_CHANNELS_RUNTIME_DIR;
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();db.exec('CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)');
const {channelRuntimeStatus,loadChannelLibrary,channelHostCapabilityAllowed,reviewedChannelReceipt}=await import('../src/services/channel-runtime.ts');
const app=path.join(root,'apps/agent-connect'),sdk=path.join(app,'node_modules/agent-connect-dpro'),marker=path.join(root,'executed');fs.mkdirSync(path.join(sdk,'dist'),{recursive:true});fs.writeFileSync(path.join(app,'package.json'),'{"type":"module"}');
fs.writeFileSync(path.join(sdk,'package.json'),JSON.stringify({name:'agent-connect-dpro',version:'0.2.0',type:'module',exports:{'.':{import:'./dist/index.js'}}}));fs.writeFileSync(path.join(sdk,'dist/index.js'),`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'executed');export class ChannelConnector{};export class TelegramTransport{};export class DiscordTransport{};export class PythonTransport{};export const CHANNEL_CATALOG=Array.from({length:33},(_,i)=>({id:String(i)}));`);
fs.writeFileSync(path.join(app,'runtime-packages.npm'),JSON.stringify({schema:1,packages:[{name:'agent-connect-dpro',version:'0.2.0',path:'node_modules/agent-connect-dpro',url:'https://registry.npmjs.org/agent-connect-dpro/-/agent-connect-dpro-0.2.0.tgz',size:1,sha256:'a'.repeat(64)}]}));
const receipt={packageSha256:'a'.repeat(64),version:'0.3.0'};
const save=value=>db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('store.installed.agent-connect',JSON.stringify(value),Date.now());
test.after(()=>{closeDatabase();fs.rmSync(root,{recursive:true,force:true});});
test('private or missing receipts never grant the channel host capability',async()=>{
 assert.equal(reviewedChannelReceipt(null),false);assert.equal(reviewedChannelReceipt(JSON.stringify({...receipt,source:'private'})),false);assert.equal(reviewedChannelReceipt(JSON.stringify({...receipt,packageSha256:'bad'})),false);
 save({...receipt,source:'private'});assert.deepEqual(await channelRuntimeStatus(),{installed:false,ready:false});assert.equal(channelHostCapabilityAllowed(db.getDb(),app),false);await assert.rejects(loadChannelLibrary());assert.equal(fs.existsSync(marker),false);
});
test('reviewed disabled app metadata does not execute SDK code; an explicit host load does',async()=>{
 save(receipt);assert.deepEqual(await channelRuntimeStatus(),{installed:true,ready:true});assert.equal(fs.existsSync(marker),false);assert.equal(channelHostCapabilityAllowed(db.getDb(),path.join(root,'other')),false);assert.equal(channelHostCapabilityAllowed(db.getDb(),app),true);
 const module=await loadChannelLibrary();assert.equal(module.CHANNEL_CATALOG.length,33);assert.equal(fs.readFileSync(marker,'utf8'),'executed');
});
test('missing dependencies fail readiness before Node can look outside the app',async()=>{
 fs.unlinkSync(path.join(sdk,'package.json'));assert.deepEqual(await channelRuntimeStatus(),{installed:true,ready:false});await assert.rejects(loadChannelLibrary());
});

test('provider state remains protected even outside the workspace data folder',async()=>{const state=path.join(root,'provider-state');process.env.AGENT_CONNECT_STATE_DIR=state;try{const {protectedDataDirs}=await import('../src/config/data-root.ts');assert.ok(protectedDataDirs().includes(state));}finally{delete process.env.AGENT_CONNECT_STATE_DIR;}});
