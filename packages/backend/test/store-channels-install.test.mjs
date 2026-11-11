import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash,randomBytes} from 'node:crypto';import {gzipSync} from 'node:zlib';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'store-channels-'));process.env.HOME=root;process.env.USERPROFILE=root;process.env.AGENT_PLAYER_DATA_DIR=path.join(root,'data');process.env.DATABASE_PATH=path.join(root,'data/db.sqlite');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.GIRRU_STORE_URL='https://store.test';delete process.env.GIRRU_CHANNELS_RUNTIME_DIR;
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
const {readStore,localCatalogue,installFromStore}=await import('../src/services/store-catalogue.ts');const {startAdd,removeApp,installedApps}=await import('../src/services/store-install.ts');
const sha=b=>createHash('sha256').update(b).digest('hex');
function tar(files){const blocks=[];for(const [name,body]of files){const data=Buffer.from(body),h=Buffer.alloc(512);h.write(name);h.write('0000644\0',100);h.write('0000000\0',108);h.write('0000000\0',116);h.write(data.length.toString(8).padStart(11,'0')+'\0',124);h.write('00000000000\0',136);h.write('        ',148);h.write('0',156);h.write('ustar\0',257);h.write('00',263);h.write([...h].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);blocks.push(h,data,Buffer.alloc((512-data.length%512)%512));}return gzipSync(Buffer.concat([...blocks,Buffer.alloc(1024)]));}
const archive=tar([['package/package.json',JSON.stringify({name:'agent-connect-dpro',version:'0.2.0'})],['package/dist/index.js','export const fixture=true;']]);
const runtimeUrl='https://registry.npmjs.org/agent-connect-dpro/-/agent-connect-dpro-0.2.0.tgz';
const files={'agentplayer.plugin.json':JSON.stringify({id:'agent-connect',name:'Agent Connect',version:'0.3.0',main:'index.js',type:'channel',permissions:['network','database','tools']}),'index.js':'export default {register(){}};','runtime-packages.npm':JSON.stringify({schema:1,packages:[{name:'agent-connect-dpro',version:'0.2.0',path:'node_modules/agent-connect-dpro',url:runtimeUrl,sha256:sha(archive),size:archive.length}]})};
const listing=Object.entries(files).map(([path,text])=>({path,sha256:sha(Buffer.from(text)),size:Buffer.byteLength(text)})).sort((a,b)=>a.path.localeCompare(b.path));
const index={schema:1,featured:null,collections:[],items:[{id:'agent-connect',kind:'app',name:'Agent Connect',summary:'Messaging channels.',description:'Adds the existing package.',icon:'message',maker:'Girru',version:'0.3.0',updated:'2026-11-05',category:'productivity',permissions:['Uses channel settings and history'],worksWith:[],languages:['English'],pricing:{model:'free'},package:{files:listing,sha256:sha(JSON.stringify(listing))}}]};
let tamper=false,gate=null;const originalFetch=globalThis.fetch;
globalThis.fetch=async url=>{if(url===runtimeUrl){if(gate)await gate;return {ok:true,status:200,body:(async function*(){yield tamper?Buffer.alloc(archive.length):archive;})()};}const text=String(url).endsWith('/index.json')?JSON.stringify(index):files[String(url).split('/package/')[1]];assert.equal(typeof text,'string');const b=Buffer.from(text);return {ok:true,status:200,text:async()=>text,arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.length)};};
test.after(()=>{globalThis.fetch=originalFetch;closeDatabase();fs.rmSync(root,{recursive:true,force:true});});
async function done(job){for(let i=0;i<400&&!job.done;i++)await new Promise(r=>setTimeout(r,5));assert.equal(job.done,true);return job;}
const config=JSON.stringify({channels:{telegram:{bot_token:'synthetic-channel-key',enabled:false,allowed_users:['synthetic-sender'],auto_reply:false}}});
db.prepare("INSERT INTO extension_configs(extension_id,config_json,enabled) VALUES('agent-connect',?,0)").run(config);db.exec('CREATE TABLE channel_events(id TEXT PRIMARY KEY,content TEXT);');db.prepare('INSERT INTO channel_events VALUES(?,?)').run('saved-event','synthetic history');
const row=()=>db.prepare("SELECT config_json,enabled FROM extension_configs WHERE extension_id='agent-connect'").get();
test('the displayed Store consent installs the package and preserves existing channel settings',async()=>{
 const item=(await readStore('owner',localCatalogue({home:root}))).items.find(x=>x.id==='store:agent-connect');assert.equal(item.state,'available');
 const bad=await installFromStore('owner',item.id,'0'.repeat(64));assert.equal(bad.ok,false);assert.equal(bad.code,'changed');
 const added=await installFromStore('owner',item.id,item.hash);assert.equal(added.ok,true);const {addJob}=await import('../src/services/store-install.ts');const job=await done(addJob(added.job));assert.equal(job.ok,true,job.message);
 assert.equal(row().config_json,config);assert.equal(row().enabled,0);assert.equal((await installedApps())['agent-connect'].name,'Agent Connect');assert.ok(fs.existsSync(path.join(root,'data/apps/agent-connect/node_modules/agent-connect-dpro/dist/index.js')));
});
test('a failed archive update leaves the installed app and configuration unchanged',async()=>{
 tamper=true;const job=await done(startAdd('agent-connect'));tamper=false;assert.equal(job.ok,false);assert.equal(row().config_json,config);assert.ok(fs.existsSync(path.join(root,'data/apps/agent-connect/index.js')));assert.ok((await installedApps())['agent-connect']);
});
test('an active install is shared and cannot be removed midway',async()=>{
 let release;gate=new Promise(r=>{release=r;});const first=startAdd('agent-connect'),second=startAdd('agent-connect');assert.equal(first.id,second.id);
 try{const result=await removeApp('agent-connect');assert.equal(result.ok,false);assert.equal(result.code,'refused');assert.equal(row().config_json,config);}finally{gate=null;release();}
 assert.equal((await done(first)).ok,true);
});
test('remove and re-add retain settings/history without activating a previously disabled channel',async()=>{
 const removed=await removeApp('agent-connect');assert.equal(removed.ok,true);assert.equal(row().config_json,config);assert.equal(row().enabled,0);assert.equal(db.prepare('SELECT content FROM channel_events WHERE id=?').get('saved-event').content,'synthetic history');assert.equal(fs.existsSync(path.join(root,'data/apps/agent-connect')),false);
 const job=await done(startAdd('agent-connect'));assert.equal(job.ok,true,job.message);assert.equal(row().config_json,config);assert.equal(JSON.parse(row().config_json).channels.telegram.enabled,false);assert.equal(db.prepare('SELECT count(*) AS n FROM channel_events').get().n,1);
});

test('failed atomic activation restores the previous program folder',async()=>{
 const rename=fs.renameSync;let failed=false;fs.renameSync=(from,to)=>{if(!failed&&String(from).includes('.incoming-agent-connect-')&&String(to).endsWith(path.join('apps','agent-connect'))){failed=true;throw Error('synthetic activation failure');}return rename(from,to);};
 try{const job=await done(startAdd('agent-connect'));assert.equal(job.ok,false);assert.equal(failed,true);assert.ok(fs.existsSync(path.join(root,'data/apps/agent-connect/index.js')));assert.equal(row().config_json,config);}finally{fs.renameSync=rename;}
});
