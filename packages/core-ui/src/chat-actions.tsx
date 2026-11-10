// CHAT-BUILD-01 follow-up (CH5, CH8): chat actions shared by the sidebar's right-click and the chat's ⋯ menu —
// open a chat in a new window, and continue a chat in another folder (a new chat there, its summary in the box).
import { useEffect, useState } from 'react';
import type { ConversationsController } from './conversations';
import type { Turn } from './turns';
import { ProjectFolderPicker } from './ProjectFolderPicker';
import { chooseProjectDirectories } from './ChatComposerControls';
import { Sheet } from './desktop-ui';

const CHAT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
type ChatWindowBridge = { openChatWindow?: (id: string) => Promise<unknown>; revealFolder?: (folder: string) => Promise<unknown> };

/** Show in Finder / Explorer: only in the desktop app (a browser cannot open the folder). */
export function canRevealFolder(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { dproApp?: ChatWindowBridge }).dproApp?.revealFolder === 'function';
}
export function revealFolder(folder: string) {
  if (canRevealFolder()) void (window as unknown as { dproApp: Required<Pick<ChatWindowBridge, 'revealFolder'>> }).dproApp.revealFolder(folder).catch(() => undefined);
}

/** The chat a window was opened for (`#chat=<id>`), or null. */
export function chatFromLink(hash: string): string | null {
  const m = /^#chat=([A-Za-z0-9][A-Za-z0-9_-]{7,63})$/.exec(hash);
  return m ? m[1] : null;
}

/** ⌘O: the chat in a window of its own (the desktop app opens one; a browser opens a tab). */
export function openChatWindow(id: string) {
  if (!CHAT_ID.test(id) || typeof window === 'undefined') return;
  const bridge = (window as unknown as { dproApp?: ChatWindowBridge }).dproApp;
  if (bridge?.openChatWindow) { void bridge.openChatWindow(id).catch(() => undefined); return; }
  window.open(`${window.location.pathname}#chat=${id}`, '_blank', 'noopener');
}

/** A short summary to start the chat elsewhere: what was asked, and where the last reply left it. */
export function continueSummary(title: string, turns: readonly Turn[]): string {
  const clip = (t: string, n: number) => { const s = t.replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
  const asks = turns.filter(t => t.role === 'user' && t.content.trim());
  const last = [...turns].reverse().find(t => t.role === 'assistant' && t.status === 'complete' && t.content.trim());
  const lines = [`Continue from the chat “${title}” here, in this folder.`];
  if (asks.length) lines.push('', 'What was asked:', ...[asks[0], ...asks.slice(1).slice(-3)].map(t => `- ${clip(t.content, 300)}`));
  if (last) lines.push('', `Where it was left: ${clip(last.content, 1200)}`);
  return lines.join('\n').slice(0, 4000);
}

/** "Continue in another folder…": choose the folder, then a new chat starts there with this chat's summary in the box. */
export function ContinueElsewhere({ controller, chatId, onDone }: { controller: ConversationsController; chatId: string; onDone: () => void }) {
  const [error, setError] = useState('');
  const go = async (folder: string) => {
    const before = controller.getSnapshot();
    if (before.activeId !== chatId) await controller.open(chatId);
    const s = controller.getSnapshot();
    const title = s.conversations.find(c => c.id === chatId)?.title || 'the last chat';
    const summary = continueSummary(title, s.activeId === chatId ? s.turns : []);
    const known = s.projects.find(p => p.folder === folder);
    if (known) { controller.filterProject(known.id); controller.newChat(); }
    else {
      const name = folder.split(/[\\/]/).filter(Boolean).at(-1)?.slice(0, 80) || 'Project';
      const failed = await controller.createProject({ name, folder, repoUrl: '' });
      if (failed) { setError(failed); return; }
    }
    controller.edit(summary);
    onDone();
  };
  // The system window first (Finder / File Explorer); the in-app browser only where there is none (a browser tab).
  const [fallback, setFallback] = useState(false);
  useEffect(() => { let live = true; const bridge = (window as unknown as { dproApp?: { chooseProjectFolders?: (o?: { multiple: boolean }) => Promise<string[]> } }).dproApp;
    void chooseProjectDirectories(false, bridge).then(paths => { if (!live) return; if (paths === null) setFallback(true); else if (paths[0]) void go(paths[0]); else onDone(); }).catch(() => { if (live) setFallback(true); });
    return () => { live = false; }; }, []);
  if (error) return <Sheet title="Continue in another folder" onClose={onDone} actions={<button type="button" onClick={onDone}>Close</button>}><p role="alert">{error}</p></Sheet>;
  return fallback ? <ProjectFolderPicker controller={controller} onClose={onDone} onSelect={p => void go(p)}/> : null;
}
