export const VOICE_LIBRARY_PATH='/api/settings/voice';
export const VOICE_LANGUAGES=['ar','da','de','el','en','es','fi','fr','he','hi','it','ja','ko','ms','nl','no','pl','pt','ru','sv','sw','tr','zh','bg','hr','cs','et','hu','id','lv','lt','ro','sk','uk','vi'];
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=v=>typeof v==='string'&&/^[a-z0-9-]{1,80}$/.test(v);
const text=(v,max)=>typeof v==='string'&&!!v.trim()&&v.length<=max;
const exact=(b,keys)=>Object.keys(b).sort().join(',')===keys.split(',').sort().join(',');
export function allowedVoiceLibrary(method,path,b){
 if(path!==VOICE_LIBRARY_PATH)return false;
 if(method==='GET')return b===undefined;
 if(method!=='POST'||!object(b))return false;
 switch(b.action){
 case 'design':return exact(b,'action,language,voiceType,description,text')&&VOICE_LANGUAGES.includes(b.language)&&['male','female','child'].includes(b.voiceType)&&typeof b.description==='string'&&b.description.length<=400&&text(b.text,600);
 case 'save_design':return exact(b,'action,audioId,name')&&id(b.audioId)&&text(b.name,80);
 case 'clone':return exact(b,'action,audio,name,language,consent')&&b.consent===true&&VOICE_LANGUAGES.includes(b.language)&&text(b.name,80)&&typeof b.audio==='string'&&b.audio.length<=4194304&&/^[A-Za-z0-9+/]*={0,2}$/.test(b.audio);
 case 'assign':case 'preview':case 'export_voice':return exact(b,'action,voiceId')&&id(b.voiceId);
 case 'job':return exact(b,'action,jobId')&&id(b.jobId);
 case 'audio':return exact(b,'action,audioId')&&id(b.audioId);
 case 'speak':return exact(b,'action,voiceId,language,text')&&id(b.voiceId)&&VOICE_LANGUAGES.includes(b.language)&&text(b.text,1200);
 case 'prepare_previews':return exact(b,'action,model,confirm')&&b.model==='chatterbox-multilingual-v3'&&b.confirm===true;
 case 'preview_demo':return exact(b,'action,demoId,confirm')&&id(b.demoId)&&b.confirm===true;
 case 'default_engine':return exact(b,'action,model')&&['chatterbox-multilingual-v3','chatterbox-torch','supertonic-3','kitten-nano','piper-voices'].includes(b.model);
 case 'install_runtime':return exact(b,'action,model,confirm')&&['chatterbox-torch','supertonic-3','kitten-nano','piper-voices'].includes(b.model)&&b.confirm===true;
 case 'install':case 'remove':return exact(b,'action,model,confirm')&&['voice-design-4bit','chatterbox-multilingual-v3','chatterbox-torch','supertonic-3','kitten-nano','piper-voices'].includes(b.model)&&b.confirm===true;
 case 'preferences':return exact(b,'action,readAloud,language')&&typeof b.readAloud==='boolean'&&['auto',...VOICE_LANGUAGES].includes(b.language);
 default:return false;
 }
}
const voice=v=>({id:v.id,name:v.name,language:v.language??'en',model:v.model,description:typeof v.description==='string'?v.description.slice(0,400):'',voiceType:v.voiceType,duration:v.duration,authorization:v.authorization??(v.consentAt?'consented-sample':'unknown')});
const recording=v=>({id:v.id,voiceId:v.voiceId,language:v.language,text:typeof v.text==='string'?v.text.slice(0,1200):'',duration:v.duration,createdAt:v.createdAt,design:v.design===true,voiceType:v.voiceType});
export function voiceLibraryResponse(status,b){
 if(!object(b))return {};
 if(status!==200)return {code:['voice_busy','voice_unavailable','voice_failed','forbidden','invalid_input'].includes(b.code)?b.code:'voice_failed'};
 if(Array.isArray(b.voices)&&Array.isArray(b.models))return {voices:b.voices.slice(0,100).filter(v=>object(v)&&id(v.id)&&text(v.name,80)).map(voice),recordings:(b.recordings??[]).slice(-100).filter(v=>object(v)&&id(v.id)).map(recording),engineId:id(b.engineId)?b.engineId:'',models:b.models.slice(0,8).map(m=>({id:m.id,name:m.name,installed:m.installed===true,downloadBytes:m.downloadBytes,license:m.license,languages:m.languages,platform:m.platform,compatible:m.compatible!==false,runtimeAvailable:m.runtimeAvailable===true,runtimeInstallAvailable:m.runtimeInstallAvailable===true,defaultable:m.defaultable===true,features:Array.isArray(m.features)?m.features.filter(x=>typeof x==='string').slice(0,5):[],note:typeof m.note==='string'?m.note.slice(0,300):''})),demos:(b.demos??[]).slice(0,30).map(d=>({id:d.id,name:d.name,language:d.language})),runtimeConfigured:b.runtimeConfigured===true,selectedVoiceId:id(b.selectedVoiceId)?b.selectedVoiceId:'',readAloud:b.readAloud===true,language:['auto',...VOICE_LANGUAGES].includes(b.language)?b.language:'auto',busy:b.busy===true};
 if(typeof b.data==='string'&&b.data.length<=12*1024*1024&&/^[A-Za-z0-9+/]*={0,2}$/.test(b.data))return {data:b.data,mime:'audio/wav',...(typeof b.filename==='string'?{filename:b.filename.slice(0,120)}:{})};
 if(b.status==='done'&&object(b.result)&&!b.id)return {status:'done',result:{id:b.result.id,audioId:b.result.audioId,design:b.result.design===true,duration:b.result.duration,language:b.result.language}};
 if(id(b.id)&&['running','done','failed'].includes(b.status))return {id:b.id,status:b.status,errorCode:['disk_space','language_unsupported'].includes(b.errorCode)?b.errorCode:undefined,...(object(b.result)?{result:{audioId:b.result.audioId,id:b.result.id,design:b.result.design===true,duration:b.result.duration,language:b.result.language,voiceType:b.result.voiceType}}:{}),...(object(b.progress)?{progress:{completed:b.progress.completed,total:b.progress.total}}:{})};
 if(id(b.id))return voice(b);
 if(typeof b.voiceId==='string')return {voiceId:b.voiceId};
 if(b.ok===true)return {ok:true};
 return {};
}
