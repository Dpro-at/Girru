/** Media exists only for an explicitly joined meeting and stops on leave/unmount. */
export type CaptureKind = 'camera' | 'screen';
export class MeetingCapture {
 private streams = new Map<CaptureKind, MediaStream>();
 private versions = { camera: 0, screen: 0 };
 private closed = false;
 constructor(private media: Pick<MediaDevices, 'getUserMedia' | 'getDisplayMedia'> = navigator.mediaDevices) {}
 activate() { this.closed = false; }
 get(kind: CaptureKind) { return this.streams.get(kind) ?? null; }
 async open(kind: CaptureKind): Promise<MediaStream | null> {
  if (this.closed) return null;
  this.stop(kind); const version = this.versions[kind];
  const stream = kind === 'camera' ? await this.media.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }) : await this.media.getDisplayMedia({ video: true, audio: false });
  if (this.closed || this.versions[kind] !== version) { stream.getTracks().forEach(t => t.stop()); return null; }
  this.streams.set(kind, stream);
  stream.getVideoTracks().forEach(t => t.addEventListener('ended', () => { if (this.streams.get(kind) === stream) this.stop(kind); }, { once: true }));
  return stream;
 }
 stop(kind: CaptureKind) { this.versions[kind]++; const stream = this.streams.get(kind); this.streams.delete(kind); stream?.getTracks().forEach(t => t.stop()); }
 close() { this.closed = true; this.stop('camera'); this.stop('screen'); }
}
export async function meetingFrame(stream: MediaStream): Promise<{ name: string; type: string; data: string } | null> {
 const video = document.createElement('video'); video.muted = true; video.srcObject = stream;
 try {
  await video.play(); if (!video.videoWidth || !video.videoHeight) return null;
  const ratio = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight), canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * ratio); canvas.height = Math.round(video.videoHeight * ratio);
  const context = canvas.getContext('2d'); if (!context) return null; context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return { name: 'Meeting frame.jpg', type: 'image/jpeg', data: canvas.toDataURL('image/jpeg', .75).split(',')[1] };
 } finally { video.pause(); video.srcObject = null; }
}

export function meetingCaptureError(kind: CaptureKind, error: unknown): string {
 const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
 if (kind === 'camera' && ['NotFoundError','DevicesNotFoundError'].includes(name)) return 'No camera is connected. You can continue with the microphone or screen sharing.';
 if (kind === 'camera' && name === 'NotReadableError') return 'The camera could not be opened. Close other apps using it, then try again.';
 if (name === 'AbortError') return kind === 'camera' ? 'Opening the camera was cancelled.' : 'Screen sharing was cancelled.';
 if (['NotAllowedError','PermissionDeniedError','SecurityError'].includes(name)) return kind === 'camera' ? 'Camera access is blocked. Allow it in system privacy settings, then try again.' : 'Screen sharing is blocked. Allow screen recording in system privacy settings, then try again.';
 return kind === 'camera' ? 'The camera could not be opened. Check its connection and permission, then try again.' : 'Screen sharing could not start. Check the system permission and try again.';
}
