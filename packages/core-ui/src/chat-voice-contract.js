export const CHAT_VOICE_PATH = '/api/chat/voice';
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const jobId=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
const uuid = v => typeof v === 'string' && /^[a-z0-9-]{1,80}$/.test(v);
export function allowedChatVoice(method, path, body) {
 if (path !== CHAT_VOICE_PATH) return false;
 if (method === 'GET') return body === undefined;
 if (method !== 'POST' || !object(body)) return false;
 const keys = Object.keys(body).sort().join(',');
 if (body.action === 'speak') return keys === 'action,language,text,voiceId' && /^[a-z]{2}$/.test(body.language) && uuid(body.voiceId) && typeof body.text === 'string' && !!body.text.trim() && body.text.length <= 600;
 return ['job','cancel'].includes(body.action) && keys === 'action,id' && jobId(body.id);
}
export function chatVoiceResponse(status, body) {
 if (!object(body)) return {};
 if (status !== 200) return { code: ['voice_busy','voice_unavailable','voice_failed','forbidden','invalid_input'].includes(body.code) ? body.code : 'voice_failed' };
 if (Array.isArray(body.voices)) return { available: body.available === true, languages:Array.isArray(body.languages)?body.languages.filter(v=>typeof v==='string'&&/^[a-z]{2}$/.test(v)).slice(0,32):['ar','en'], selectedVoiceId:uuid(body.selectedVoiceId)?body.selectedVoiceId:'',readAloud:body.readAloud===true,language:typeof body.language==='string'?body.language:'auto', voices: body.voices.filter(v => object(v) && uuid(v.id) && typeof v.name === 'string' && typeof v.language==='string'&&/^[a-z]{2}$/.test(v.language)).slice(0,100).map(v => ({ id:v.id, name:v.name.slice(0,80), language:v.language })) };
 if (jobId(body.id) && ['working','done','failed','cancelled'].includes(body.status)) return { id:body.id, status:body.status, ...(body.status === 'done' && typeof body.audio === 'string' && body.audio.length <= 4194304 && /^[A-Za-z0-9+/]*={0,2}$/.test(body.audio) ? {audio:body.audio} : {}) };
 return {};
}

export const voiceTurnKey = turn => `${turn.role}:${turn.runId || turn.key}`;

/** Only a newly observed live reply may become speech; loading history is silent. */
export function takeVoiceReply(turn,seen,pending,enabled){
 const key=voiceTurnKey(turn);
 if(turn.role!=='assistant')return false;
 if(turn.status==='running'){if(enabled&&!seen.has(key))pending.add(key);return false;}
 if(seen.has(key))return false;
 seen.add(key);const started=pending.delete(key);
 return enabled&&started&&turn.status==='complete';
}
