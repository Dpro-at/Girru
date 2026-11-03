// CODE-OPEN-01 (boards C1–C3): the same action wherever a file is named. One
// word ("Open in Code", ⌘O) and the second item "Show in Finder" (Explorer on
// Windows); no new buttons on rows: an icon that shows on hover or on the
// selected row, the right-click menu, and Enter.
import { IconButton } from './desktop-ui';
import type { MenuItem } from './desktop-ui';
import { codeAvailable, codeOpenNotice, copyPath, finderWord, openInCode, revealFile } from './code-open';

type Requester = Parameters<typeof openInCode>[0];
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent ?? '');
export const OPEN_SHORTCUT = isMac ? '⌘O' : 'Ctrl+O';
const REVEAL_SHORTCUT = isMac ? '⌥⌘R' : 'Shift+Alt+R';
const COPY_SHORTCUT = isMac ? '⌥⌘C' : 'Shift+Alt+C';

/** Open in Code, telling the result in one short notice (nothing on success). */
export async function openFile(client: Requester, path: string, line: number | null | undefined, say: (text: string) => void, options: { readOnly?: boolean } = {}) {
  const note = codeOpenNotice(await openInCode(client, path, line, options));
  if (note) say(note);
}

/** The right-click items for one file (Open in Code first). */
export function fileMenu(client: Requester, path: string, line: number | null | undefined, say: (text: string) => void, options: { readOnly?: boolean } = {}): MenuItem[] {
  const code = codeAvailable();
  return [
    { label: code ? 'Open in Code' : 'Open in Code — Code is not installed', icon: 'code', shortcut: OPEN_SHORTCUT, disabled: !code, run: () => void openFile(client, path, line, say, options) },
    { label: `Show in ${finderWord()}`, icon: 'folder', shortcut: REVEAL_SHORTCUT, run: () => void revealFile(client, path).then(r => { const n = r === 'revealed' ? null : codeOpenNotice(r === 'no_code' ? 'failed' : r); if (n) say(n); }) },
    { label: 'Copy path', icon: 'copy', shortcut: COPY_SHORTCUT, run: () => void copyPath(path).then(ok => say(ok ? 'Path copied.' : 'The path could not be copied.')) },
  ];
}

/** The row icon: Open in Code, or Show in Finder when Code is not installed. */
export function OpenInCodeIcon({ client, path, line, say, readOnly }: { client: Requester; path: string; line?: number | null; say: (text: string) => void; readOnly?: boolean }) {
  const code = codeAvailable();
  return <span className="dk-open-code"><IconButton icon={code ? 'code' : 'folder'} label={code ? 'Open in Code' : `Show in ${finderWord()}`} shortcut={code ? OPEN_SHORTCUT : undefined}
    onClick={e => { e.stopPropagation(); if (code) void openFile(client, path, line, say, { readOnly }); else void revealFile(client, path).then(r => { const n = r === 'revealed' ? null : codeOpenNotice(r); if (n) say(n); }); }}/></span>;
}

/** Keys on a focused file row: Enter / ⌘O open, ⌥⌘R shows in Finder, ⌥⌘C copies the path. */
export function fileKeys(e: React.KeyboardEvent, client: Requester, path: string, line: number | null | undefined, say: (text: string) => void, options: { readOnly?: boolean } = {}) {
  const cmd = e.metaKey || e.ctrlKey; const key = e.key.toLowerCase();
  if ((e.key === 'Enter' && !cmd) || (cmd && !e.altKey && key === 'o')) { e.preventDefault(); void openFile(client, path, line, say, options); }
  else if (cmd && e.altKey && (key === 'r' || e.code === 'KeyR')) { e.preventDefault(); void revealFile(client, path).then(r => { const n = r === 'revealed' ? null : codeOpenNotice(r); if (n) say(n); }); }
  else if (cmd && e.altKey && (key === 'c' || e.code === 'KeyC')) { e.preventDefault(); void copyPath(path).then(ok => say(ok ? 'Path copied.' : 'The path could not be copied.')); }
}
