require('./load.cjs');
const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {allowedChatVoice,chatVoiceResponse,CHAT_VOICE_PATH}=require('../src/chat-voice-contract.js');
const {allowed}=require('../scripts/application-server.cjs');
const {createChatVoice}=require('../scripts/chat-voice-host.cjs');
const id='00000000-0000-4000-8000-000000000001';
test('voice protocol rejects paths, download/clone actions and unbounded text',()=>{
 for(const body of [{action:'install'},{action:'speak',text:'hello',language:'ar',voiceId:'../../key'},{action:'speak',text:'x'.repeat(601),language:'ar',voiceId:id},{action:'speak',text:'hi',language:'ar',voiceId:id,reference:'/tmp/private'},{action:'job',id:'bad'}]){assert.equal(allowedChatVoice('POST',CHAT_VOICE_PATH,body),false);assert.equal(allowed('POST',CHAT_VOICE_PATH,body),false);}
 assert.equal(allowed('POST',CHAT_VOICE_PATH,{action:'speak',text:'hello',language:'en',voiceId:id}),true);
 assert.deepEqual(chatVoiceResponse(503,{code:'voice_failed',error:'/private/secret'}),{code:'voice_failed'});
});
test('voice jobs are owner-bound, serialized and cancel before playback; original library stays untouched',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'girru-voice-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const directory=path.join(root,'voices');await fs.mkdir(directory);await fs.mkdir(path.join(root,'scripts'));await fs.writeFile(path.join(root,'scripts/chat-voice-worker.py'),'fixture');
 await fs.writeFile(path.join(directory,'chatterbox-multilingual-v3.installed.json'),'{}');
 const original=JSON.stringify({voices:[{id,name:'Synthetic',language:'ar',model:'chatterbox-multilingual-v3',authorization:'synthetic-design'},{id:'11111111-1111-4111-8111-111111111111',name:'No consent',language:'ar',model:'chatterbox-multilingual-v3'}]});
 await fs.writeFile(path.join(directory,'library.json'),original);await fs.writeFile(path.join(directory,id+'.wav'),'reference');
 let child,options;
 const {EventEmitter}=require('node:events');
 const service=createChatVoice({packageRoot:root,env:{DPRO_GENVR_VOICES:directory,GENVR_VOICE_PYTHON:process.execPath},spawnWorker:(file,args,opts)=>{options=opts;child=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=()=>{};child.kill=()=>{setImmediate(()=>child.emit('close',1));};return child;}});t.after(()=>service.close());
 assert.equal((await service.call('a')).voices.length,1);
 const body={action:'speak',text:'مرحبا',language:'ar',voiceId:id};const j=await service.call('a',body);
 await new Promise(r=>setTimeout(r,15));assert.equal(options.env.HF_HUB_OFFLINE,'1');
 await assert.rejects(service.call('b',{action:'job',id:j.id}),e=>e.code==='forbidden');
 await assert.rejects(service.call('a',body),e=>e.code==='voice_busy');
 assert.equal((await service.call('a',{action:'cancel',id:j.id})).status,'cancelled');
 await new Promise(r=>setTimeout(r,15));assert.equal((await service.call('a',{action:'job',id:j.id})).audio,undefined);
 assert.equal(await fs.readFile(path.join(directory,'library.json'),'utf8'),original);
});
test('HTTP voice endpoint requires an authenticated owner and does not proxy worker requests',async t=>{
 const http=require('node:http'),{createApplicationServer}=require('../scripts/application-server.cjs');
 const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));
 let role='member',calls=[];
 const upstream=http.createServer((req,res)=>{calls.push(req.url);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({user:{id:'user-1',role}}));});const port=await listen(upstream);
 const app=createApplicationServer({channel:'candidate',upstreamPort:port});const appPort=await listen(app);t.after(()=>{app.close();app.closeAllConnections();upstream.close();upstream.closeAllConnections();});
 const get=(auth)=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:appPort,path:CHAT_VOICE_PATH,headers:auth?{Authorization:'Bearer fixture-token'}:{}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.end();});
 assert.equal((await get(false)).status,401);
 assert.equal((await get(true)).status,403);
 role='owner';const r=await get(true);assert.equal(r.status,200);assert.ok(Array.isArray(r.body.voices));assert.ok(calls.every(p=>p==='/api/auth/me'));

});

test('a completed live reply and its saved message have one speech identity',()=>{
 const {voiceTurnKey}=require('../src/chat-voice-contract.js');
 assert.equal(voiceTurnKey({role:'assistant',key:'run:one',runId:'one'}),voiceTurnKey({role:'assistant',key:'saved-message',runId:'one'}));
 assert.notEqual(voiceTurnKey({role:'user',key:'user',runId:'one'}),voiceTurnKey({role:'assistant',key:'reply',runId:'one'}));
});

test('opening history is silent; only a newly observed live reply is read exactly once',()=>{
 const {takeVoiceReply}=require('../src/chat-voice-contract.js');const seen=new Set(),pending=new Set();
 const turn={role:'assistant',status:'complete',runId:'old',key:'saved-old'};
 assert.equal(takeVoiceReply(turn,seen,pending,true),false);
 assert.equal(takeVoiceReply({...turn,status:'running',runId:'new',key:'run:new'},seen,pending,true),false);
 assert.equal(takeVoiceReply({...turn,runId:'new',key:'run:new'},seen,pending,true),true);
 assert.equal(takeVoiceReply({...turn,runId:'new',key:'saved-new'},seen,pending,true),false);
 assert.equal(takeVoiceReply({...turn,status:'running',runId:'off',key:'run:off'},seen,pending,false),false);
 assert.equal(takeVoiceReply({...turn,runId:'off',key:'saved-off'},seen,pending,true),false);
});
