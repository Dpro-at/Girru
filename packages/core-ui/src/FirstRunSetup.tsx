import { DiscoveryStream } from './DiscoveryStream';
import { SetupOrb } from './SetupOrb';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { SessionClient } from './session';
import { UiIcon } from './ui-icons';
import { ClaudeCodeIcon, CodexIcon, GeminiIcon } from './brand-icons';
import { TerminalPane } from './TerminalPane';
import { TerminalPrefsController, TerminalTabs } from './terminal';
import { CompanyController } from './company';
import { TeamFlow } from './CompanyWizard';
import { DepartmentTile } from './StaffDirectory';
import { AgentsController } from './agents';
import { WorkspaceTypeStep, type WorkspaceType } from './WorkspaceTypeStep';
import { useAppTheme } from './app-navigation';

/** FIRSTRUN-01 (boards FR2–FR3): the steps after the owner account, in the one setup window. */
export type FirstRunStep = 'discovery' | 'tools' | 'model' | 'team';
const STEPS = ['Account', 'Your files', 'AI tools', 'Local model', 'Team'] as const;
type AiTool = { id: 'claude' | 'codex' | 'gemini'; name: string; installed: boolean; signedIn: boolean; install: string | null; signIn: string; needs?: 'node' };
type LocalChoice = { id: string; label: string; sizeGb: number; note: string; minMemoryGb: number; installed?: boolean };
type LocalStep = { memoryGb: number; recommended: string; choices: LocalChoice[]; ollama: boolean; installed: string[]; download: string | null; commands: Record<string, string | null> };

/** The step dots at the top of the setup window. */
export function SetupSteps({ current }: { current: (typeof STEPS)[number] }) {
  const at = STEPS.indexOf(current);
  return <ol className="setup-steps" aria-label="Setup steps">{STEPS.map((s, i) =>
    <li key={s} aria-current={i === at ? 'step' : undefined} data-done={i < at || undefined}>{s}</li>)}</ol>;
}

async function get<T>(client: SessionClient, path: string): Promise<T | null> {
  try { const r = await client.request({ method: 'GET', path } as never); return r.status === 200 ? r.body as T : null; } catch { return null; }
}
const save = (client: SessionClient, step: FirstRunStep) => client.request({ method: 'PUT', path: '/api/first-run', body: { step } } as never).catch(() => null);

/** True while the signed-in owner still has setup steps to do (null while asking). */
export function useFirstRun(client: SessionClient, owner: boolean): { pending: boolean | null; step: FirstRunStep; workspaceType?: WorkspaceType; companyName?: string } {
  const [state, setState] = useState<{ pending: boolean | null; step: FirstRunStep; workspaceType?: WorkspaceType; companyName?: string }>({ pending: owner ? null : false, step: 'tools' });
  useEffect(() => {
    if (!owner) { setState({ pending: false, step: 'tools' }); return; }
    let live = true;
    void get<{ pending: boolean; step: FirstRunStep; workspaceType?: WorkspaceType; companyName?: string }>(client, '/api/first-run').then(r => { if (live) setState({ pending: !!r?.pending, step: r?.step ?? 'tools', workspaceType: r?.workspaceType, companyName: r?.companyName }); });
    return () => { live = false; };
  }, [client, owner]);
  return state;
}

/** Clears what is typed on the shell's line first (Ctrl+U; Esc in PowerShell), so an earlier command is not run with it. */
const CLEAR_LINE = typeof navigator !== 'undefined' && /win/i.test(navigator.platform) ? '\u001b' : '\u0015';
/** Runs a fixed command in Girru's terminal when the owner presses Install or Sign in (Mohamed 2026-10-30: no extra Enter); the output stays in view. */
function useSetupTerminal(client: SessionClient) {
  const t = useMemo(() => ({ tabs: new TerminalTabs(client), prefs: new TerminalPrefsController(client) }), [client]);
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => () => t.tabs.dispose(), [t]);
  const type = (label: string, command: string) => {
    setShown(label);
    const tab = t.tabs.getSnapshot().tabs[0] ?? t.tabs.add();
    if (!tab) return;
    // Type once the shell has printed its prompt, so the command is not echoed before it.
    let typed = false;
    const off = tab.terminal.onOutput(() => { if (typed) return; typed = true; setTimeout(() => { off(); tab.terminal.write(CLEAR_LINE + command + '\r'); }, 150); });
  };
  const pane = shown ? <div className="setup-terminal" aria-label={`Terminal · ${shown}`}>
    <p className="setup-terminal-note"><UiIcon name="terminal" size={13}/>{shown}: running in Girru's terminal. You can watch it here.</p>
    <TerminalPane tabs={t.tabs} prefs={t.prefs} projectId={null} maximized={false} onToggleMax={() => {}} onClose={() => setShown(null)}/>
  </div> : null;
  return { type, pane, open: !!shown };
}

