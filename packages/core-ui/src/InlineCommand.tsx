import { useEffect, useState, useSyncExternalStore } from 'react';
import type { TerminalController, TerminalPrefsController } from './terminal';
import { PALETTES } from './terminal-themes';
import { TerminalScreen } from './TerminalPane';

export type CommandRun = { terminal: TerminalController; prefs: TerminalPrefsController; show: () => void };
/** Two views attach the very same PTY controller; mounting a view never runs a command. */
export function InlineCommand({ run, onAgain }: { run: CommandRun; onAgain?: () => void }) {
  const s = useSyncExternalStore(run.terminal.subscribe, run.terminal.getSnapshot, run.terminal.getSnapshot);
  const p = useSyncExternalStore(run.prefs.subscribe, run.prefs.getSnapshot, run.prefs.getSnapshot);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { void run.prefs.load(); }, [run.prefs]);
  const status = s.phase === 'exited' ? s.signal ? `Stopped · signal ${s.signal}` : s.exitCode === undefined ? 'Session ended' : `Exit ${s.exitCode}` : s.phase === 'open' ? 'Running' : s.phase === 'stopping' ? 'Stopping…' : s.phase === 'starting' ? 'Starting…' : s.message || 'Not running';
  return <div className="inline-command" data-expanded={expanded || undefined} data-term-dark={PALETTES[p.theme].dark || undefined} style={{ ['--term-bg' as string]: PALETTES[p.theme].background, ['--term-fg' as string]: PALETTES[p.theme].foreground }}>
    <div className="inline-command-status"><span role="status">{status}</span><span>{s.phase === 'exited' && s.exitCode !== undefined && onAgain && <button type="button" className="link-button" onClick={onAgain}>Run again</button>}{s.phase === 'open' && <button type="button" className="link-button" onClick={() => void run.terminal.stop()}>Stop</button>}<button type="button" className="link-button" onClick={() => setExpanded(v => !v)}>{expanded ? 'Show less' : 'Show all output'}</button><button type="button" className="link-button" onClick={run.show}>Open in Terminal</button></span></div>
    <TerminalScreen terminal={run.terminal} p={p} projectId={s.projectId} visible={true} passive onSize={() => {}}/>
    {s.droppedOutput && <p className="fine-print" role="status">Earlier output is no longer available.</p>}
    {s.message && <p className="fine-print" role="status">{s.message}</p>}
  </div>;
}
