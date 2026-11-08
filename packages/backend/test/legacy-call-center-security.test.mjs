import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{transformSync}=require('esbuild');
const root=path.join(import.meta.dirname,'fixtures/legacy-apps/extensions/call-center');
function load(file,dependencies){const module={exports:{}};const code=transformSync(fs.readFileSync(path.join(root,file),'utf8'),{loader:'js',format:'cjs',target:'node24'}).code;vm.runInNewContext(code,{module,exports:module.exports,require:name=>{if(Object.hasOwn(dependencies,name))return dependencies[name];throw Error('Unexpected dependency: '+name);},Buffer,URLSearchParams,process:{env:{BACKEND_URL:'https://example.invalid'}},console:{error(){}}},{filename:file});return module.exports;}
test('legacy STT accepts bounded uploaded bytes and refuses filesystem paths before any provider call',async()=>{
 const stt=load('services/stt-service.js',{'form-data':class{},'../config/stt-providers.js':{getProvider:()=>({requiresApiKey:true})}});let calls=0;
 stt.transcribeOpenAI=async({audioBuffer})=>{calls++;assert.ok(Buffer.isBuffer(audioBuffer));return {text:'Synthetic audio'};};
 for(const audio of ['/etc/passwd','file:///tmp/sample.wav',{},new Uint8Array([1]),Buffer.alloc(0),Buffer.alloc(25*1024*1024+1)])await assert.rejects(()=>stt.transcribe({audio,provider:'openai',apiKey:'synthetic'}),/uploaded bytes/);
 assert.equal(calls,0);assert.equal((await stt.transcribe({audio:Buffer.from([1,2]),provider:'openai',apiKey:'synthetic'})).text,'Synthetic audio');assert.equal(calls,1);
});
function routes(campaign){const handlers=new Map(),router={post:(url,fn)=>handlers.set(url,fn)};const contact={campaign_id:'campaign',name:'<img src=x onerror=alert(1)>',custom_data:JSON.stringify({note:'<script>alert(2)</script>'})};
 load('routes/campaign-webhooks.js',{express:{Router:()=>router},'../../../../../../src/db/index.js':{getDatabase:()=>({get:async sql=>sql.includes('campaign_contacts')?contact:campaign})},'../services/campaign-manager.js':{getCampaignManager:()=>({updateContactResult:async()=>{}})}});return handlers;}
async function invoke(handler,body={}){let output='',type='';const res={status(){return this;},type(t){type=t;return this;},send(v){output=v;return this;}};await handler({params:{contactId:'contact"><svg onload=alert(3)>'},body},res);return {output,type};}
test('legacy IVR and AI campaign XML encode messages, labels and callback path segments',async()=>{
 for(const response_mode of ['ivr','ai']){const r=routes({message_template:'Hello {name} {note}',response_mode,ivr_options:JSON.stringify([{digit:'1',label:'<script>alert(4)</script>',action:'custom'}])});const {output,type}=await invoke(r.get('/campaign-webhook/:contactId'));
 assert.equal(type,'text/xml');assert.ok(output.includes('&lt;img'));assert.ok(output.includes('&lt;script'));assert.doesNotMatch(output,/<img|<script|<svg/);assert.ok(output.includes('contact%22%3E%3Csvg%20onload%3Dalert(3)%3E'));}
});
test('legacy campaign response encodes a custom IVR label before XML rendering',async()=>{
 const r=routes({ivr_options:JSON.stringify([{digit:'1',label:'<script>alert(1)</script>',action:'custom'}])});const {output}=await invoke(r.get('/campaign-response/:contactId'),{Digits:'1'});assert.ok(output.includes('&lt;script&gt;'));assert.doesNotMatch(output,/<script>/);
});