export function FirstRunSetup({ client, initialStep, workspaceType: initialType, companyName: initialName, onDone }: { client: SessionClient; initialStep: FirstRunStep; workspaceType?: WorkspaceType; companyName?: string; onDone: (chatId: string | null) => void }) {
  const [step, setStep] = useState<FirstRunStep>(initialStep);
  const [stepNotice, setStepNotice] = useState<string>();
  const [workspaceType, setWorkspaceType] = useState(initialType);
  const [companyName, setCompanyName] = useState(initialName);
  const [savingType, setSavingType] = useState(false);
  const [typeNotice, setTypeNotice] = useState<string>();
  const chooseType = async (type: WorkspaceType, name?: string) => {
    setSavingType(true); setTypeNotice(undefined);
    try {
      const r = await client.request({ method: 'PUT', path: '/api/first-run', body: { step, workspaceType: type, ...(type === 'company' ? { companyName: name } : {}) } } as never);
      if (r.status !== 200 || (r.body as { workspaceType?: string })?.workspaceType !== type) throw Error();
      setWorkspaceType(type); setCompanyName(name);
    } catch { setTypeNotice('Could not save your choice. Try again.'); }
    finally { setSavingType(false); }
  };
  const [signedIn, setSignedIn] = useState(false);
  const terminal = useSetupTerminal(client);
  useEffect(() => { void window.dproApp?.setSetupWindow?.(true).catch(() => {}); }, []);
  // "Skip" on the local model needs a signed-in subscription, also when setup continues at that step.
  useEffect(() => { void get<{ tools: AiTool[] }>(client, '/api/first-run/tools').then(r => { if (r) setSignedIn(r.tools.some(t => t.signedIn)); }); }, [client]);
  const go = async (s: FirstRunStep) => {
    setStepNotice(undefined);
    const response = await save(client, s);
    if (response?.status === 200) setStep(s);
    else setStepNotice('Could not save this step. Try again before continuing.');
  };
  const finish = async () => {
    let chatId: string | null = null;
    try { const r = await client.request({ method: 'POST', path: '/api/first-run/finish' } as never); chatId = (r.body as { conversationId?: string } | null)?.conversationId ?? null; } catch { /* the workspace opens anyway */ }
    void window.dproApp?.setSetupWindow?.(false).catch(() => {});
    onDone(chatId);
  };
  const appearance = useAppTheme();
  return <div className="shell app-shell first-run-shell" data-theme={appearance.theme} lang="en" dir="ltr"><main className="first-run-setup" aria-label="Set up Girru">
    {!workspaceType || (workspaceType === 'company' && !companyName) ? <WorkspaceTypeStep value={workspaceType} companyName={companyName} busy={savingType} notice={typeNotice} onNext={(type, name) => void chooseType(type, name)}/> : <>
    {step !== 'discovery' && <SetupOrb/>}
    <SetupSteps current={step === 'discovery' ? 'Your files' : step === 'tools' ? 'AI tools' : step === 'model' ? 'Local model' : 'Team'}/>
    {stepNotice && <p className="setup-note" role="alert">{stepNotice}</p>}
    {step === 'discovery' && <DiscoveryStep client={client} onNext={() => go('tools')}/>}
    {step === 'tools' && <ToolsStep client={client} terminal={terminal} onSignedIn={setSignedIn} onNext={() => go('model')}/>}
    {step === 'model' && <ModelStep client={client} terminal={terminal} canSkip={signedIn} onBack={() => go('tools')} onNext={() => go('team')}/>}
    {step === 'team' && <TeamStep client={client} workspaceType={workspaceType} onBack={() => go('model')} onDone={finish}/>}
    </>}
  </main></div>;
}

