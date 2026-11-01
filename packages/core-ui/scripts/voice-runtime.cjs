'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
/** Keep the already-configured optional local runtime across ordinary app launches. Never accepts an API-supplied executable. */
function voicePython(env=process.env){
 const configured=env.DPRO_VOICE_PYTHON||env.GENVR_VOICE_PYTHON;
 const root=path.resolve(env.DPRO_GENVR_STATE||path.join(os.homedir(),'.genvr/dpro-studio'));
 const file=path.join(root,'voice-runtime.json');
 const valid=p=>typeof p==='string'&&path.isAbsolute(p)&&/^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(path.basename(p))&&fs.existsSync(p);
 if(valid(configured)){
  try{fs.mkdirSync(root,{recursive:true,mode:0o700});const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify({python:configured}),{mode:0o600});fs.renameSync(temp,file);}catch{}
  return configured;
 }
 if(configured)return undefined;
 try{const p=JSON.parse(fs.readFileSync(file,'utf8')).python;return valid(p)?p:undefined;}catch{return undefined;}
}
module.exports={voicePython};
