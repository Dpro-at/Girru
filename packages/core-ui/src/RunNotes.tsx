// STORE-MAP-01 P8c (board RunNotes, D27): a run's working notes — what the agent tried and
// found while it worked. They stay with the run (never in memory), are read only, and are
// cleared 14 days after the run ends. Shown in Runs › a run and in Chat › Details while a
// reply runs; only while the backend's P8 switch is on.
import { useEffect, useState } from 'react';
import { UiIcon } from './ui-icons';
import type { Requester } from './memory-store';
import { clearsWords, noteTime, readRunNotes } from './task-links';
import type { RunNotesState } from './task-links';
import type { RunNoteKind } from './task-links-contract.js';

const LIVE_MS = 4000;

function useRunNotes(client: Requester, at: { id: string; kind: RunNoteKind } | null, live: boolean): RunNotesState | null {
  const [s, setS] = useState<RunNotesState | null>(null);
  const key = at ? `${at.kind}:${at.id}` : '';
  useEffect(() => {
    if (!at) { setS(null); return; }
    let stop = false; let timer: ReturnType<typeof setTimeout> | undefined;
    setS({ phase: 'loading', data: null });
    const read = async () => {
      const r = await readRunNotes(client, at);
      if (stop) return;
      setS(r);
      if (live && r.phase === 'ready') timer = setTimeout(() => void read(), LIVE_MS);
    };
    void read();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [client, key, live]);
  return s;
}

/** Runs › a run: the "Working notes" part of the inspector. */
export function RunWorkingNotes({ client, at, live, onCopy }: { client: Requester; at: { id: string; kind: RunNoteKind }; live: boolean; onCopy: (text: string) => void }) {
  const s = useRunNotes(client, at, live);
  const notes = s?.data?.notes ?? [];
  const copy = () => onCopy(notes.map(n => `${noteTime(n.at)} ${n.text}`.trim()).join('\n'));
  return <>
    <section className="runs-sect run-notes"><h4>Working notes{notes.length > 0 && <span className="runs-insp-tools"><button type="button" className="tool" aria-label="Copy the working notes" title="Copy the working notes" onClick={copy}><UiIcon name="copy" size={13}/></button></span>}</h4>
      {!s || s.phase === 'loading' ? <p role="status" className="fine-print">Reading the working notes…</p>
        : s.phase === 'missing' ? <p className="fine-print">Not available yet.</p>
        : s.phase === 'error' ? <p role="alert" className="fine-print">The working notes could not be read.</p>
        : !notes.length ? <p className="fine-print">No working notes for this run.</p>
        : <pre className="runs-log">{notes.map(n => <span key={n.seq}><b>{noteTime(n.at)}</b>{n.text}{'\n'}</span>)}{live && <span className="runs-live"><i aria-hidden="true"/>live</span>}</pre>}
      {s?.phase === 'ready' && <p className="fine-print">Kept with this run only, never in memory. Read only. {notes.length ? `${clearsWords(s.data?.clearsAt ?? null)[0].toUpperCase()}${clearsWords(s.data?.clearsAt ?? null).slice(1)}.` : 'Cleared 14 days after the run ends.'}</p>}
    </section>
    {live && s?.phase === 'ready' && <section className="runs-sect"><h4>When it ends</h4><p className="fine-print">The notes become the task’s handoff (Done, Left, Next, Blockers, Files touched) and up to 3 suggested lessons in Needs you.</p></section>}
  </>;
}

/** Chat › Details › Results while a reply runs: one folded line "Working notes · 9 lines". Nothing while there are none. */
export function ChatRunNotes({ client, runId }: { client: Requester; runId: string }) {
  const s = useRunNotes(client, { id: runId, kind: 'chat' }, true);
  const notes = s?.phase === 'ready' ? s.data?.notes ?? [] : [];
  if (!notes.length) return null;
  return <details className="details-more run-notes-line">
    <summary><UiIcon name="history" size={12}/>Working notes · {notes.length} {notes.length === 1 ? 'line' : 'lines'}<small>{clearsWords(s?.data?.clearsAt ?? null)}</small></summary>
    <pre className="runs-log">{notes.map(n => <span key={n.seq}><b>{noteTime(n.at)}</b>{n.text}{'\n'}</span>)}</pre>
    <p className="fine-print">Kept with this run only, never in memory. Read only.</p>
  </details>;
}