export type SetupDiscovery = {
  samples?: Array<{kind: 'folder' | 'file' | 'memory' | 'skill' | 'mcp' | 'ssh'; name: string}>;
  folderNames?: string[];
  status: 'idle' | 'scanning' | 'done' | 'error'; scanned: number;
  counts: Record<'projects' | 'memories' | 'notes' | 'skills' | 'mcp' | 'ssh', number>;
  denied: number; unavailable: number; limited: boolean; notice: string;
};

export function DiscoveryStep({ client, onNext }: { client: SessionClient; onNext: () => void }) {
  const [result, setResult] = useState<SetupDiscovery | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true; let timer: ReturnType<typeof setTimeout> | undefined;
    async function read(start = false) {
      try {
        let response = await client.request({ method: 'GET', path: '/api/first-run/discovery' } as never);
        if (response.status !== 200) throw Error();
        let next = response.body as SetupDiscovery;
        if (start && (next.status === 'idle' || next.status === 'scanning' || (retry > 0 && next.status === 'error'))) {
          response = await client.request({ method: 'POST', path: '/api/first-run/discovery' } as never);
          if (response.status !== 200) throw Error();
          next = response.body as SetupDiscovery;
        }
        if (!live) return;
        setResult(next); setError(false);
        if (next.status === 'scanning') timer = setTimeout(() => void read(), 1000);
      } catch { if (live) setError(true); }
    }
    void read(true);
    return () => { live = false; clearTimeout(timer); };
  }, [client, retry]);
  return <DiscoveryInventoryView result={result} error={error} onRetry={() => setRetry(value => value + 1)} onNext={onNext}/>;
}

export function DiscoveryInventoryView({ result, error = false, onRetry, onNext }: { result: SetupDiscovery | null; error?: boolean; onRetry: () => void; onNext: () => void }) {
  const running = !error && (!result || result.status === 'idle' || result.status === 'scanning');
  const labels = { projects: 'Projects', memories: 'Memory files', notes: 'Project notes', skills: 'Skills', mcp: 'MCP connections', ssh: 'SSH identities' } as const;
  return <section className="setup-pane setup-discovery" data-running={running || undefined} aria-label="Find your files">
    <h2>Discovering your work</h2>
    <p>Finding projects, memory and tools on this computer.</p>
    <div className="setup-discovery-visual"><DiscoveryStream items={result?.samples?.length ? result.samples : (result?.folderNames ?? []).map(name => ({ kind: 'folder' as const, name }))}/><SetupOrb large active={running}/></div>
    {(running || result?.status === 'done') && <div className="setup-search-progress" data-complete={result?.status === 'done' || undefined}><progress aria-label={running ? 'Searching this computer' : 'Search complete'} {...(running ? {} : {value:1,max:1})}/><span aria-hidden="true"/></div>}
    <p role="status">{error ? 'Could not read the search progress. Try again.' : result?.notice || 'Starting the search…'}</p>
    <dl className="setup-discovery-counts">{(Object.keys(labels) as Array<keyof typeof labels>).map(key => <div key={key}><UiIcon name={key === 'projects' ? 'folder' : key === 'ssh' ? 'key' : key === 'skills' ? 'sparkle' : key === 'mcp' ? 'tool' : 'file'} size={20}/><dt>{labels[key]}</dt><dd>{(result?.counts[key] ?? 0).toLocaleString('en-US')}</dd></div>)}</dl>
    <p className="fine-print">{result?.scanned ?? 0} entries checked{result?.denied ? ` · ${result.denied} ${result.denied === 1 ? 'folder' : 'folders'} denied access` : ''}{result?.unavailable ? ` · ${result.unavailable} ${result.unavailable === 1 ? 'folder' : 'folders'} unavailable` : ''}.</p>
    {result?.limited && <p className="setup-note">Some locations could not be fully searched. The results show what Girru could reach.</p>}
    <p className="fine-print">Your source files stay unchanged. Memory imports begin after your team is ready. Skills and MCP connections wait for your approval; private SSH key contents are never read or imported.</p>
    <div className="setup-actions">
      {(error || result?.status === 'error') && <button type="button" onClick={onRetry}>Try again</button>}
      <button type="button" className="primary" disabled={error || result?.status !== 'done'} onClick={onNext}>Next</button>
    </div>
  </section>;
}

