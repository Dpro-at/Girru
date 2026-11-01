import { DepartmentBadge } from './DepartmentBadge';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ConversationsController } from './conversations';
import type { SessionClient } from './session';
import type { MeetingRecord } from './meetings-contract.js';
import { MeetingCapture, meetingFrame, meetingCaptureError, type CaptureKind } from './meeting-media';
import { MeetingVoice } from './meeting-voice';
import { ChatAvatar, speakable } from './ChatAvatar';
import { UiIcon } from './ui-icons';
import { Sheet } from './desktop-ui';
function Feed({ stream, label }: { stream: MediaStream | null; label: string }) { const ref = useRef<HTMLVideoElement>(null); useEffect(() => { const video = ref.current; if (video) { video.srcObject = stream; if (stream) void video.play().catch(() => {}); } return () => { if (video) video.srcObject = null; }; }, [stream]); return <video ref={ref} autoPlay muted playsInline aria-label={label}/>; }
export function MeetingCall({ client, controller, meeting, onLeave, onMicrophoneEnabled }: { onMicrophoneEnabled?: () => void; client: SessionClient; controller: ConversationsController; meeting: MeetingRecord; onLeave: () => void }) {
 const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
 const [capture] = useState(() => new MeetingCapture()), [camera, setCamera] = useState<MediaStream | null>(null), [screen, setScreen] = useState<MediaStream | null>(null), [notice, setNotice] = useState(''), [settings, setSettings] = useState(false), [systemVoice, setSystemVoice] = useState(true), [voice, setVoice] = useState(''), [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
 const meetingState = useRef(meeting.state); meetingState.current = meeting.state;
 const playback = useRef(false), speechEpoch = useRef(0), systemVoiceRef = useRef(systemVoice); systemVoiceRef.current = systemVoice;
 const closed = useRef(false), spoken = useRef(new Set(state.turns.filter(t => t.role === 'assistant').map(t => t.key))), captureBusy = useRef(false);
 const onFrame = async () => { const stream = capture.get('screen') ?? capture.get('camera'); return stream ? meetingFrame(stream) : null; };
 const [mic] = useState(() => new MeetingVoice(client, async (text, current) => {
  if (closed.current || meetingState.current !== 'active' || !current()) return;
  const frame = await onFrame(); if (closed.current || meetingState.current !== 'active' || !current()) return;
  await controller.send(text, frame ?? undefined);
  const snapshot = controller.getSnapshot();
  if (snapshot.notice && !snapshot.runId && !snapshot.starting) throw Error(snapshot.notice);
 }, () => closed.current || meetingState.current !== 'active' || !!controller.getSnapshot().runId || controller.getSnapshot().starting || playback.current));
 const speaking = (value: boolean) => { playback.current = value; mic.sync(); };
 const cancelSpeech = () => { speechEpoch.current++; if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); speaking(false); };
 const micState = useSyncExternalStore(mic.subscribe, mic.getSnapshot, mic.getSnapshot);
 const latest = [...state.turns].reverse().find(t => t.role === 'assistant'), speakerId = meeting.speaker?.id || latest?.agentId || state.replyAgent || state.agentId;
 const speaker = state.agents.find(a => a.id === speakerId), speakingName = speaker?.name ?? meeting.speaker?.name ?? 'Meeting participant';
 const speakingDepartment = speaker?.department !== undefined ? speaker.department : (meeting.speaker?.id === speakerId ? meeting.speaker.department : undefined);
 useEffect(() => { closed.current = false; capture.activate(); mic.activate(); void mic.check(); return () => { closed.current = true; speechEpoch.current++; playback.current = false; capture.close(); mic.dispose(); if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); }; }, [capture, mic]);
 useEffect(() => { if (typeof speechSynthesis === 'undefined') return; const update = () => setVoices(speechSynthesis.getVoices()); update(); speechSynthesis.addEventListener('voiceschanged', update); return () => speechSynthesis.removeEventListener('voiceschanged', update); }, []);
 useEffect(() => {
  if (!systemVoice || typeof speechSynthesis === 'undefined' || !latest || latest.status !== 'complete' || spoken.current.has(latest.key)) return;
  spoken.current.add(latest.key); const text = speakable(latest.content); if (!text || meeting.state !== 'active') return;
  const utterance = new SpeechSynthesisUtterance(text), epoch = ++speechEpoch.current;
  const chosen = speechSynthesis.getVoices().find(v => v.voiceURI === voice); if (chosen) { utterance.voice = chosen; utterance.lang = chosen.lang; }
  utterance.onend = () => { if (!closed.current && epoch === speechEpoch.current) speaking(false); };
  utterance.onerror = () => { if (!closed.current && epoch === speechEpoch.current) { speaking(false); setNotice('Speech playback is unavailable. The reply remains in the chat.'); } };
  speechSynthesis.cancel(); speaking(true); try { speechSynthesis.speak(utterance); } catch { speaking(false); setNotice('Speech playback is unavailable. The reply remains in the chat.'); }
 }, [latest?.key, latest?.status, voice, systemVoice, meeting.state]);
 useEffect(() => { if (state.runId || meeting.state !== 'active') cancelSpeech(); if (meeting.state !== 'active') mic.mute(); mic.sync(); }, [state.runId, state.starting, meeting.state, mic]);
 async function toggle(kind: CaptureKind) { if (captureBusy.current) return; const value = capture.get(kind); if (value) { capture.stop(kind); kind === 'camera' ? setCamera(null) : setScreen(null); return; } await open(kind); }
 async function open(kind: CaptureKind) { captureBusy.current = true; try { const stream = await capture.open(kind); if (closed.current || !stream) return; kind === 'camera' ? setCamera(stream) : setScreen(stream); stream.getVideoTracks().forEach(t => t.addEventListener('ended', () => { if (!closed.current) kind === 'camera' ? setCamera(null) : setScreen(null); }, { once: true })); setNotice(''); } catch (error) { if (!closed.current) setNotice(meetingCaptureError(kind, error)); } finally { captureBusy.current = false; } }
 async function attachFrame() { try { const frame = await onFrame(); if (!frame) { setNotice('Turn on the camera or share a screen first.'); return; } if (!closed.current) { const error = controller.attachImages([frame]); setNotice(error ?? 'Frame added to the next message. The selected model must support images.'); } } catch { setNotice('The frame could not be captured.'); } }
 return <section className="meeting-call" aria-label="Meeting call"><div className="meeting-call-stage">
  <div className="meeting-speaker">{screen ? <Feed stream={screen} label="Shared screen preview"/> : <ChatAvatar turns={state.turns} agentId={speakerId ?? ''} agentName={speakingName} onClose={onLeave} speechEnabled={!systemVoice} onSpeakingChange={value => { if (!systemVoiceRef.current) speaking(value); }}/>}<span className="meeting-speaking"><span>{speakingName}</span>{speakerId && <DepartmentBadge department={speakingDepartment}/>}{state.runId ? ' · Preparing a reply' : ''}</span></div>
  <div className="meeting-self">{camera ? <Feed stream={camera} label="Your camera preview"/> : <span className="meeting-face"><UiIcon name="person" size={26}/></span>}<span>You · {camera ? 'Camera on' : 'Camera off'}</span></div>
 </div><div className="meeting-call-controls">
  <button type="button" className="tool" aria-label={micState.enabled ? 'Mute microphone' : 'Unmute microphone'} title={micState.enabled ? 'Mute microphone' : 'Unmute and speak naturally'} aria-pressed={micState.enabled} disabled={['unknown','off'].includes(micState.phase) || meeting.state !== 'active'} onClick={() => { if (micState.enabled) mic.mute(); else { onMicrophoneEnabled?.(); void mic.unmute(); } }}><UiIcon name="mic"/></button>
  <button type="button" className="tool" aria-label={camera ? 'Turn camera off' : 'Turn camera on'} title={camera ? 'Turn camera off' : 'Turn camera on'} aria-pressed={!!camera} onClick={() => void toggle('camera')}><UiIcon name="meeting-camera"/></button>
  <button type="button" className="tool" aria-label={screen ? 'Stop sharing' : 'Share a screen or window'} title={screen ? 'Stop sharing' : 'Share a screen or window'} aria-pressed={!!screen} onClick={() => void toggle('screen')}><UiIcon name="screen"/></button>
  <button type="button" className="tool" aria-label="Add current frame to next message" title="Add current frame to next message" disabled={!camera && !screen} onClick={() => void attachFrame()}><UiIcon name="image"/></button>
  <button type="button" className="tool" aria-label="Call voice settings" title="Call voice settings" onClick={() => setSettings(true)}><UiIcon name="gear"/></button>
  <button type="button" className="tool danger" aria-label="Leave call" title="Leave call" onClick={onLeave}><UiIcon name="phone"/></button>
 </div><p className="meeting-fine" role="status">{micState.phase === 'opening' ? 'Opening the microphone…' : micState.phase === 'listening' ? 'Listening · Speak naturally. A short pause sends your turn automatically.' : micState.phase === 'transcribing' ? 'Turning speech into text on this computer…' : micState.phase === 'waiting' ? 'Microphone paused while the participant answers. Listening resumes automatically.' : micState.phase === 'off' ? 'Set up local speech-to-text to speak; typed chat still works.' : 'Microphone muted. Camera and screen stay local until you add a frame or send a spoken turn.'}</p>{(notice || micState.error) && <p className="meeting-notice" role="status">{notice || micState.error}</p>}
 {settings && <Sheet title="Meeting voice" onClose={() => setSettings(false)}><label className="meeting-check"><input type="checkbox" checked={systemVoice} onChange={e => { setSystemVoice(e.target.checked); cancelSpeech(); }}/>Read replies using a system voice</label>{systemVoice ? <label className="meeting-field">Voice<select value={voice} onChange={e => setVoice(e.target.value)}><option value="">System default</option>{voices.map(v => <option value={v.voiceURI} key={v.voiceURI}>{v.name} · {v.lang}</option>)}</select></label> : <p>Choose the participant’s saved voice in the avatar’s settings. Voice availability depends on the installed voice engine.</p>}</Sheet>}
 </section>;
}
