import type { SessionClient } from './session';
import { MAX_AUDIO_CHARS, TRANSCRIBE_PATH } from './conversation-contract.js';

/** Local energy-based turn detection; no audio is transmitted until a speech segment ends. */
export class MeetingVoiceActivity {
 private first: number | null = null;
 private lastVoice = 0;
 private voiced = 0;
 private previous = 0;
 private noise = .003;
 sample(rms: number, now: number): 'speech' | 'end' | 'discard' | null {
  if (this.first === null) { this.first = now; this.previous = now; }
  const step = Math.max(0, Math.min(100, now - this.previous)); this.previous = now;
  const loud = rms >= Math.max(.015, this.noise * 3);
  if (loud) { this.voiced += step; this.lastVoice = now; }
  else if (!this.voiced) this.noise = this.noise * .97 + rms * .03;
  if (this.voiced >= 250 && (now - this.lastVoice >= 900 || now - this.first >= 45000)) return 'end';
  if (now - this.first >= 15000 && this.voiced < 250) return 'discard';
  return loud ? 'speech' : null;
 }
}
export type MeetingVoiceDevice = { listen(enabled: boolean): void; close(): void };
export type MeetingVoiceFactory = (clip: (audio: Blob) => void, failed: () => void) => Promise<MeetingVoiceDevice>;

/** One microphone stream per unmute, with bounded recordings and track gating while the agent speaks. */
export const openMeetingMicrophone: MeetingVoiceFactory = async (clip, failed) => {
 const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
 let context: AudioContext | undefined, timer: ReturnType<typeof setInterval> | undefined, recorder: MediaRecorder | null = null, version = 0, closed = false, armed = false;
 const stopRecorder = () => { version++; clearInterval(timer); timer = undefined; const r = recorder; recorder = null; if (r && r.state !== 'inactive') r.stop(); };
 const close = () => { if (closed) return; closed = true; armed = false; stopRecorder(); stream.getTracks().forEach(track => track.stop()); void context?.close().catch(() => {}); };
 try {
  context = new AudioContext(); await context.resume();
  const source = context.createMediaStreamSource(stream), analyser = context.createAnalyser(); analyser.fftSize = 1024; source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize), mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
  function begin() {
   if (closed || !armed) return;
   const epoch = ++version, activity = new MeetingVoiceActivity(), chunks: Blob[] = [];
   const r = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32000 }); recorder = r;
   let deliver = false, size = 0;
   r.ondataavailable = event => { if (event.data.size) { size += event.data.size; if (size <= MAX_AUDIO_CHARS * .75) chunks.push(event.data); else { close(); failed(); } } };
   r.onerror = () => { close(); failed(); };
   r.onstop = () => { if (closed || epoch !== version || !armed) return; recorder = null; if (deliver) { armed = false; stream.getAudioTracks().forEach(track => { track.enabled = false; }); clip(new Blob(chunks, { type: r.mimeType || mimeType || 'audio/webm' })); } else begin(); };
   r.start(500);
   timer = setInterval(() => {
    if (closed || epoch !== version) return;
    analyser.getFloatTimeDomainData(samples); let sum = 0; for (const sample of samples) sum += sample * sample;
    const result = activity.sample(Math.sqrt(sum / samples.length), performance.now());
    if (result === 'end' || result === 'discard') { clearInterval(timer); timer = undefined; deliver = result === 'end'; if (r.state !== 'inactive') r.stop(); }
   }, 50);
  }
  const device: MeetingVoiceDevice = { listen(enabled) { if (closed || armed === enabled) return; armed = enabled; stream.getAudioTracks().forEach(track => { track.enabled = enabled; }); if (enabled) { try { begin(); } catch { close(); failed(); } } else stopRecorder(); }, close };
  stream.getAudioTracks().forEach(track => { track.enabled = false; track.addEventListener('ended', () => { if (!closed) { close(); failed(); } }, { once: true }); });
  return device;
 } catch (error) { close(); throw error; }
};