type Terminal = ReturnType<typeof useSetupTerminal>;

function ToolsStep({ client, terminal, onSignedIn, onNext }: { client: SessionClient; terminal: Terminal; onSignedIn: (v: boolean) => void; onNext: () => void }) {
  const [tools, setTools] = useState<AiTool[] | null>(null);
  const read = async () => { const r = await get<{ tools: AiTool[] }>(client, '/api/first-run/tools'); if (r) { setTools(r.tools); onSignedIn(r.tools.some(t => t.signedIn)); } };
  useEffect(() => { void read(); }, [client]);
  // While the terminal is open, look again every few seconds: a row turns green by itself after sign-in.
  useEffect(() => { if (!terminal.open) return; const t = setInterval(() => void read(), 3000); return () => clearInterval(t); }, [terminal.open]);
  const any = !!tools?.some(t => t.signedIn);
  const none = !!tools && !tools.some(t => t.installed);
  return <section className="setup-pane" aria-label="Your AI tools">
    <h2>Your AI tools</h2>
    <p>{none ? 'None of them is on this computer yet.' : 'Your agents think with these. Sign in to at least one; your own subscription pays, Girru adds nothing.'}</p>
    {!tools ? <p role="status">Looking at this computer…</p> : <ul className="setup-rows">{tools.map(t => <li key={t.id} className="setup-row">
      <span className="setup-mark" data-tool={t.id} aria-hidden="true">{t.id === 'claude' ? <ClaudeCodeIcon size={18}/> : t.id === 'codex' ? <CodexIcon size={18}/> : <GeminiIcon size={18}/>}</span>
      <span className="setup-row-text"><b>{t.name}</b><small data-state={t.signedIn ? 'ok' : t.installed ? 'warn' : undefined}>
        {t.signedIn ? 'Installed · signed in' : t.installed ? 'Installed · not signed in' : t.needs === 'node' ? 'Not installed · needs Node.js first' : 'Not installed'}</small></span>
      {t.signedIn ? <UiIcon name="check" size={16}/>
        : t.installed ? <button type="button" onClick={() => terminal.type(t.name, t.signIn)}>Sign in</button>
        : t.install ? <button type="button" onClick={() => terminal.type(t.name, t.install!)}><UiIcon name="download" size={13}/>Install</button> : null}
    </li>)}</ul>}
    {terminal.pane ?? <p className="fine-print">"Install" and "Sign in" run in Girru's terminal here, so you can see what happens.</p>}
    {tools && !any && <p className="setup-note" role="note"><UiIcon name="info" size={14}/>No subscription? Continue with only the free local model (next step). Agents will be slower and simpler.</p>}
    <div className="setup-actions"><button type="button" className="primary" disabled={!tools} onClick={onNext}>Continue</button></div>
  </section>;
}

function ModelStep({ client, terminal, canSkip, onBack, onNext }: { client: SessionClient; terminal: Terminal; canSkip: boolean; onBack: () => void; onNext: () => void }) {
  const [info, setInfo] = useState<LocalStep | null>(null);
  const [pick, setPick] = useState('');
  const [started, setStarted] = useState(false);
  useEffect(() => { void get<LocalStep>(client, '/api/first-run/local-model').then(r => { if (r) { setInfo(r); setPick(r.recommended); } }); }, [client]);
  const has = !!info?.choices.find(c => c.id === pick)?.installed;
  const command = info?.commands[pick] ?? null;
  const install = () => { if (command) { terminal.type('Local model', command); setStarted(true); } };
  return <section className="setup-pane" aria-label="A free model on this computer">
    <h2>A free model on this computer</h2>
    <p>Private and offline. Girru uses it for small, frequent work (sorting tasks, short replies, memory) so your subscription lasts longer.{info ? ` This computer has ${info.memoryGb} GB of memory.` : ''}</p>
    {!info ? <p role="status">Looking at this computer…</p> : <div role="radiogroup" aria-label="Local model" className="setup-rows">{info.choices.map(c =>
      <label key={c.id} className="setup-row setup-choice" data-on={pick === c.id || undefined}>
        <input type="radio" name="local-model" aria-label={c.label} checked={pick === c.id} onChange={() => setPick(c.id)}/>
        <span className="setup-row-text"><b>{c.label} {c.id === info.recommended && <span className="badge setup-recommended">Recommended for this computer</span>}</b><small>{c.installed ? 'Already on this computer.' : info.memoryGb < c.minMemoryGb ? `Too big for this computer: it can slow it down or make it stop. ${c.note}` : c.note}</small></span>
        {c.sizeGb > 0 && <span className="setup-size">{c.sizeGb} GB</span>}
      </label>)}</div>}
    {info?.download && !info.ollama && <p className="setup-note" role="note"><UiIcon name="info" size={14}/>Girru runs local models with Ollama, a free program. <a href={info.download} target="_blank" rel="noreferrer">Download Ollama</a>, open it once, then come back and press Install.</p>}
    {terminal.pane ?? <p className="fine-print">Install opens the terminal here: it installs Ollama if needed and downloads the model. You can go on while it downloads.</p>}
    <div className="setup-actions"><button type="button" onClick={onBack}>Back</button>{canSkip && !started && !has && <button type="button" className="link-button" onClick={onNext}>Skip</button>}
      {has || started ? <button type="button" className="primary" onClick={onNext}>Continue</button>
        : <button type="button" className="primary" disabled={!command} onClick={install}>Install</button>}</div>
  </section>;
}

function TeamStep({ client, workspaceType, onBack, onDone }: { client: SessionClient; workspaceType: WorkspaceType; onBack: () => void; onDone: () => void }) {
  const controller = useMemo(() => new CompanyController(client), [client]);
  useEffect(() => () => controller.dispose(), [controller]);
  const [ready, setReady] = useState(false);
  return ready ? <TeamReady client={client} onStart={onDone}/> : <TeamFlow controller={controller} workspaceType={workspaceType} mode="setup" onBack={onBack} onHired={() => setReady(true)}/>;
}

/** A steady colour per name, so each person is told apart at a glance. */
function faceColor(name: string) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 45% 42%)`; }

/** After hiring: the people just hired, by department, then straight to Chat (Mohamed 2026-10-30). */
function TeamReady({ client, onStart }: { client: SessionClient; onStart: () => void }) {
  const agents = useMemo(() => new AgentsController(client), [client]);
  useEffect(() => { void agents.list(); return () => agents.dispose(); }, [agents]);
  const a = useSyncExternalStore(agents.subscribe, agents.getSnapshot, agents.getSnapshot);
  const [starting, setStarting] = useState(false);
  const main = a.agents.find(x => x.isPrimary);
  const groups = new Map<string, typeof a.agents[number][]>();
  for (const x of a.agents) if (!x.isPrimary) { const k = x.department || 'Team'; groups.set(k, [...(groups.get(k) ?? []), x]); }
  return <section className="setup-pane" aria-label="Your team is ready">
    <h2>Your team is ready</h2>
    <p>{main ? `${main.name ?? 'Your Main agent'} leads them and talks to you first.` : 'Your Main agent leads them and talks to you first.'} Everyone asks you before doing anything outside Girru.</p>
    {a.phase === 'listing' && !a.agents.length ? <p role="status">Reading your team…</p> : <ul className="setup-team">
      {[...groups].map(([dep, people]) => <li key={dep}><span className="setup-team-dep"><DepartmentTile department={dep} size={20}/><b>{dep}</b></span>
        <span className="setup-faces">{people.slice(0, 12).map(p => <span key={p.id} className="setup-face" title={p.name ?? ''}><span className="setup-face-dot" aria-hidden="true" style={{ background: faceColor(p.name ?? p.id) }}>{(p.name ?? '?').trim().slice(0, 1).toUpperCase()}</span><small>{p.name}</small></span>)}
          {people.length > 12 && <small className="setup-more">+{people.length - 12}</small>}</span></li>)}
    </ul>}
    <div className="setup-actions"><button type="button" className="primary" disabled={starting} onClick={() => { setStarting(true); onStart(); }}>Start chatting</button></div>
  </section>;
}
