import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'girru-full-browser-store-'));process.env.HOME=temp;process.env.AGENT_PLAYER_DATA_DIR=path.join(temp,'data');process.env.GIRRU_APP_RUNTIMES_DIR=path.join(temp,'runtimes');process.env.GIRRU_STORE_URL='http://127.0.0.1:44999';
const {installBrowserWorkspace,installedBrowserWorkspace,browserWorkspaceReviewHash}=await import('../src/services/browser-workspace-runtime.ts');
const {resolveBrowserRuntime}=await import('../../desktop/src/browser-runtime-path.cjs');
function offer(version='1.0.0',complete=true){const input=fs.mkdtempSync(path.join(temp,'input-')),files=['runtime/scripts/full-start.cjs','runtime/src/full-browser.cjs','runtime/node_modules/ws/package.json','runtime/node_modules/playwright/package.json','extension/manifest.json','native/GirruBrowser.app/Contents/MacOS/GirruBrowser'];
 for(const file of files){if(!complete&&file.includes('native/'))continue;const target=path.join(input,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'synthetic');}
 fs.writeFileSync(path.join(input,'runtime/package.json'),JSON.stringify({name:'@girru/browser'}));fs.writeFileSync(path.join(input,'browser-runtime.json'),JSON.stringify({protocolVersion:1,version,platform:'darwin-arm64'}));
 const archive=path.join(temp,'archive-'+version+'-'+Math.random()+'.tgz');execFileSync('/usr/bin/tar',['-czf',archive,'-C',input,...fs.readdirSync(input)],{env:{...process.env,COPYFILE_DISABLE:'1'}});const bytes=fs.readFileSync(archive);const runtime={version,protocolVersion:1,archives:{'darwin-arm64':{url:'http://127.0.0.1:44999/browser.tgz',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}}};return{runtime,bytes};}
const job=()=>({id:'synthetic',app:'browser',step:'getting',done:false});
test('full Browser store archive installs and is immediately discoverable by the desktop without source overrides',async()=>{
 if(process.platform!=='darwin'||process.arch!=='arm64')return;
 const fixture=offer();await installBrowserWorkspace(job(),fixture.runtime,async()=>({ok:true,status:200,body:(async function*(){yield fixture.bytes;})()}));
 assert.equal(installedBrowserWorkspace().version,'1.0.0');assert.equal(resolveBrowserRuntime({runtimesDir:process.env.GIRRU_APP_RUNTIMES_DIR}).source,'store');
 const prior=fs.readFileSync(path.join(process.env.GIRRU_APP_RUNTIMES_DIR,'browser/current.json'),'utf8');
 const incomplete=offer('1.0.1',false);await assert.rejects(installBrowserWorkspace(job(),incomplete.runtime,async()=>({ok:true,status:200,body:(async function*(){yield incomplete.bytes;})()})));assert.equal(fs.readFileSync(path.join(process.env.GIRRU_APP_RUNTIMES_DIR,'browser/current.json'),'utf8'),prior);
 const bad=offer('1.0.2');bad.runtime.archives['darwin-arm64'].sha256='0'.repeat(64);await assert.rejects(installBrowserWorkspace(job(),bad.runtime,async()=>({ok:true,status:200,body:(async function*(){yield bad.bytes;})()})));assert.equal(fs.readFileSync(path.join(process.env.GIRRU_APP_RUNTIMES_DIR,'browser/current.json'),'utf8'),prior);
});
test('Browser review binds archive identity even when the visible version is unchanged',()=>{const item={id:'store:browser',version:'1.0.0',permissions:['Owner browser']},a=offer().runtime,b=structuredClone(a);b.archives['darwin-arm64'].sha256='f'.repeat(64);assert.notEqual(browserWorkspaceReviewHash(item,a),browserWorkspaceReviewHash(item,b));});
test.after(()=>fs.rmSync(temp,{recursive:true,force:true}));

test('Store Get installs the reviewed package plus full workspace, then desktop discovery succeeds while agent automation stays off',async()=>{
 if(process.platform!=='darwin'||process.arch!=='arm64')return;
 const fixture=offer('1.0.3'),version=fixture.runtime.version,hash=b=>createHash('sha256').update(b).digest('hex');
 const payload={'agentplayer.plugin.json':Buffer.from(JSON.stringify({id:'browser',version,main:'index.js',name:'Browser'})),'index.js':Buffer.from('export default {};'),'app-host.npm':Buffer.from(JSON.stringify({schema:1,host:'browser',protocolVersion:1}))};
 const files=Object.entries(payload).map(([path,bytes])=>({path,size:bytes.length,sha256:hash(bytes)}));
 const item={id:'girru:browser',kind:'app',source:'girru',name:'Browser',summary:'Synthetic full Browser',description:'Temporary acceptance',icon:'globe',maker:'Girru',version,updated:'2026-11-07',category:'productivity',permissions:['Owner workspace; agent tools require separate grants'],worksWith:[],languages:['English']};
 const repo={index:{schema:1,featured:null,collections:[],items:[item]},packages:{'girru:browser':{files,sha256:hash(JSON.stringify(files))}},runtimes:{'girru:browser':fixture.runtime},asOf:new Date().toISOString(),fresh:true};
 process.env.JWT_SECRET='synthetic-browser-store-jwt-key-'.repeat(3);process.env.NODE_ENV='test';
 const {getDatabase}=await import('../src/db/database.ts');const database=getDatabase();await database.initialize();
 const {readStore,localCatalogue,installFromStore}=await import('../src/services/store-catalogue.ts'),{addJob}=await import('../src/services/store-install.ts');
 const previousFetch=globalThis.fetch;let requests=0;globalThis.fetch=async url=>{requests++;const bytes=payload[String(url).split('/').at(-1)];if(!bytes)throw Error('Unexpected network in synthetic Store');return{ok:true,status:200,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length)};};
 try{
  const source=()=>localCatalogue({home:temp,repo:async()=>repo});const before=(await readStore('synthetic-owner',source())).items.find(x=>x.id==='store:browser');assert.equal(before.state,'available');
  assert.equal((await installFromStore('synthetic-owner','store:browser','0'.repeat(64),{repo:async()=>repo})).code,'changed');assert.equal(requests,0);
  const result=await installFromStore('synthetic-owner','store:browser',before.hash,{repo:async()=>repo,fetch:async()=>({ok:true,status:200,body:(async function*(){yield fixture.bytes;})()})});assert.equal(result.ok,true);
  const end=Date.now()+10000;while(!addJob(result.job).done&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.equal(addJob(result.job).ok,true,addJob(result.job).message);
  const after=(await readStore('synthetic-owner',source())).items.find(x=>x.id==='store:browser');assert.equal(after.state,'installed');assert.equal(resolveBrowserRuntime({runtimesDir:process.env.GIRRU_APP_RUNTIMES_DIR}).version,version);
  assert.equal(database.getDb().prepare("SELECT enabled FROM extension_configs WHERE extension_id='browser'").get().enabled,0);
 }finally{globalThis.fetch=previousFetch;database.close();}
});
