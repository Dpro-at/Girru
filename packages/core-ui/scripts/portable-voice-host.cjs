'use strict';
const fs=require('node:fs/promises'),sync=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process'),{randomUUID}=require('node:crypto');
const catalogue=require('./portable-voice-models.json');
function createPortableVoice({packageRoot,env=process.env,blocked=()=>false}={}){
 const root=path.resolve(env.DPRO_PORTABLE_VOICES||path.join(os.homedir(),'.genvr/portable-voices')),worker=path.join(packageRoot,'scripts/portable-voice-worker.py');
 const jobs=new Map();let busy=false,child;
 const pythonFor=id=>path.join(root,id,'runtime',process.platform==='win32'?'Scripts/python.exe':'bin/python');
 const basePython=()=>require('./voice-runtime.cjs').voicePython(env)||((env.PATH||'').split(path.delimiter).flatMap(p=>['python3','python.exe','python'].map(n=>path.resolve(p,n))).find(p=>sync.existsSync(p)));
 const manifest=async(file)=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch{return null;}};
 const exists=f=>fs.stat(f).then(s=>s.isFile()).catch(()=>false);
 async function models(){return Promise.all(catalogue.map(async m=>{const python=pythonFor(m.id),runtime=JSON.stringify((await manifest(path.join(root,m.id,'runtime-ready.json')))?.packages)===JSON.stringify(m.packages)&&await exists(python),installed=(await manifest(path.join(root,m.id,'model-ready.json')))?.revision===m.revision&&(await Promise.all(m.files.map(async f=>{try{return (await fs.stat(path.join(root,m.id,'model',f.path))).size===f.size;}catch{return false;}}))).every(Boolean);return {...m,platform:'macOS / Windows / Linux',compatible:m.platforms.includes(process.platform+'-'+process.arch),runtimeAvailable:runtime,runtimeInstallAvailable:!!basePython(),installed,defaultable:true};}));}
 const presets=(engine)=>{
  if(engine==='chatterbox-torch')return [{id:'chatterbox-default',name:'Chatterbox · Default voice',language:'ar',model:engine,authorization:'built-in'}];
  if(engine==='kitten-nano')return [2,3,4,5].flatMap(i=>['m','f'].map(g=>({id:`kitten-expr-voice-${i}-${g}`,name:`Kitten ${i} · ${g==='m'?'Man':'Woman'}`,language:'en',model:engine,authorization:'built-in',description:'English CPU voice. No cloning.'})));
  if(engine==='supertonic-3')return ['m','f'].flatMap(g=>[1,2,3,4,5].map(i=>({id:`supertonic-${g}${i}`,name:`Supertonic · ${g.toUpperCase()}${i}`,language:'ar',model:engine,authorization:'built-in',description:'Multilingual CPU voice. Choose the speech language in Settings.'})));
  if(engine==='piper-voices')return [{id:'piper-ar-kareem',name:'Piper · Kareem',language:'ar',model:engine,authorization:'built-in'},{id:'piper-en-lessac',name:'Piper · Lessac',language:'en',model:engine,authorization:'built-in'}];
  return [];
 };
 async function invoke(python,args){return new Promise((resolve,reject)=>{child=spawn(python,[worker],{env:{...env,HF_HUB_DISABLE_TELEMETRY:'1'},stdio:['pipe','pipe','pipe']});let out='',err='';const c=child,timer=setTimeout(()=>{c.kill('SIGKILL');reject(Error('timeout'));},args.action==='runtime'||args.action==='download'?1800000:300000);c.stdout.on('data',v=>{out=(out+v).slice(-16384);});c.stderr.on('data',v=>{err=(err+v).slice(-2000);});c.once('error',e=>{clearTimeout(timer);reject(e);});c.once('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error(err.includes('disk_space')?'disk_space':err.includes('language_unsupported')?'language_unsupported':'voice_failed'));try{resolve(JSON.parse(out.trim().split('\n').at(-1)));}catch{reject(Error('voice_failed'));}});c.stdin.on('error',()=>{});c.stdin.end(JSON.stringify({...args,root})+'\n');});}
 async function start(owner,input,reference){
  if(busy||blocked())throw Object.assign(Error('voice_busy'),{code:'voice_busy'});
  const m=catalogue.find(m=>m.id===input.model);if(!m||!m.platforms.includes(process.platform+'-'+process.arch))throw Error('unsupported_platform');
  busy=true;let info,action,python;try{info=(await models()).find(v=>v.id===m.id);action=input.action==='install'?'download':input.action==='install_runtime'?'runtime':input.action;
  if(action!=='runtime'&&!info.runtimeAvailable)throw Error('runtime_missing');
  if(action==='speak'&&!info.installed)throw Error('model_missing');
  python=action==='runtime'?basePython():pythonFor(m.id);if(!python)throw Error('runtime_missing');}catch(e){busy=false;throw e;}
  busy=true;while(jobs.size>=30)jobs.delete(jobs.keys().next().value);const j={id:randomUUID(),owner,status:'running'};jobs.set(j.id,j);
  void(async()=>{let temp;try{let request={action,engine:m.id};if(action==='speak'){temp=await fs.mkdtemp(path.join(os.tmpdir(),'girru-portable-speech-'));request={...request,text:input.text,language:input.language,voice:input.voiceId,output:path.join(temp,'speech.wav'),...(reference?{reference}:{})};}const result=await invoke(python,request);if(j.cancelled)return;if(action==='speak'){const bytes=await fs.readFile(request.output);if(bytes.length>8*1024*1024)throw Error('audio_limit');j.audio=bytes.toString('base64');j.result={audioId:j.id,duration:result.duration};}else j.result=result;j.status='done';}catch(e){j.status='failed';j.errorCode=['disk_space','language_unsupported'].includes(e.message)?e.message:'voice_failed';}finally{busy=false;child=null;if(temp)await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});}})();return {id:j.id,status:j.status};
 }
 function job(owner,id){const j=jobs.get(id);if(!j||j.owner!==owner)throw Object.assign(Error('forbidden'),{code:'forbidden'});return {id:j.id,status:j.status,result:j.result,errorCode:j.errorCode};}
 function audio(owner,id){const j=jobs.get(id);if(!j||j.owner!==owner||j.status!=='done'||!j.audio)throw Error('not_found');return {mime:'audio/wav',data:j.audio};}
 function cancel(owner,id){const j=jobs.get(id);if(!j||j.owner!==owner)throw Error('forbidden');if(j.status==='running'){j.cancelled=true;j.status='failed';child?.kill('SIGTERM');}return {id,status:'cancelled'};}
 return {models,presets,start,job,audio,cancel,has:id=>jobs.has(id),owns:id=>catalogue.some(m=>m.id===id),isBusy:()=>busy,close(){child?.kill('SIGTERM');jobs.clear();}};
}
module.exports={createPortableVoice,catalogue};
