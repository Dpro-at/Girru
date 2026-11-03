// CODE-OPEN-01 (boards C1–C3): one host action for every place that names a
// file. openInCode(path, line?) asks the backend whether the file may open
// (inside one of your projects or Girru's data folder, real path, no links),
// then opens it in Girru's own Code page at that line. A file Girru writes
// shows one note there: saved edits come back to Girru as a review. When the
// Code runtime is missing it shows the file in Finder / Explorer instead.
import { CODE_OPEN_PATH } from './code-open-contract.js';
import type { CodeTarget } from './code-open-contract.js';

type Requester = { request: (r: never) => Promise<{ status: number; body: unknown }> };
export type CodeOpenResult = 'opened' | 'revealed' | 'outside' | 'not_found' | 'not_allowed' | 'no_code' | 'failed';

/** What the shell gives: open a checked file in the Code page (true when it opened). */
export type CodeHost = (target: CodeTarget, options: { readOnly?: boolean }) => Promise<boolean>;
let host: CodeHost | null = null;
let hostReady = false;
/** The signed-in shell registers the Code page (null when the runtime is missing). */
export function setCodeHost(fn: CodeHost | null, available: boolean) { host = fn; hostReady = available && !!fn; }

type RevealBridge = { revealFile?: (file: string) => Promise<unknown> };
const bridge = () => (typeof window === 'undefined' ? undefined : (window as unknown as { dproApp?: RevealBridge }).dproApp);
/** True when Code can open files here (the installed app with its Code runtime). */
export const codeAvailable = () => hostReady;
/** True when the desktop can show a file in Finder / Explorer. */
export const canRevealFile = () => typeof bridge()?.revealFile === 'function';
export const finderWord = () => (typeof navigator !== 'undefined' && /Win/.test(navigator.platform ?? '') ? 'Explorer' : 'Finder');

async function check(client: Requester, path: string, line?: number | null): Promise<CodeTarget | Exclude<CodeOpenResult, 'opened' | 'revealed' | 'no_code'>> {
  try {
    const r = await client.request({ method: 'POST', path: CODE_OPEN_PATH, body: line ? { path, line } : { path } } as never);
    if (r.status === 200) return r.body as CodeTarget;
    const code = (r.body as { code?: string } | null)?.code;
    return code === 'outside' || code === 'not_found' || code === 'not_allowed' ? code : 'failed';
  } catch { return 'failed'; }
}

/** Show in Finder / Explorer (the same check first: only files you may open). */
export async function revealFile(client: Requester, path: string): Promise<CodeOpenResult> {
  const t = await check(client, path);
  if (typeof t === 'string') return t;
  if (!canRevealFile()) return 'no_code';
  try { return (await bridge()!.revealFile!(t.path)) === true ? 'revealed' : 'failed'; } catch { return 'failed'; }
}

/** Open in Code (⌘O): the file at its line; Show in Finder when Code is not installed. */
export async function openInCode(client: Requester, path: string, line?: number | null, options: { readOnly?: boolean } = {}): Promise<CodeOpenResult> {
  const t = await check(client, path, line);
  if (typeof t === 'string') return t;
  if (host && hostReady) { try { if (await host(t, options)) return 'opened'; } catch { /* falls back below */ } }
  if (canRevealFile()) { try { if ((await bridge()!.revealFile!(t.path)) === true) return 'revealed'; } catch { /* reported below */ } }
  return 'no_code';
}

/** The short notice for a result (nothing for a plain success). */
export function codeOpenNotice(r: CodeOpenResult): string | null {
  switch (r) {
    case 'opened': return null;
    case 'revealed': return `Code is not installed. The file is shown in ${finderWord()}.`;
    case 'outside': return 'This file is outside your projects.';
    case 'not_found': return 'This file is not on this computer.';
    case 'not_allowed': return 'This file does not open in Code.';
    case 'no_code': return 'Code is not installed. Open the Girru app to see the file.';
    default: return 'The file could not be opened.';
  }
}

/** Copy path (⌥⌘C). */
export async function copyPath(path: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(path); return true; } catch { return false; }
}

/** The path of a file in a folder ('/' or '\' as the folder uses). */
export const joinPath = (folder: string, file: string) => {
  const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return `${folder.replace(/[\\/]+$/, '')}${sep}${file.replace(/^[\\/]+/, '').split(/[\\/]/).join(sep)}`;
};
