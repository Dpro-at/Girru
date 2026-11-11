import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { TerminalController, TerminalPrefsController, TerminalState } from './terminal';
import { TerminalScreen } from './TerminalPane';
import { UiIcon } from './ui-icons';

export type CommandRun = { terminal: TerminalController; prefs: TerminalPrefsController; show: () => void };

const NO_RUN = { subscribe: () => () => {}, getSnapshot: () => null };
/** The command's terminal state, or null before it has run (hooks stay unconditional). */
export function useCommandState(run: CommandRun | null): TerminalState | null {
  const source = run ? run.terminal : NO_RUN;
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}

/** Plain words for where a command is; tone colours the status line. */
export function commandStatus(s: TerminalState, seconds: number | null): { word: string; tone: 'work' | 'done' | 'fail' | 'quiet' } {
  const took = seconds === null || seconds < 0.1 ? '' : ` · ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  if (s.phase === 'starting') return { word: 'Starting…', tone: 'work' };
  if (s.phase === 'open') return { word: 'Running…', tone: 'work' };
  if (s.phase === 'stopping') return { word: 'Stopping…', tone: 'work' };
  if (s.phase === 'exited') {
    if (s.signal) return { word: `Stopped${took}`, tone: 'quiet' };
    if (s.exitCode === 0) return { word: `Done${took}`, tone: 'done' };
    if (s.exitCode === undefined) return { word: 'Finished', tone: 'quiet' };
    return { word: `Failed · exit ${s.exitCode}${took}`, tone: 'fail' };
  }
  if (s.phase === 'error' && s.id) return { word: 'Connection lost', tone: 'fail' };
  return { word: s.message || 'Could not start', tone: 'fail' };
}

/**
 * The output of a command run from a reply, under the command in the same dark block.
 * It shows the very same session as the Terminal pane; showing it never runs anything.
 */
export function InlineCommand({ run }: { run: CommandRun }) {
  const s = useSyncExternalStore(run.terminal.subscribe, run.terminal.getSnapshot, run.terminal.getSnapshot);
  const p = useSyncExternalStore(run.prefs.subscribe, run.prefs.getSnapshot, run.prefs.getSnapshot);
  const [expanded, setExpanded] = useState(false);
  const [hasOutput, setHasOutput] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = useRef('');
  const startedAt = useRef<number | null>(null), [seconds, setSeconds] = useState<number | null>(null);
  useEffect(() => { void run.prefs.load(); }, [run.prefs]);
  useEffect(() => run.terminal.onOutput(d => {
    text.current = (text.current + d).slice(-200_000);
    if (!d) return;
    setHasOutput(true);
    setVersion(v => v + 1);
  }), [run.terminal]);
  const box = useRef<HTMLDivElement>(null), [width, setWidth] = useState(0), [version, setVersion] = useState(0);
  useEffect(() => {
    const el = box.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth)); ro.observe(el); setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  // Rows the output takes on screen, long lines wrapped at this width.
  const lines = useMemo(() => {
    const cols = Math.max(20, Math.floor((width - 24) / (p.fontSize * 0.6)));
    const plain = text.current.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '').replace(/\n+$/, '');
    return plain ? plain.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / cols)), 0) : 0;
  }, [width, version, p.fontSize]);
  useEffect(() => {
    if (s.phase === 'open' && startedAt.current === null) startedAt.current = Date.now();
    if (s.phase === 'exited' && startedAt.current !== null && seconds === null) setSeconds((Date.now() - startedAt.current) / 1000);
  }, [s.phase, seconds]);
  const status = commandStatus(s, seconds);
  // Always the dark Girru Night colours, so the output matches its command block; size and font stay the owner's.
  const look = { ...p, theme: 'dpro-night' as const };
  // Grows with the output up to six lines (or 20 when opened up), then scrolls.
  const rowPx = Math.ceil(p.fontSize * p.lineHeight * 1.2), shown = Math.max(1, Math.min(expanded ? 20 : 6, lines + 1)) // + the row the cursor ends on;
  const height = hasOutput ? shown * rowPx + 10 : 0;
  const copy = () => {
    // Plain text without terminal colour codes.
    const plain = text.current.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(plain).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined);
  };
  return <div className="inline-command" data-expanded={expanded || undefined} data-output={hasOutput || undefined}>
    <div ref={box} className="inline-command-screen" aria-hidden={!hasOutput || undefined} style={{ blockSize: height }}>
      <TerminalScreen terminal={run.terminal} p={look} projectId={s.projectId} visible={true} passive onSize={() => {}}/>
    </div>
    {s.droppedOutput && <p className="inline-command-note">Earlier lines are only in the Terminal.</p>}
    <div className="inline-command-foot">
      <span className="inline-command-status" data-tone={status.tone} role="status">
        {status.tone === 'work' ? <i className="inline-command-dot" aria-hidden="true"/> : <UiIcon name={status.tone === 'done' ? 'check' : status.tone === 'fail' ? 'alert' : 'stop'} size={12}/>}
        {status.word}
      </span>
      <span className="inline-command-tools">
        {hasOutput && lines > 5 && <button type="button" className="md-code-btn md-icon-btn" aria-label={expanded ? 'Show fewer lines' : 'Show all output'} title={expanded ? 'Show fewer lines' : 'Show all output'} aria-expanded={expanded} onClick={() => setExpanded(v => !v)}><UiIcon name={expanded ? 'shrink' : 'expand'} size={12}/></button>}
        {hasOutput && <button type="button" className="md-code-btn md-icon-btn" aria-label={copied ? 'Output copied' : 'Copy output'} title={copied ? 'Copied' : 'Copy output'} onClick={copy}><UiIcon name={copied ? 'check' : 'copy'} size={12}/></button>}
        <button type="button" className="md-code-btn md-icon-btn" aria-label="Open in Terminal" title="Open in Terminal" onClick={run.show}><UiIcon name="terminal" size={12}/></button>
      </span>
    </div>
  </div>;
}
