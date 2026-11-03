// TASKLOG-01 (board TaskFile): a card's task in its project's task file (.girru/tasks.md).
// On the card: the task number and the logos of the apps that worked on it; the task page
// (BoardTaskPage.tsx) shows the rest and the file itself (TaskFileSheet).
import { useEffect, useRef, useState } from 'react';
import { UiIcon } from './ui-icons';
import { AppMark } from './ChatDetails';
import type { ModelApp } from './ChatDetails';
import type { TaskDetail, TaskMark } from './board';

/** The mark of an app as the file names it (Claude Code, Codex, Gemini or Antigravity; Girru's own agents sign as Girru). */
export function appOf(name: string): ModelApp | null {
  const n = name.trim().toLowerCase();
  if (n === 'claude code' || n === 'claude') return { id: 'subscription:claude', name: 'Claude Code' };
  if (n === 'codex') return { id: 'subscription:codex', name: 'Codex' };
  if (n === 'gemini' || n === 'antigravity') return { id: 'subscription:gemini', name: 'Gemini' };
  return null;
}
export function AppLogo({ name, size = 12 }: { name: string; size?: number }) {
  const app = appOf(name);
  return <span className="task-app" title={name} aria-label={name}>{app ? <AppMark app={app} size={size}/> : <UiIcon name="sparkle" size={size}/>}</span>;
}

/** On a card: the task number (a warning when its block breaks the format) and the apps' logos. */
export function TaskFileMark({ mark }: { mark: TaskMark }) {
  return <span className={`task-file-mark${mark.problem ? ' needs-you' : ''}`} title={mark.problem ? `${mark.no} in the task file of ${mark.projectName}: ${mark.problem}. Fix that line in .girru/tasks.md.` : `${mark.no} in the task file of ${mark.projectName} (.girru/tasks.md)`}>
    <UiIcon name={mark.problem ? 'alert' : 'file'} size={11}/>{mark.no}
    {mark.apps.length > 0 && <span className="task-apps">{mark.apps.slice(0, 4).map(a => <AppLogo key={a} name={a} size={11}/>)}</span>}
  </span>;
}

/** "today 14:05", "yesterday", "3 Nov": when an app last worked on the task. */
export function workedWhen(date: string, at: string | null, now = new Date()): string {
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const y = new Date(now); y.setDate(y.getDate() - 1);
  const time = at?.match(/\d{1,2}:\d{2}/)?.[0] ?? '';
  if (date === day(now)) return time ? `today ${time}` : 'today';
  if (date === day(y)) return 'yesterday';
  const t = Date.parse(`${date}T00:00:00`);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : date;
}
const who = (w: TaskDetail['workedOn'][number]) => w.agent && w.agent !== w.app ? `${w.app} (${w.agent})` : w.app;

/** STORE-MAP-01 P6 (board P6b2): the task's number, who works on it now and who did before. Only with a number (P6 on). */
export function TaskWorkedOn({ detail, now }: { detail: TaskDetail; now?: Date }) {
  if (!detail.number) return null;
  const last = detail.workedOn.at(-1), earlier = detail.workedOn.length > 1 ? detail.workedOn.at(-2) : undefined;
  return <span className="task-worked">
    <span><span className="task-number">{detail.number}</span>{detail.task.title && <b>{detail.task.title}</b>}</span>
    {last && <span><AppLogo name={last.app}/>Worked on by <b>{who(last)}</b>{last.date ? ` · ${workedWhen(last.date, last.at, now)}` : ''}</span>}
    {earlier && <span className="fine-print"><AppLogo name={earlier.app}/>Earlier: {who(earlier)}{earlier.date ? ` · ${workedWhen(earlier.date, earlier.at, now)}` : ''}</span>}
  </span>;
}

/** The task as the file has it, to read and copy. */
export function TaskFileSheet({ text, title, onClose }: { text: string; title: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false), dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="mcp-sheet board-sheet task-file-sheet" aria-label={title} onKeyDown={e => e.stopPropagation()} onCancel={e => { e.preventDefault(); onClose(); }}>
    <header><h2>{title}</h2><button className="tool" aria-label="Copy the task" title="Copy the task" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined); }}><UiIcon name={copied ? 'check' : 'copy'} size={16}/></button><button className="tool" aria-label={`Close ${title}`} onClick={onClose}><UiIcon name="close" size={17}/></button></header>
    <div className="mcp-sheet-body"><pre dir="auto">{text}</pre><p className="fine-print">Change it in the file with any app; the board reads it again by itself.</p></div>
  </dialog>;
}