type VoicePhase = 'unknown' | 'off' | 'muted' | 'opening' | 'listening' | 'transcribing' | 'waiting';
export type MeetingVoiceState = Readonly<{ phase: VoicePhase; enabled: boolean; error?: string }>;
async function encode(blob: Blob) { const bytes = new Uint8Array(await blob.arrayBuffer()); let value = ''; for (let i = 0; i < bytes.length; i += 0x8000) value += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(value); }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** No automatic permission requests, retries, overlapping transcriptions or sends after mute/leave. */
export class MeetingVoice {
 private state: MeetingVoiceState = Object.freeze({ phase: 'unknown', enabled: false });
 private listeners = new Set<() => void>();
 private device: MeetingVoiceDevice | null = null;
 private epoch = 0;
 private disposed = false;
 private processing = false;
 constructor(private client: SessionClient, private onText: (text: string, current: () => boolean) => Promise<void>, private blocked: () => boolean, private open: MeetingVoiceFactory = openMeetingMicrophone) {}
 /** React effect replay can reattach a closed controller without reviving old requests. */
 activate() { if (this.disposed) { this.disposed = false; this.publish({ phase: 'unknown', enabled: false, error: undefined }); } }
 getSnapshot = () => this.state;
 subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
 private publish(patch: Partial<MeetingVoiceState>) { if (this.disposed) return; this.state = Object.freeze({ ...this.state, ...patch }); this.listeners.forEach(fn => fn()); }
 async check() { const epoch = this.epoch; try { const r = await this.client.request({ method: 'GET', path: TRANSCRIBE_PATH } as never); if (!this.disposed && epoch === this.epoch) this.publish({ phase: r.status === 200 && object(r.body) && r.body.available === true ? 'muted' : 'off' }); } catch { if (!this.disposed && epoch === this.epoch) this.publish({ phase: 'off' }); } }
 async unmute() {
  if (this.disposed || !['muted'].includes(this.state.phase)) return;
  const epoch = ++this.epoch; this.publish({ phase: 'opening', enabled: true, error: undefined });
  try { const device = await this.open(audio => { void this.transcribe(audio, epoch); }, () => { if (epoch === this.epoch) this.fail('The microphone stopped. Check its permission and unmute to try again.'); }); if (this.disposed || epoch !== this.epoch) { device.close(); return; } this.device = device; this.sync(); }
  catch { if (epoch === this.epoch) this.fail('Microphone access was cancelled or denied. Allow access, then unmute to try again.'); }
 }
 mute() { this.epoch++; this.processing = false; this.device?.close(); this.device = null; this.publish({ enabled: false, phase: this.state.phase === 'off' ? 'off' : 'muted' }); }
 private fail(message: string) { this.mute(); this.publish({ error: message }); }
 sync() { if (this.disposed || !this.state.enabled || !this.device || this.processing) return; const waiting = this.blocked(); this.device.listen(!waiting); this.publish({ phase: waiting ? 'waiting' : 'listening' }); }
 private async transcribe(audio: Blob, epoch: number) {
  if (this.disposed || epoch !== this.epoch || this.processing || this.blocked()) { this.sync(); return; }
  this.processing = true; this.device?.listen(false); this.publish({ phase: 'transcribing', error: undefined });
  const current = () => !this.disposed && epoch === this.epoch && this.state.enabled && !this.blocked();
  try {
   const encoded = await encode(audio); if (!current()) return;
   if (!encoded || encoded.length > MAX_AUDIO_CHARS) throw Error('The spoken turn was too long. Unmute and try a shorter turn.');
   const r = await this.client.request({ method: 'POST', path: TRANSCRIBE_PATH, body: { audio: encoded } } as never); if (!current()) return;
   if (r.status !== 200 || !object(r.body) || typeof r.body.text !== 'string') throw Error('Speech could not be transcribed. Unmute to try again; no message was sent.');
   const text = r.body.text.trim(); if (text) await this.onText(text, current); else this.publish({ error: 'No speech was recognized. Try speaking again.' });
  } catch (error) { if (!this.disposed && epoch === this.epoch) this.fail(error instanceof Error ? error.message : 'The spoken turn could not be sent.'); }
  finally { if (!this.disposed && epoch === this.epoch) { this.processing = false; this.sync(); } }
 }
 dispose() { this.mute(); this.disposed = true; this.listeners.clear(); }
}
