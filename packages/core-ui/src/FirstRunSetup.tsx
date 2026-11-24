import {JoinStart, NameThisComputer, SetupRoad, quietDiscovery, readSetupEntry, writeSetupEntry, setupRoad, type QuietDiscoveryProgress} from './ComputerStart';
import {useAccountStatus} from './ComputerJoin';
import { DiscoveryStream } from './DiscoveryStream';
import { SetupOrb } from './SetupOrb';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionClient } from './session';
import { UiIcon } from './ui-icons';
import { ClaudeCodeIcon, CodexIcon, GeminiIcon } from './brand-icons';
import { TerminalPane } from './TerminalPane';
import { TerminalPrefsController, TerminalTabs } from './terminal';
import { CompanyController } from './company';
import { TeamFlow } from './CompanyWizard';
import { WorkspaceTypeStep, type WorkspaceType } from './WorkspaceTypeStep';
import { useAppTheme } from './app-navigation';
import { PhoneSetupStep } from './PhonePairing';
import { SetupHelperPill } from './MemoryHelper';

/** FIRSTRUN-01 (boards FR2–FR3): the steps after the owner account, in the one setup window. */
export type FirstRunStep = 'discovery' | 'tools' | 'model' | 'team' | 'phone';
const STEPS = ['Account', 'Your files', 'AI tools', 'Team', 'Phone'] as const;
export type AiTool = { id: 'claude' | 'codex' | 'gemini'; name: string; installed: boolean; signedIn: boolean; install: string | null; signIn: string; needs?: 'node' };
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
export function useFirstRun(client: SessionClient, owner: boolean): { pending: boolean | null; step: FirstRunStep; workspaceType?: WorkspaceType; companyName?: string; companyKind?: string } {
  const [state, setState] = useState<{ pending: boolean | null; step: FirstRunStep; workspaceType?: WorkspaceType; companyName?: string; companyKind?: string }>({ pending: owner ? null : false, step: 'tools' });
  useEffect(() => {
    if (!owner) { setState({ pending: false, step: 'tools' }); return; }
    let live = true;
    void get<{ pending: boolean; step: FirstRunStep; workspaceType?: WorkspaceType; companyName?: string; companyKind?: string }>(client, '/api/first-run').then(r => { if (live) setState({ pending: !!r?.pending, step: r?.step ?? 'tools', workspaceType: r?.workspaceType, companyName: r?.companyName, companyKind: r?.companyKind }); });
    return () => { live = false; };
  }, [client, owner]);
  return state;
}

/** Clears what is typed on the shell's line first (Ctrl+U; Esc in PowerShell), so an earlier command is not run with it. */
const CLEAR_LINE = typeof navigator !== 'undefined' && /win/i.test(navigator.platform) ? '\u001b' : '\u0015';
/**
 * The tab a setup command is typed into: one that has not run a setup command yet (and is still open),
 * else a new tab. A command is never typed into a tab where an earlier one may still run, such as a
 * sign-in waiting for the browser (Install on the Local model step once went into Claude's prompt).
 */
