require('./load.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {allowedVoiceLibrary,VOICE_LIBRARY_PATH,voiceLibraryResponse}=require('../src/voice-library-contract.js');
const {allowed}=require('../scripts/application-server.cjs');
const {allowedRequest}=require('../src/session.ts');
const {createVoiceLibrary}=require('../scripts/voice-library-host.cjs');
const id='00000000-0000-4000-8000-000000000001';
test('voice management schema requires explicit consent and confirmed model operations; blocks URLs and executable paths',()=>{
 const cases=[{action:'clone',audio:'AAAA',name:'Mine',language:'ar',consent:false},{action:'install',model:'chatterbox-multilingual-v3',confirm:false},{action:'remove',model:'unknown',confirm:true},{action:'preview_demo',demoId:'ar',confirm:true,url:'https://example.invalid/key'},{action:'assign',voiceId:id,projectId:'other'},{action:'preferences',readAloud:true,language:'auto',python:'/tmp/evil'}];
 for(const b of cases){assert.equal(allowedVoiceLibrary('POST',VOICE_LIBRARY_PATH,b),false);assert.equal(allowed('POST',VOICE_LIBRARY_PATH,b),false);assert.equal(allowedRequest('POST',VOICE_LIBRARY_PATH,b),false);}
 assert.equal(allowedVoiceLibrary('POST',VOICE_LIBRARY_PATH,{action:'clone',audio:'AAAA',name:'Mine',language:'ar',consent:true}),true);
 assert.deepEqual(voiceLibraryResponse(503,{code:'voice_failed',error:'/private/path'}),{code:'voice_failed'});
});
test('transferred library persists named synthetic voices, per-owner Main Agent assignment and preferences without model downloads',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'girru-voice-library-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const library={voices:[{id,name:'Saved name',language:'ar',model:'chatterbox-multilingual-v3',authorization:'synthetic-design'}],assignments:{'original-avatar:self':id}};
 await fs.writeFile(path.join(directory,'library.json'),JSON.stringify(library));
 await fs.writeFile(path.join(directory,'chatterbox-multilingual-v3.installed.json'),'{}');
 const python=path.join(directory,'python');await fs.writeFile(python,'fixture');
 const host=createVoiceLibrary({packageRoot:path.resolve(__dirname,'..'),env:{DPRO_GENVR_VOICES:directory,DPRO_VOICE_PYTHON:python,DPRO_GENVR_STATE:directory}});t.after(()=>host.close());
 let status=await host.call('owner-a');assert.equal(status.voices[0].name,'Saved name');assert.equal(status.selectedVoiceId,'');assert.equal(status.models.length,6);assert.ok(status.demos.length>20);
 await host.call('owner-a',{action:'assign',voiceId:id});await host.call('owner-a',{action:'preferences',readAloud:true,language:'ar'});
 assert.equal((await host.call('owner-a')).selectedVoiceId,id);assert.equal((await host.call('owner-b')).selectedVoiceId,'');
 const persisted=JSON.parse(await fs.readFile(path.join(directory,'library.json'),'utf8'));assert.equal(persisted.assignments['original-avatar:self'],id);
 const restarted=createVoiceLibrary({packageRoot:path.resolve(__dirname,'..'),env:{DPRO_GENVR_VOICES:directory}});t.after(()=>restarted.close());status=await restarted.call('owner-a');assert.equal(status.readAloud,true);assert.equal(status.language,'ar');assert.equal(status.selectedVoiceId,id);
 await assert.rejects(host.call('owner-b',{action:'job',jobId:id}),e=>e.code==='forbidden');
});
test('clone stores only valid PCM samples with consent metadata and a chosen name',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'girru-voice-clone-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const host=createVoiceLibrary({packageRoot:path.resolve(__dirname,'..'),env:{DPRO_GENVR_VOICES:directory}});t.after(()=>host.close());
 const wav=Buffer.alloc(44+16000*2*3);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVE',8);wav.write('fmt ',12);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
 const sample={action:'clone',name:'Authorized fixture',language:'ar',audio:wav.toString('base64'),consent:true};
 await assert.rejects(host.call('owner',{...sample,consent:false}));const voice=await host.call('owner',sample);assert.equal(voice.name,'Authorized fixture');assert.ok(voice.consentAt);assert.equal((await host.call('owner')).voices.filter(v=>v.id===voice.id).length,1);
 const playback=await host.call('owner',{action:'preview',voiceId:voice.id});assert.deepEqual(Buffer.from(playback.data,'base64'),wav);
});

test('explicit Windows Python runtime survives a later launch without environment overrides',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'girru-voice-runtime-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const python=path.join(directory,'python.exe');await fs.writeFile(python,'fixture');
 const {voicePython}=require('../scripts/voice-runtime.cjs');
 assert.equal(voicePython({DPRO_GENVR_STATE:directory,DPRO_VOICE_PYTHON:python}),python);
 assert.equal(voicePython({DPRO_GENVR_STATE:directory}),python);
 assert.equal(voicePython({DPRO_GENVR_STATE:directory,DPRO_VOICE_PYTHON:path.join(directory,'unknown.exe')}),undefined);
});
