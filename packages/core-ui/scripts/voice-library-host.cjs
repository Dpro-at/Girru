'use strict';
const path=require('node:path'),os=require('node:os'),fs=require('node:fs/promises');
const {pathToFileURL}=require('node:url');
const {randomUUID}=require('node:crypto');
/** Owned GenVR voice library, reused without copying the owner's samples or model weights. */
function createVoiceLibrary({packageRoot,env=process.env,blocked=()=>false,portableService}={}){
 const directory=path.resolve(env.DPRO_GENVR_VOICES||path.join(os.homedir(),'.genvr/voices'));
 const portable=portableService||require('./portable-voice-host.cjs').createPortableVoice({packageRoot,env,blocked});
 const jobs=new Map();let service,pending,generatedSink,mutation=Promise.resolve();
 const prefsFile=path.join(directory,'girru-settings.json');
 const prefs=async()=>{try{return JSON.parse(await fs.readFile(prefsFile,'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw e;}};
 const updatePrefs=(owner,value)=>{const work=mutation.then(async()=>{const data=await prefs();data[owner]={...data[owner],...value};await fs.mkdir(directory,{recursive:true,mode:0o700});const temp=prefsFile+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(data),{mode:0o600,flag:'wx'});await fs.rename(temp,prefsFile);});mutation=work.catch(()=>{});return work;};
 const ensure=()=>pending??=(async()=>{const {createLocalVoice}=await import(pathToFileURL(path.join(packageRoot,'scripts/voice-engine/local-voice.mjs')).href);service=createLocalVoice({directory,python:require('./voice-runtime.cjs').voicePython(env),modelCache:path.resolve(env.DPRO_GENVR_VOICE_MODELS||path.join(os.homedir(),'.genvr/voice-models')),generated:async(a,sessionId,projectId)=>(sessionId||projectId)&&generatedSink?generatedSink(a,sessionId,projectId):({mime:'audio/wav',data:a.data})});return service;})();
 async function call(owner,input){
  if(!owner)throw Object.assign(Error('forbidden'),{code:'forbidden'});
  const voice=await ensure();
  if(!input){const [catalog,library,recordings,p,extra]=await Promise.all([voice.call({action:'models'}),voice.call({action:'voices'}),voice.call({action:'recordings'}),prefs(),portable.models()]);const engineId=p[owner]?.engineId??'';return {...catalog,models:[...catalog.models.map(m=>({...m,compatible:m.platforms.includes(process.platform+'-'+process.arch),runtimeAvailable:catalog.runtimeConfigured,defaultable:m.id==='chatterbox-multilingual-v3',features:m.voiceDesign?['Voice design from a description']:['Text to speech','Voice cloning'],note:'Apple Silicon MLX runtime.'})),...extra],voices:[...library.voices,...extra.flatMap(m=>portable.presets(m.id))],recordings:recordings.recordings,engineId,selectedVoiceId:p[owner]?.voiceId??library.assignments['girru:'+owner+':main']??'',readAloud:p[owner]?.readAloud??false,language:p[owner]?.language??'auto'};}
  if(input.action==='default_engine'){
   const state=await call(owner);const m=state.models.find(m=>m.id===input.model);if(!m?.compatible||!m.installed||!m.runtimeAvailable||!m.defaultable)throw Error('model_missing');
   const current=state.voices.find(v=>v.id===state.selectedVoiceId),matches=v=>input.model==='chatterbox-torch'?v.model==='chatterbox-multilingual-v3'||v.model===input.model:v.model===input.model;
   const selected=current&&matches(current)?current:undefined;
   await updatePrefs(owner,{engineId:input.model,voiceId:selected?.id??''});return {ok:true};
  }
  if(input.action==='assign'){
   const state=await call(owner),v=state.voices.find(v=>v.id===input.voiceId);if(!v)throw Error('invalid_voice');
   const model=v.model==='chatterbox-multilingual-v3'&&state.engineId==='chatterbox-torch'?'chatterbox-torch':v.model;
   const m=state.models.find(m=>m.id===model);if(!m?.installed||!m.runtimeAvailable||!m.compatible)throw Error('model_missing');
   if(v.authorization==='built-in'){await updatePrefs(owner,{engineId:model,voiceId:v.id});return {voiceId:v.id};}
   await voice.call({...input,projectId:'girru:'+owner,target:'main'});await updatePrefs(owner,{engineId:model,voiceId:v.id});return {voiceId:v.id};
  }
  if(input.action==='job'&&portable.has(input.jobId))return portable.job(owner,input.jobId);
  if(input.action==='audio'&&portable.has(input.audioId))return portable.audio(owner,input.audioId);
  if(['install','remove','install_runtime'].includes(input.action)&&portable.owns(input.model))return portable.start(owner,input);
  if(input.action==='speak'||input.action==='preview'){
   const state=await call(owner),v=state.voices.find(v=>v.id===input.voiceId);if(!v)throw Error('invalid_voice');
   const model=v.model==='chatterbox-multilingual-v3'&&state.engineId==='chatterbox-torch'?'chatterbox-torch':v.model;
   if(portable.owns(model)){
    let reference;if(v.authorization!=='built-in'){reference=await fs.realpath(path.join(directory,v.id+'.wav'));const parent=await fs.realpath(directory);if(!reference.startsWith(parent+path.sep))throw Error('invalid_reference');}
    const request={...input,action:'speak',model,text:input.text??(v.language==='en'?'Hello, I am ready to help you.':'مرحبا، أنا جاهز أساعدك.'),language:input.language??v.language??'en'};
    if((await voice.call({action:'models'})).busy)throw Error('voice_busy');return portable.start(owner,request,reference);
   }
  }
  if(input.action==='preferences'){await updatePrefs(owner,{readAloud:input.readAloud,language:input.language});return {ok:true};}
  if(input.action==='job'&&jobs.get(input.jobId)!==owner)throw Object.assign(Error('forbidden'),{code:'forbidden'});
  if(['design','speak','install','remove','prepare_previews','preview_demo'].includes(input.action)&&blocked())throw Object.assign(Error('voice_busy'),{code:'voice_busy'});
  if(portable.isBusy()&&['design','speak','install','remove','prepare_previews','preview_demo'].includes(input.action))throw Error('voice_busy');
  const args={...input,...(input.action==='assign'?{projectId:'girru:'+owner,target:'main'}:{}),...(input.action==='speak'?{preview:false}:{} )};
  if(input.action==='preview_demo')args.model='chatterbox-multilingual-v3';
  const result=await voice.call(args);
  if(result?.id&&result.status==='running'){if(jobs.size>=50)jobs.delete(jobs.keys().next().value);jobs.set(result.id,owner);}
  return result;
 }
 async function chatCall(owner,input,legacy){
  if(input&&['job','cancel'].includes(input.action)&&portable.has(input.id)){if(input.action==='cancel')return portable.cancel(owner,input.id);const j=portable.job(owner,input.id);return {id:j.id,status:j.status==='running'?'working':j.status,...(j.status==='done'?{audio:portable.audio(owner,input.id).data}:{})};}
  const state=await call(owner),m=state.models.find(m=>m.id===state.engineId);
  const voices=state.voices.filter(v=>v.authorization==='built-in'||v.authorization==='synthetic-design'||v.authorization==='publisher-demo'||v.consentAt).filter(v=>v.model===state.engineId||(state.engineId==='chatterbox-torch'&&v.model==='chatterbox-multilingual-v3'));
  if(!input)return {available:!!m?.compatible&&m.installed&&m.runtimeAvailable,voices,selectedVoiceId:state.selectedVoiceId,readAloud:state.readAloud,language:state.language,languages:m?.languages??[]};
  if(input.action==='speak'&&!state.engineId)throw Error('voice_not_selected');
  if(input.action==='speak'&&portable.owns(state.engineId)){if(!voices.some(v=>v.id===input.voiceId))throw Error('invalid_voice');const j=await call(owner,{...input,action:'speak'});return {id:j.id,status:j.status==='running'?'working':j.status};}
  return legacy.call(owner,input);
 }
 return {call,chatCall,shared(generated){generatedSink=generated;return ensure();},async isBusy(){if(!service)return false;return portable.isBusy()||(await service.call({action:'models'})).busy===true;},close(){portable.close();service?.close();jobs.clear();}};
}
module.exports={createVoiceLibrary};