export function setupTab<T extends { key: string }>(tabs: { getSnapshot(): { tabs: readonly T[]; active: string | null }; add(): T | null; select(key: string): void }, used: ReadonlySet<string>): T | null {
  const free = tabs.getSnapshot().tabs.find(tab => !used.has(tab.key));
  if (free) { tabs.select(free.key); return free; }
  return tabs.add();
}
/** Runs a fixed command in Girru's terminal when the owner presses Install or Sign in (Mohamed 2026-10-30: no extra Enter); the output stays in view. */
export function useSetupTerminal(client: SessionClient) {
  const t = useMemo(() => ({ tabs: new TerminalTabs(client), prefs: new TerminalPrefsController(client) }), [client]);
  const [shown, setShown] = useState<string | null>(null);
  const used = useMemo(() => new Set<string>(), [t]);
  useEffect(() => () => t.tabs.dispose(), [t]);
  const type = (label: string, command: string) => {
    setShown(label);
    const tab = setupTab(t.tabs, used);
    if (!tab) return;
    used.add(tab.key);
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

export function FirstRunSetup({ client, initialStep, workspaceType: initialType, companyName: initialName, companyKind, onDone }: { client: SessionClient; initialStep: FirstRunStep; workspaceType?: WorkspaceType; companyName?: string; companyKind?: string; onDone: (chatId: string | null) => void }) {
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
  // DEVICES-PROJECT-01 (CP1–CP2): “Sign in” on the welcome joins an account that may already have computers.
  const [chosen, setEntry] = useState(readSetupEntry);
  const [alone, setAlone] = useState(false);
  const account = useAccountStatus(client);
  const entry = alone ? null : chosen ?? setupRoad(account);
  const [joined, setJoined] = useState<{ from: string; comes: string; name: string } | null>(null);
  const [named, setNamed] = useState(false);
  const [teamCompleted, setTeamCompleted] = useState(initialStep === 'phone');
  const finishing = useRef(false);
  const [preparing, setPreparing] = useState(false);
  const [scan, setScan] = useState<QuietDiscoveryProgress | null>(null);
  const [scanFailed, setScanFailed] = useState(false);
  // CP12 E: the files scan runs quietly in the background; the road goes straight on to AI tools.
  const startSame = async () => {
    setPreparing(true); setScanFailed(false);
    void quietDiscovery(client, setScan).then(ok => { if (!ok) setScanFailed(true); }).finally(() => setPreparing(false));
    await go('tools');
  };
  /* The scan runs in the backend, so the owner can go on and let it finish in the background. */
  const continueInBackground = () => go('tools');
  useEffect(() => { if (entry === 'same' && step === 'discovery' && !preparing) void startSame(); }, [entry, step]);
  const terminal = useSetupTerminal(client);
  useEffect(() => { void window.dproApp?.setSetupWindow?.(true).catch(() => {}); }, []);
  const go = async (s: FirstRunStep) => {
    setStepNotice(undefined);
    const response = await save(client, s);
    if (response?.status === 200) setStep(s);
    else setStepNotice('Could not save this step. Try again before continuing.');
  };
  const finish = async () => {
    if (finishing.current) return;
    finishing.current = true;
    try {
      const r = await client.request({ method: 'POST', path: '/api/first-run/finish' } as never);
      if (r.status !== 200) throw Error();
      void window.dproApp?.setSetupWindow?.(false).catch(() => {});
      writeSetupEntry(null);
      onDone((r.body as { conversationId?: string } | null)?.conversationId ?? null);
    } catch {
      setStepNotice('Could not finish setup. Try again.');
    } finally {
      finishing.current = false;
    }
  };
  const appearance = useAppTheme();
  return <div className="shell app-shell first-run-shell" data-theme={appearance.theme} lang="en" dir="ltr"><main className="first-run-setup" aria-label="Set up Girru">
    {!named ? <NameThisComputer client={client} onDone={() => setNamed(true)}/>
    : entry === 'signin' ? <JoinStart client={client} onFresh={() => { writeSetupEntry(null); setEntry(null); setAlone(true); }} onSame={(from, comes, name) => { writeSetupEntry('same'); setJoined({ from, comes, name }); setEntry('same'); }}/>
    : entry === 'same' ? <>
      {stepNotice && <p className="setup-note" role="alert">{stepNotice}</p>}
      {step === 'discovery' ? <section className="setup-note join-scan" role="status" aria-live="polite">
            <SetupRoad at={4}/>
            {scanFailed ? <><p>Looking through this computer did not finish.</p><div className="setup-actions"><button type="button" className="primary" onClick={() => void startSame()}>Try again</button></div></>
            : <><p><b>Getting this computer ready</b></p>
              <p>Girru is looking through this computer for your projects and notes. Nothing leaves this computer. On a big disk this can take a few minutes. You do not need to do anything on {joined?.from ?? 'your other computer'} now.</p>
              {scan && scan.status === 'scanning' && <p>{scan.scanned.toLocaleString()} files looked at · {scan.projects} projects · {scan.notes} notes</p>}
              {scan && scan.status === 'scanning' && <div className="setup-actions"><button type="button" className="primary" onClick={() => void continueInBackground()}>Continue, keep looking in the background</button></div>}</>}
          </section>
        : <><SetupRoad at={4}/><ToolsStep client={client} terminal={terminal} onNext={() => void finish()} transferSource={joined?.from}/></>}
    </>
    : !workspaceType || (workspaceType === 'company' && !companyName) ? <WorkspaceTypeStep value={workspaceType} companyName={companyName} busy={savingType} notice={typeNotice} onNext={(type, name) => void chooseType(type, name)}/> : <>
    {step !== 'discovery' && <SetupOrb/>}
    <SetupSteps current={step === 'discovery' ? 'Your files' : step === 'tools' || step === 'model' ? 'AI tools' : step === 'phone' ? 'Phone' : 'Team'}/>
    {stepNotice && <p className="setup-note" role="alert">{stepNotice}</p>}
    {step === 'discovery' && <DiscoveryStep client={client} onNext={() => go('tools')}/>}
    {(step === 'tools' || step === 'model') && <ToolsStep client={client} terminal={terminal} onNext={() => go(teamCompleted ? 'phone' : 'team')}/>}
    {step === 'team' && <TeamStep client={client} workspaceType={workspaceType} companyKind={workspaceType === 'company' ? companyKind : undefined} onReady={() => { setTeamCompleted(true); void go('phone'); }} onBack={() => go('tools')}/>}
    {step === 'phone' && <PhoneSetupStep client={client} onBack={() => setStep('tools')} onDone={finish}/>}
    </>}
    {/* MODELS-01-INSTALL (M1–M2): the memory helper installs itself; one quiet pill in the step's bottom bar, no step and no choice. */}
    <SetupHelperPill client={client}/>
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
    <div className="setup-actions">
      {(error || result?.status === 'error') && <button type="button" onClick={onRetry}>Try again</button>}
      <button type="button" className="primary" disabled={error || result?.status !== 'done'} onClick={onNext}>Next</button>
    </div>
  </section>;
}

type Terminal = ReturnType<typeof useSetupTerminal>;

function ToolsStep({ client, terminal, onNext, transferSource }: { client: SessionClient; terminal: Terminal; onNext: () => void; transferSource?: string }) {
  const [tools, setTools] = useState<AiTool[] | null>(null);
  const [modelsOpen, setModelsOpen] = useState(false);
  const read = async () => { const r = await get<{ tools: AiTool[] }>(client, '/api/first-run/tools'); if (r) setTools(r.tools); };
  useEffect(() => { void read(); }, [client]);
  // While the terminal is open, look again every few seconds: a row turns green by itself after sign-in.
  useEffect(() => { if (!terminal.open) return; const t = setInterval(() => void read(), 3000); return () => clearInterval(t); }, [terminal.open]);
  const none = !!tools && !tools.some(t => t.installed);
  return <section className="setup-pane" aria-label="Your AI tools">
    <h2>Your AI tools</h2>
    <p>{none ? 'None of them is on this computer yet.' : 'Choose which tools your agents can use.'}</p>
    {!tools ? <p role="status">Looking at this computer…</p> : <ul className="setup-rows">{tools.map(t => <li key={t.id} className="setup-row">
      <span className="setup-mark" data-tool={t.id} aria-hidden="true">{t.id === 'claude' ? <ClaudeCodeIcon size={18}/> : t.id === 'codex' ? <CodexIcon size={18}/> : <GeminiIcon size={18}/>}</span>
      <span className="setup-row-text"><b>{t.name}</b><small data-state={t.signedIn ? 'ok' : t.installed ? 'warn' : undefined}>
        {t.signedIn ? 'Installed · signed in' : t.installed ? 'Installed · not signed in' : t.needs === 'node' ? 'Not installed · needs Node.js first' : 'Not installed'}</small></span>
      {t.signedIn ? <UiIcon name="check" size={16}/>
        : t.installed ? <button type="button" onClick={() => terminal.type(t.name, t.signIn)}>Sign in</button>
        : t.install ? <button type="button" onClick={() => terminal.type(t.name, t.install!)}><UiIcon name="download" size={13}/>Install</button> : null}
    </li>)}
      <li>
        <div className="setup-row">
          <span className="setup-row-text"><b>Ollama</b><small>Local model · Optional</small></span>
          <button type="button" aria-expanded={modelsOpen} onClick={() => setModelsOpen(!modelsOpen)}>{modelsOpen ? 'Hide models' : 'Choose model'}</button>
        </div>
        {modelsOpen && <LocalModelPicker client={client} terminal={terminal}/>}
      </li>
    </ul>}
    {terminal.pane}
    {transferSource && <p className="fine-print">In Computers on {transferSource}, approve the transfer. Then open Computers on this device and select Apply all.</p>}
    <div className="setup-actions"><button type="button" className="primary" disabled={!tools} onClick={onNext}>Continue</button></div>
  </section>;
}

function LocalModelPicker({ client, terminal }: { client: SessionClient; terminal: Terminal }) {
  const [info, setInfo] = useState<LocalStep | null>(null);
  const [pick, setPick] = useState('');
  const [started, setStarted] = useState(false);
  useEffect(() => { void get<LocalStep>(client, '/api/first-run/local-model').then(r => { if (r) { setInfo(r); setPick(''); } }); }, [client]);
  const has = !!info?.choices.find(c => c.id === pick)?.installed;
  const command = info?.commands[pick] ?? null;
  const install = () => { if (command) { terminal.type('Local model', command); setStarted(true); } };
  return <div aria-label="Ollama models">
    {!info ? <p role="status">Looking at this computer…</p> : <div role="radiogroup" aria-label="Local model" className="setup-rows">{info.choices.map(c =>
      <label key={c.id} className="setup-row setup-choice" data-on={pick === c.id || undefined}>
        <input type="radio" name="local-model" aria-label={c.label} checked={pick === c.id} onChange={() => { setPick(c.id); setStarted(false); }}/>
        <span className="setup-row-text"><b>{c.label} {c.id === info.recommended && <span className="badge setup-recommended">Recommended for this computer</span>}</b><small>{c.installed ? 'Already on this computer.' : info.memoryGb < c.minMemoryGb ? `Too big for this computer: it can slow it down or make it stop. ${c.note}` : c.note}</small></span>
        {c.sizeGb > 0 && <span className="setup-size">{c.sizeGb} GB</span>}
      </label>)}</div>}
    {info?.download && !info.ollama && <p className="setup-note" role="note"><UiIcon name="info" size={14}/>Girru runs local models with Ollama, a free program. <a href={info.download} target="_blank" rel="noreferrer">Download Ollama</a>, open it once, then come back and press Install.</p>}
    <div className="setup-actions"><button type="button" disabled={!command || has || started} onClick={install}>Install</button></div>
  </div>;
}

function TeamStep({ client, workspaceType, companyKind, onReady, onBack }: { client: SessionClient; workspaceType: WorkspaceType; companyKind?: string; onReady: () => void; onBack: () => void }) {
  const controller = useMemo(() => new CompanyController(client), [client]);
  useEffect(() => () => controller.dispose(), [controller]);
  return <TeamFlow controller={controller} workspaceType={workspaceType} companyKind={companyKind} mode="setup" onBack={onBack} onHired={onReady}/>;
}
