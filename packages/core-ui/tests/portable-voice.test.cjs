require('./load.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {catalogue,createPortableVoice}=require('../scripts/portable-voice-host.cjs');
const {createVoiceLibrary}=require('../scripts/voice-library-host.cjs');
const {allowedVoiceLibrary,VOICE_LIBRARY_PATH,voiceLibraryResponse}=require('../src/voice-library-contract.js');
test('portable engines have fixed revisions, bounded files, honest features and Windows/macOS CPU targets',()=>{
 assert.equal(catalogue.length,4);
 for(const m of catalogue){assert.match(m.revision,/^[a-f0-9]{40}$/);assert.ok(m.platforms.includes('win32-x64'));assert.ok(m.platforms.includes('darwin-arm64'));assert.equal(m.downloadBytes,m.files.reduce((n,f)=>n+f.size,0));for(const f of m.files){assert.ok(!f.path.includes('..'));assert.ok(f.sha256?/^[a-f0-9]{64}$/.test(f.sha256):/^[a-f0-9]{40}$/.test(f.git));}}
 const kitten=catalogue.find(m=>m.id==='kitten-nano');assert.deepEqual(kitten.languages,['en']);assert.ok(kitten.downloadBytes<25e6);
 assert.ok(catalogue.find(m=>m.id==='supertonic-3').note.includes('archived'));
 assert.equal(allowedVoiceLibrary('POST',VOICE_LIBRARY_PATH,{action:'install_runtime',model:'supertonic-3',confirm:true}),true);
 for(const b of [{action:'default_engine',model:'arbitrary'},{action:'install_runtime',model:'piper-voices',confirm:false},{action:'install_runtime',model:'kitten-nano',confirm:true,package:'evil'}])assert.equal(allowedVoiceLibrary('POST',VOICE_LIBRARY_PATH,b),false);
 const projected=voiceLibraryResponse(200,{models:catalogue.map(m=>({...m,runtimeAvailable:false,compatible:true})),voices:[],engineId:'supertonic-3'});assert.equal(projected.models.length,4);assert.ok(!JSON.stringify(projected).includes('packages'));
});
test('default engine persists separately, rejects missing engines and routes chat to the selected portable provider',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'girru-default-engine-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const calls=[];let ready=true;
 const portable={models:async()=>[{id:'supertonic-3',name:'Fixture',installed:ready,runtimeAvailable:true,compatible:true,defaultable:true,languages:['ar'],features:[]}],presets:()=>[{id:'supertonic-m1',name:'Fixture voice',language:'ar',model:'supertonic-3',authorization:'built-in'}],isBusy:()=>false,owns:id=>id==='supertonic-3',has:id=>id==='00000000-0000-4000-8000-000000000001',start:async(owner,input)=>{calls.push({owner,input});return {id:'00000000-0000-4000-8000-000000000001',status:'running'};},job:(owner)=>({id:'00000000-0000-4000-8000-000000000001',status:owner==='owner'?'done':'failed'}),audio:()=>({data:'UklGRg=='}),close(){}};
 const options={packageRoot:path.resolve(__dirname,'..'),env:{DPRO_GENVR_VOICES:directory},portableService:portable};
 const host=createVoiceLibrary(options);t.after(()=>host.close());
 const initial=await host.call('owner');assert.equal(initial.engineId,'');assert.equal(initial.selectedVoiceId,'');assert.equal(calls.length,0);
 const unselected=await host.chatCall('owner',undefined,{call(){throw Error('Unexpected legacy fallback');}});assert.equal(unselected.available,false);assert.deepEqual(unselected.voices,[]);
 await assert.rejects(host.chatCall('owner',{action:'speak',voiceId:'supertonic-m1',text:'Hello',language:'en'},{call(){throw Error('Unexpected legacy fallback');}}),/voice_not_selected/);
 assert.equal(voiceLibraryResponse(200,{models:[],voices:[]}).engineId,'');
 await host.call('owner',{action:'default_engine',model:'supertonic-3'});assert.equal((await host.call('owner')).selectedVoiceId,'');assert.equal(calls.length,0);await host.call('owner',{action:'assign',voiceId:'supertonic-m1'});await host.call('owner',{action:'preferences',readAloud:true,language:'auto'});
 const restarted=createVoiceLibrary(options);t.after(()=>restarted.close());const status=await restarted.call('owner');assert.equal(status.engineId,'supertonic-3');assert.equal(status.selectedVoiceId,'supertonic-m1');assert.equal(status.readAloud,true);
 assert.notEqual((await restarted.call('other')).engineId,'supertonic-3');
 const legacy={call(){throw Error('Wrong provider');}};const chat=await restarted.chatCall('owner',undefined,legacy);assert.equal(chat.available,true);assert.equal(chat.voices[0].id,'supertonic-m1');
 assert.equal((await restarted.chatCall('owner',{action:'speak',text:'مرحبا',language:'ar',voiceId:'supertonic-m1'},legacy)).status,'working');assert.equal(calls.length,1);assert.equal(calls[0].input.model,'supertonic-3');
 assert.equal((await restarted.chatCall('owner',{action:'job',id:'00000000-0000-4000-8000-000000000001'},legacy)).audio,'UklGRg==');
 ready=false;await assert.rejects(restarted.call('owner',{action:'default_engine',model:'supertonic-3'}));
});
