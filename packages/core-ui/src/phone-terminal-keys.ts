/**
 * The phone's terminal keys (phone boards P24–P26): what each key above the
 * phone's keyboard sends to the shell, and the rules the page keeps inside the
 * Girru phone app (window.girruShell). Pure, so it runs in node tests.
 */

/** True inside the Girru phone app, which sets window.girruShell before the page loads. */
export function isPhoneShell(w: unknown = typeof window === 'undefined' ? undefined : window): boolean {
  const shell = (w as { girruShell?: unknown } | undefined)?.girruShell;
  return !!shell && typeof shell === 'object';
}

/**
 * Face ID (or the passcode) before a sensitive step on the phone (meetings: start, end, approve).
 * Outside the app it is true. The iPhone app answers { type: 'auth.request', reason } with { ok };
 * on Android the step goes ahead (its bridge reply path is not wired here yet).
 */
export async function phoneConfirm(reason: string, w: unknown = typeof window === 'undefined' ? undefined : window): Promise<boolean> {
  if (!isPhoneShell(w)) return true;
  const ios = (w as { webkit?: { messageHandlers?: { girru?: { postMessage?: (m: unknown) => unknown } } } }).webkit?.messageHandlers?.girru;
  if (typeof ios?.postMessage !== 'function') return true;
  try { const r = await ios.postMessage({ type: 'auth.request', reason }) as { ok?: unknown } | null; return !!r && r.ok === true; } catch { return false; }
}

/** A spoken meeting turn on the phone: at most 40 s and small enough for the phone's 256 KiB request. */
export const PHONE_TURN_MS = 40_000;
export const PHONE_AUDIO_CHARS = 240_000;

export interface PhoneKey { id: string; label: string; aria: string; send?: string; mono?: boolean; strong?: boolean }

/** In board order: the most used first, then arrows, then symbols the phone keyboard hides. */
export const PHONE_KEYS: readonly PhoneKey[] = Object.freeze([
  { id: 'ctrl-c', label: '^C', aria: 'Stop (Control C)', send: '\x03', mono: true, strong: true },
  { id: 'ctrl-d', label: '^D', aria: 'Exit (Control D)', send: '\x04', mono: true, strong: true },
  { id: 'esc', label: 'Esc', aria: 'Escape', send: '\x1b' },
  { id: 'tab', label: 'Tab', aria: 'Tab', send: '\t' },
  { id: 'ctrl', label: 'Ctrl', aria: 'Control: the next letter is sent with Control' },
  { id: 'up', label: '↑', aria: 'Up', send: '\x1b[A' },
  { id: 'down', label: '↓', aria: 'Down', send: '\x1b[B' },
  { id: 'left', label: '←', aria: 'Left', send: '\x1b[D' },
  { id: 'right', label: '→', aria: 'Right', send: '\x1b[C' },
  { id: 'pipe', label: '|', aria: 'Pipe', send: '|', mono: true },
  { id: 'tilde', label: '~', aria: 'Tilde', send: '~', mono: true },
  { id: 'slash', label: '/', aria: 'Slash', send: '/', mono: true },
  { id: 'dash', label: '-', aria: 'Dash', send: '-', mono: true },
].map(k => Object.freeze(k)));

/** With the Ctrl key held: a letter or one of @[\]^_ becomes its control code; anything else goes as it is. */
export function withCtrl(data: string): string {
  if (data.length !== 1) return data;
  const c = data.toUpperCase().charCodeAt(0);
  if (c >= 0x40 && c <= 0x5f) return String.fromCharCode(c - 0x40);
  if (data === ' ') return '\x00';
  if (data === '?') return '\x7f';
  return data;
}

/** Lines in pasted text: more than one asks first (each line runs as its own command). */
export function pastedLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
}
