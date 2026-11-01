import {VOICE_LIBRARY_PATH} from './voice-library-contract.js';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionClient } from './session';
import type { ConversationsController } from './conversations';
import { CHAT_VOICE_PATH, voiceTurnKey, takeVoiceReply } from './chat-voice-contract.js';
import { MeetingVoice } from './meeting-voice';
import { speakable } from './ChatAvatar';
import { UiIcon } from './ui-icons';
type Voice = {id:string;name:string;language:string};
const object = (v:unknown):v is Record<string,unknown> => !!v && typeof v === 'object';
/** Explicit local talk mode. Historical replies are never read on opening a chat. */
export function ChatVoice({client,controller,active}:{client:SessionClient;controller:ConversationsController;active:boolean}) {
 const s = useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
 const [voices,setVoices] = useState<Voice[]>([]), [voiceId,setVoiceId] = useState(''), [available,setAvailable] = useState(false);
 const [supportedLanguages,setSupportedLanguages]=useState<string[]>(['ar','en']);
 const [speechLanguage,setSpeechLanguage]=useState('auto');
 const [enabled,setEnabled] = useState(false), [phase,setPhase] = useState(''), [error,setError] = useState('');
 const latest = useRef({active,enabled,s}); latest.current = {active,enabled,s};
 const pending = useRef(false), epoch = useRef(0), job = useRef<string|null>(null), player = useRef<HTMLAudioElement|null>(null), url = useRef<string|null>(null);
 const seen = useRef(new Set(s.turns.map(voiceTurnKey)));
 const liveReplies=useRef(new Set<string>());
 const previousChat = useRef(s.activeId);
 const defaultReadAloud=useRef(false);
 const [mic] = useState(()=>new MeetingVoice(client, async (text,current) => {
  const snap = controller.getSnapshot();
  if (!current() || !latest.current.active || !latest.current.enabled || snap.draft.trim() || snap.attachments.length) return;
  const primary = snap.agents.find(a=>a.primary); if (!primary) return;
  if(snap.activeId) controller.setReplyAgent(primary.id); else controller.selectAgent(primary.id); await controller.send(text);
 },()=>pending.current || !!controller.getSnapshot().runId || !!controller.getSnapshot().draft.trim() || !!controller.getSnapshot().attachments.length));
 const m = useSyncExternalStore(mic.subscribe,mic.getSnapshot,mic.getSnapshot);
 const request = async (body?:unknown) => { const r = await client.request(body ? {method:'POST',path:CHAT_VOICE_PATH,body} : {method:'GET',path:CHAT_VOICE_PATH}); if(r.status!==200 || !object(r.body)) throw Error('Local voice is unavailable. Check the installed voice runtime.'); return r.body; };
 const stop = () => {
  epoch.current++; player.current?.pause(); player.current=null;
  if(url.current){URL.revokeObjectURL(url.current);url.current=null;}
  if(job.current) void request({action:'cancel',id:job.current}).catch(()=>{});
  job.current=null; pending.current=false;setPhase('');mic.sync();
 };
 useEffect(()=>{ let live=true;let first=true;mic.activate();void mic.check();const load=()=>{void request().then(b=>{if(!live)return;setAvailable(b.available===true);if(Array.isArray(b.languages))setSupportedLanguages(b.languages as string[]);setSpeechLanguage(typeof b.language==='string'?b.language:'auto');defaultReadAloud.current=b.readAloud===true;if(Array.isArray(b.voices)){const list=b.voices as Voice[];setVoices(list);setVoiceId(typeof b.selectedVoiceId==='string'&&list.some(v=>v.id===b.selectedVoiceId)?b.selectedVoiceId:'');}if(first){first=false;setEnabled(b.readAloud===true);}}).catch(()=>{});};load();window.addEventListener('girru-voice-changed',load);return()=>{live=false;window.removeEventListener('girru-voice-changed',load);stop();mic.dispose();};},[client]);
 useEffect(()=>{if(!active){setEnabled(false);mic.mute();stop();}else{seen.current=new Set(s.turns.map(voiceTurnKey));liveReplies.current.clear();setEnabled(defaultReadAloud.current);}},[active]);
 useEffect(()=>{const previous=previousChat.current;previousChat.current=s.activeId;if(previous===null&&s.activeId&&latest.current.enabled)return;setEnabled(defaultReadAloud.current);mic.mute();stop();seen.current=new Set(s.turns.map(voiceTurnKey));liveReplies.current.clear();},[s.activeId]);
 useEffect(()=>{mic.sync();},[s.runId,s.draft,s.attachments.length]);
 async function speak(text:string) {
  stop();const token=epoch.current;pending.current=true;setPhase('Preparing voice…');setError('');mic.sync();
  try {
   const language=speechLanguage!=='auto'?speechLanguage:/[\u0600-\u06ff]/.test(text)?'ar':(voices.find(v=>v.id===voiceId)?.language==='ar'?'en':voices.find(v=>v.id===voiceId)?.language??'en');
   if(!supportedLanguages.includes(language))throw Error('The chosen speech engine does not support this language. Choose a compatible engine in Voice settings.');
   let b=await request({action:'speak',text,voiceId,language});
   if(typeof b.id!=='string')throw Error('Voice could not start.');
   const id=b.id;
   if(token!==epoch.current){void request({action:'cancel',id}).catch(()=>{});return;} job.current=id;
   while(b.status==='working') {await new Promise(r=>setTimeout(r,700));if(token!==epoch.current)return;b=await request({action:'job',id});}
   if(token!==epoch.current)return;
   job.current=null;if(b.status!=='done'||typeof b.audio!=='string')throw Error('Voice generation failed. Your reply remains in the chat.');
   const bytes=Uint8Array.from(atob(b.audio),c=>c.charCodeAt(0));const src=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));url.current=src;
   const audio=new Audio(src);player.current=audio;setPhase('Speaking…');
   const finish=()=>{if(token===epoch.current)stop();};audio.onended=finish;audio.onerror=()=>{finish();setError('Audio playback failed.');};await audio.play();
  } catch(e) {if(token===epoch.current){stop();setError(e instanceof Error?e.message:'Voice failed.');}}
 }
 useEffect(()=>{
  for(const t of s.turns){if(!takeVoiceReply(t,seen.current,liveReplies.current,active&&enabled))continue;
   const primary=s.agents.find(a=>a.primary);if(!active||!enabled||t.status!=='complete'||!primary||t.agentId&&t.agentId!==primary.id)continue;
   const text=speakable(t.content);if(text)void speak(text);
  }
 },[s.turns,enabled,active]);
 const toggle = async()=>{if(m.enabled){setEnabled(false);mic.mute();stop();return;}seen.current=new Set(s.turns.map(voiceTurnKey));liveReplies.current.clear();setEnabled(true);await mic.unmute();};
 return <div className="chat-voice" aria-label="Main agent voice">
  <button type="button" className="tool" aria-label={m.enabled?'End voice conversation':'Talk to Main Agent'} title={m.enabled?'End voice conversation':'Talk to Main Agent'} aria-pressed={m.enabled} disabled={!available||!voiceId||m.phase==='off'} onClick={()=>void toggle()}><UiIcon name="phone"/></button>
  <button type="button" className="tool" aria-label="Read replies aloud" title="Read replies aloud" aria-pressed={enabled} disabled={!available||!voiceId} onClick={()=>{seen.current=new Set(s.turns.map(voiceTurnKey));liveReplies.current.clear();setEnabled(!enabled);if(enabled){mic.mute();stop();}void client.request({method:'POST',path:VOICE_LIBRARY_PATH,body:{action:'preferences',readAloud:!enabled,language:speechLanguage}}).then(r=>{if(r.status!==200)setError('The speech preference could not be saved.');}).catch(()=>setError('The speech preference could not be saved.'));}}><UiIcon name="speaker"/></button>
  <select aria-label="Main agent voice" value={voiceId} disabled={m.enabled} onChange={e=>{stop();setVoiceId(e.target.value);void client.request({method:'POST',path:VOICE_LIBRARY_PATH,body:{action:'assign',voiceId:e.target.value}}).then(r=>{if(r.status!==200)setError('The voice choice could not be saved.');}).catch(()=>setError('The voice choice could not be saved.'));}}><option value="" disabled>{voices.length?'Choose a voice':'Choose an engine in Voice settings'}</option>{voices.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select>
  <button type="button" className="tool" aria-label="Preview voice" title="Preview voice" disabled={!available||!voiceId||m.enabled} onClick={()=>void speak(supportedLanguages.includes('ar')?'مرحبا، أنا مساعدك الأساسي. جاهز للعمل وياك.':'Hello, I am your main agent. I am ready to help.')}><UiIcon name="play"/></button>
  {phase&&<button type="button" className="tool" aria-label="Stop speaking" title="Stop speaking" onClick={stop}><UiIcon name="stop"/></button>}
  <span role="status">{phase||error||m.error||(enabled?(!m.enabled?'Read replies aloud':m.phase==='listening'?'Listening…':m.phase==='transcribing'?'Recognizing speech…':m.phase==='waiting'?'Waiting for reply…':'Starting microphone…'):!available?'Local voice runtime not configured':'Local voice')}</span>
 </div>;
}
