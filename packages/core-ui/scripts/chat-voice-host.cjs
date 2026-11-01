"use strict";
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
/** Reuses the installed GenVR worker and synthetic voice library; never downloads or changes either. */
function createChatVoice({ packageRoot, env = process.env, spawnWorker = spawn, blocked = () => false } = {}) {
 const directory = path.resolve(env.DPRO_GENVR_VOICES || path.join(os.homedir(), '.genvr/voices'));
 const worker = path.join(packageRoot, 'scripts/chat-voice-worker.py');
 const python = spawnWorker!==spawn ? (env.DPRO_VOICE_PYTHON||env.GENVR_VOICE_PYTHON) : require('./voice-runtime.cjs').voicePython(env);
 const cache = path.resolve(env.DPRO_GENVR_VOICE_MODELS || path.join(os.homedir(), '.genvr/voice-models'));
 const jobs = new Map(); let busy = null;
 const configured = () => !!python && path.isAbsolute(python) && existsSync(python) && existsSync(worker) && existsSync(path.join(directory, 'chatterbox-multilingual-v3.installed.json'));
 const voices = async () => {
  try { const library = JSON.parse(await fs.readFile(path.join(directory, 'library.json'), 'utf8'));
   return (library.voices || []).filter(v => /^[a-f0-9-]{36}$/.test(v.id) && (v.authorization === 'synthetic-design' || v.authorization === 'publisher-demo' || typeof v.consentAt === 'string') && v.model === 'chatterbox-multilingual-v3' && /^[a-z]{2}$/.test(v.language)).map(v => ({id:v.id,name:String(v.name).slice(0,80),language:v.language}));
  } catch { return []; }
 };
 const error = code => { throw Object.assign(Error(code), {code}); };
 async function call(userId, input) {
  if (!userId) return error('forbidden');
  for (const [id, j] of jobs) if (j.status !== 'working' && Date.now() - j.finished > 60000) jobs.delete(id);
  if (!input) { let library={},settings={};try{library=JSON.parse(await fs.readFile(path.join(directory,'library.json'),'utf8'));settings=JSON.parse(await fs.readFile(path.join(directory,'girru-settings.json'),'utf8'));}catch{} return {available:configured(),voices:await voices(),selectedVoiceId:library.assignments?.['girru:'+userId+':main']??'',readAloud:settings[userId]?.readAloud===true,language:settings[userId]?.language??'auto'}; }
  if (input.action !== 'speak') {
   const j = jobs.get(input.id); if (!j || j.owner !== userId) return error('forbidden');
   if (input.action === 'cancel' && j.status === 'working') { j.status = 'cancelled'; j.finished = Date.now(); j.child?.kill('SIGTERM'); }
   return { id:j.id, status:j.status, ...(j.status === 'done' ? {audio:j.audio} : {}) };
  }
  if (!configured()) return error('voice_unavailable');
  if (busy) return error('voice_busy');
  busy='preparing';let voice,ref;
  try {
   if(await blocked())return error('voice_busy');
   voice=(await voices()).find(v=>v.id===input.voiceId);if(!voice)return error('invalid_input');
   ref=await fs.realpath(path.join(directory,voice.id+'.wav'));
   const root=await fs.realpath(directory);if(!ref.startsWith(root+path.sep))return error('invalid_input');
  } catch(e){busy=null;throw e;}
  if (jobs.size >= 8) jobs.delete(jobs.keys().next().value);
  const j = { id:randomUUID(), owner:userId, status:'working' }; jobs.set(j.id,j); busy = j.id;
  void (async () => {
   let temp;
   try {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'girru-voice-')); const output = path.join(temp,'reply.wav');
    await new Promise((resolve,reject) => {
     const child = spawnWorker(python,[worker], {env:{...env,HF_HUB_CACHE:cache,HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1'},stdio:['pipe','ignore','ignore']}); j.child = child;
     const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('timeout')); },180000);
     child.once('error', e => {clearTimeout(timer);reject(e);}); child.once('close', code => {clearTimeout(timer);code === 0 ? resolve() : reject(Error('worker'));});
     child.stdin.on('error', () => {});
     child.stdin.end(JSON.stringify({ action:'generate',model:'chatterbox-multilingual-v3',text:input.text,language:input.language,reference:ref,output }) + '\n');
     if (j.status === 'cancelled') child.kill('SIGTERM');
    });
    if (j.status === 'cancelled') return;
    const file = await fs.open(output,'r'); let audio;
    try {
     const buffer=Buffer.alloc(2*1024*1024+1);let length=0;
     while(length<buffer.length){const {bytesRead}=await file.read(buffer,length,buffer.length-length,null);if(!bytesRead)break;length+=bytesRead;}
     if(length<44||length>2*1024*1024)throw Error('size');audio=buffer.subarray(0,length);
    } finally {await file.close();}
    if (audio.toString('ascii',0,4) !== 'RIFF' || audio.toString('ascii',8,12) !== 'WAVE') throw Error('format');
    j.audio = audio.toString('base64'); j.status = 'done';
   } catch { if (j.status !== 'cancelled') j.status = 'failed'; }
   finally { j.finished = Date.now(); j.child = null; if (busy === j.id) busy = null; if (temp) await fs.rm(temp,{recursive:true,force:true}).catch(()=>{}); }
  })();
  return { id:j.id,status:j.status };
 }
 function close() { for (const j of jobs.values()) {j.status = 'cancelled'; j.child?.kill('SIGTERM');} jobs.clear(); }
 return {call,close,isBusy:()=>!!busy};
}
module.exports = {createChatVoice};
