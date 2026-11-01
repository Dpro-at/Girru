import { SetupOrb } from './SetupOrb';
import { generatePassword, passwordStrength } from './password-tools.js';
import {UiIcon} from './ui-icons';
import { PublicShell } from './PublicShell';
import { SignedInShell } from './SignedInShell';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { SessionClient } from './session';
import { createLoginMock } from './session-mock';

import { retryAfterNotice } from './retry-after.js';
import { devQuickLoginAccounts } from './dev-quick-login';
import { localSessionKeep } from './local-session-keep';
import { setupCodeFromFragment, SETUP_CODE } from './owner-setup-contract.js';
import type { OwnerSetupCode } from './owner-setup-contract.js';
import { isDeveloperBuild } from './developer-build';
import { SetupSteps } from './FirstRunSetup';
import { WorkspaceTypeStep, type WorkspaceType } from './WorkspaceTypeStep';

const notices = {
  recovered:'Authenticator reset. Sign in again, then set up two-step verification in Settings.',
  published_password: 'Sign-in refused because the password is a published default. Reset it from the CLI.',
  account_inactive: 'This account is unavailable for sign-in. Ask the installation owner to review its status.',
  rate_limited: 'Request rate limit reached. Try again later; no retry was sent.',
  origin_not_allowed: 'The installation refused this application origin. Its connection configuration needs review.',
  host_not_allowed: 'The installation refused this host. Its connection configuration needs review.',

  invalid: 'Sign-in refused. Check your credentials.', denied: 'Account access denied.', limited: 'Too many attempts. Try again later.',
  unavailable: 'Request unavailable. No automatic retry was sent.', expired: 'Session expired or revoked. Sign in again.',
  'logout-confirmed': 'Server confirmed sign-out on all devices.', 'logout-unknown': 'Local session cleared. Server sign-out on other devices is unconfirmed. No retry was sent.',
};
export function AuthBoundary({ client: supplied, children, initialPage }: { client?: SessionClient; children: ReactNode; initialPage?: 'home' | 'account' }) {
  const fallback = useMemo(() => supplied ? undefined : new SessionClient({ mock: createLoginMock() }), [supplied]);
  const client = supplied ?? fallback!;
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  // INSTALLER-07: a local setup link carries the one-time code in the
  // fragment. Read it once, keep it in memory only, drop it from the address bar.
  const [setupCode] = useState(readSetupLink);
  useEffect(() => () => client.cancel(), [client]);
  // A build for real data (live transport only, no practice mode) opens the
  // real sign-in at once: no fictional workspace in between.
  const liveOnly = client.canUse('live') && !client.canUse('mock');
  const resumedClient = useRef<SessionClient|null>(null);
  useEffect(() => {
    if (!liveOnly) return;
    const s = client.getSnapshot();
    if (s.mode === 'fixture') client.selectMode('live');
    if (client.getSnapshot().phase !== 'signed-out' || client.getSnapshot().setup) return;
    // Restore through the local bridge; the backend still validates the session.
    const keep = localSessionKeep(typeof window !== 'undefined' ? window.location.hostname : '');
    if (keep && resumedClient.current !== client) { resumedClient.current = client; void client.resume(keep).then(ok => { if (!ok && client.getSnapshot().phase === 'signed-out') void client.discoverSetup(); }); }
    else void client.discoverSetup();
  }, [client, liveOnly, state.mode, state.epoch]);
  // Signed in: the workspace's own status bar carries the mode and the way out.
  const signedIn = state.mode !== 'fixture' && state.phase === 'authenticated';
  return <div className={`auth-boundary${signedIn ? ' signed-in' : ''}`}>
    {!signedIn && isDeveloperBuild(client) && <section className="auth-controls" aria-label="Session mode" lang="en" dir="ltr">
      <strong>{state.mode === 'fixture' ? 'Fixture workspace — fictional data' : state.mode === 'mock' ? 'Offline login mock — fictional identity, no network' : 'Live session — explicitly enabled deployment'}</strong>
      {state.mode === 'fixture' ? <>
        {client.canUse('mock') && <button onClick={() => client.selectMode('mock')}>Open offline login mock</button>}
        {client.canUse('live') && <button onClick={() => client.selectMode('live')}>Use live sign-in</button>}
      </> : <button disabled={state.phase === 'signing-out'||state.phase==='recovery-codes'} onClick={() => client.selectMode('fixture')}>Return to fixture (local session cleared)</button>}
      <span>Authentication copy: English draft.</span>
    </section>}
    {state.mode === 'fixture' ? (liveOnly ? null : children) : <SessionWorkspace key={`${state.mode}:${state.epoch}`} client={client} setupCode={setupCode} initialPage={initialPage}/>}
  </div>;
}
/**
 * A notice while signed in: a quiet note at the bottom, never over the toolbar.
 * "Too many requests" counts down and goes away by itself; the others stay until closed.
 */
function WorkspaceNotice({ notice, seconds }: { notice: keyof typeof notices; seconds?: number }) {
  const limited = notice === 'rate_limited' || notice === 'limited';
  const [left, setLeft] = useState(limited ? seconds ?? 30 : 0), [closed, setClosed] = useState(false);
  useEffect(() => { if (!limited || left <= 0) return; const t = setTimeout(() => setLeft(n => n - 1), 1000); return () => clearTimeout(t); }, [limited, left]);
  if (closed || (limited && left <= 0)) return null;
  return <p className="page-notice workspace-notice" role="status">
    <span>{limited ? `Too many requests at once. Try again in ${left} s.` : <>{notices[notice]}{retryAfterNotice(seconds)}</>}</span>
    <button type="button" className="tool" aria-label="Close this notice" title="Close" onClick={() => setClosed(true)}><UiIcon name="close" size={12}/></button>
  </p>;
}
function SessionWorkspace({ client, setupCode, initialPage }: { client: SessionClient; setupCode: string | null; initialPage?: 'home' | 'account' }) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  useEffect(() => {
    if (state.setup === 'required') void window.dproApp?.setSetupWindow?.(true).catch(() => {});
  }, [state.setup, state.phase]);
  // Signed in: the full workspace (sidebar, chat, agents, memory, account).
  if (state.phase === 'authenticated' && state.user) return <SignedInShell client={client} notice={state.notice ? <WorkspaceNotice key={`${state.notice}:${state.retryAfterSeconds ?? ''}`} notice={state.notice} seconds={state.retryAfterSeconds}/> : null}/>;
  if(state.phase==='recovery-codes')return <PublicShell setup="login" initialPage="account" blocking><RecoveryCodes client={client}/></PublicShell>;
  return <PublicShell setup={state.setup} initialPage={state.setup === 'required' ? 'account' : initialPage} accountStep={state.setup === 'required'||state.phase==='signing-in'||!!state.verification||!!state.notice}><section className="auth-workspace" aria-label="Account sign-in" lang="en" dir="ltr">
    {state.setup !== 'required' && <h1>Girru · {state.mode === 'mock' ? 'Offline login exercise' : 'Account'}</h1>}
    {state.notice && <p role="status">{notices[state.notice]}{retryAfterNotice(state.retryAfterSeconds)}</p>}
    {(state.phase === 'verifying'||state.phase==='signing-in') && state.verification ? <VerificationForm client={client} method={state.verification.method} busy={state.phase==='signing-in'}/> : state.phase === 'authenticated' && state.user ? null : state.phase === 'signed-out' && state.setup === 'required' ? <OwnerSetup client={client} setupCode={setupCode} initialPage={initialPage}/> : state.phase === 'signing-out' ? <><p role="status">Signing out on all devices…</p><button onClick={() => client.cancel()}>Clear locally; server outcome remains unknown</button></> : state.phase === 'signed-out' && state.setup !== 'login' ? <section aria-label="Setup discovery">
      <p role="status">{state.setup === 'checking' ? 'Checking installation setup…' : state.setup === 'unavailable' ? 'Setup status unavailable. Sign-in is withheld; no automatic retry was sent.'
        : 'Check installation setup before signing in. No request has been sent automatically.'}</p>
      <p>Discovery does not verify an account, installation identity, or system readiness.</p>
      {state.setup === 'checking' ? <button onClick={() => client.cancel()}>Cancel setup check</button>
        : <button onClick={() => void client.discoverSetup()}>{state.setup ? 'Check setup again' : 'Check setup status'}</button>}
    </section> : <form method="post" onSubmit={e => {
      e.preventDefault(); const submittedPassword = password; setPassword(''); void client.login(email, submittedPassword);
    }}>
      {state.setup === 'login' && <p>Setup reports complete. Sign in to verify your account.</p>}
      {state.mode === 'mock' && <p>Fictional credentials only: demo@example.invalid / mock-only. Never enter a real password here.</p>}
      <label htmlFor="auth-email">Email</label><input id="auth-email" type="email" name={state.mode === 'live' ? 'username' : undefined} autoComplete={state.mode === 'live' ? 'username' : 'off'} required value={email} onChange={e => setEmail(e.target.value)} disabled={state.phase === 'signing-in'}/>
      <label htmlFor="auth-password">Password</label><input id="auth-password" type="password" name={state.mode === 'live' ? 'password' : undefined} autoComplete={state.mode === 'live' ? 'current-password' : 'off'} required value={password} onChange={e => setPassword(e.target.value)} disabled={state.phase === 'signing-in'}/>
      {state.mode === 'live' && <DevQuickLogin disabled={state.phase === 'signing-in'} onFill={(a) => { setEmail(a.email); setPassword(a.password); }}/>}
      <button className="primary" disabled={state.phase === 'signing-in'}>Sign in</button>
      {state.phase === 'signing-in' && <button type="button" onClick={() => client.cancel()}>Cancel sign-in</button>}
    </form>}
    {state.setup !== 'required' && <p>Settings credentials remain masked-only; no credential values are fetched.</p>}
  </section></PublicShell>;
}
function RecoveryCodes({client}:{client:SessionClient}){
 const [saved,setSaved]=useState(false),[discard,setDiscard]=useState(false);
 const codes=client.recoveryCodes();
 return <section className="auth-workspace recovery-codes" aria-label="Save recovery codes" lang="en" dir="ltr">
  <h1>Save your recovery codes</h1><p>Two-step verification is on. Save these codes privately. Each code works once.</p>
  <p>These codes disappear when you leave this screen. Your previous sessions have ended.</p>
  <ul aria-label="Recovery codes">{codes.map(code=><li key={code}><code>{code}</code></li>)}</ul>
  <label className="recovery-saved"><input type="checkbox" checked={saved} onChange={event=>setSaved(event.target.checked)}/>I have saved these codes</label>
  {!discard?<><button className="primary" disabled={!saved} onClick={()=>client.finishRecoveryCodes()}>Continue to sign in</button><button onClick={()=>setDiscard(true)}>Discard codes</button></>:<div role="alert"><p>Discard these codes? They cannot be shown again.</p><button className="primary" onClick={()=>client.finishRecoveryCodes()}>Discard and sign in</button><button onClick={()=>setDiscard(false)}>Keep saving codes</button></div>}
 </section>;
}
function VerificationForm({client,method,busy}:{client:SessionClient;method:'totp'|'recovery';busy:boolean}){
 const [password,setPassword]=useState(''),[code,setCode]=useState('');
 const recovery=method==='recovery';
 return <form className="auth-verification" aria-label={recovery?'Recover account':'Verify sign-in'} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();client.cancel();}}} onSubmit={event=>{
  event.preventDefault();const submittedPassword=password,submittedCode=code;setPassword('');setCode('');void client.completeVerification(submittedPassword,submittedCode);
 }}>
  <fieldset disabled={busy}><h2>{recovery?'Recover your account':'Verify your sign-in'}</h2>
  <p>{recovery?'This resets your authenticator and signs out every device. You will need to sign in again.':'Enter the code from your authenticator. Confirm your password to finish.'}</p>
  <label htmlFor="verification-password">Password</label><input id="verification-password" type="password" autoComplete="current-password" value={password} required maxLength={4096} onChange={event=>setPassword(event.target.value)}/>
  <label htmlFor="verification-code">{recovery?'Recovery code':'Verification code'}</label><input id="verification-code" type="text" inputMode={recovery?'text':'numeric'} autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} value={code} pattern={recovery?'[a-f0-9]{32}':'[0-9]{6}'} maxLength={recovery?32:6} required onChange={event=>setCode(event.target.value.trim())}/>
  <button className="primary" type="submit">{recovery?'Reset authenticator':'Verify'}</button>
  {!recovery&&<button type="button" disabled={!password} title="Enter your password first" onClick={()=>{const submitted=password;setPassword('');setCode('');void client.startRecovery(submitted);}}>Use a recovery code</button>}
  </fieldset>{busy&&<p role="status">Verifying…</p>}<button type="button" onClick={()=>client.cancel()}><UiIcon name="log-out"/>Back to sign in</button>
 </form>;
}
// Read once per page load (a repeated initializer must not lose the code).
let linkCode: string | null | undefined;
function readSetupLink(): string | null {
  if (linkCode !== undefined) return linkCode;
  if (typeof window === 'undefined') return null;
  linkCode = setupCodeFromFragment(window.location.hash);
  if (linkCode) try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* keep going */ }
  return linkCode;
}
const ownerSetupNotices: Record<OwnerSetupCode | 'unavailable' | 'mismatch', string> = {
  setup_token_missing: 'Open setup from Girru on the installation computer.',
  setup_token_invalid: 'This setup link is no longer valid. Reopen setup on the installation computer.',
  setup_token_expired: 'This setup link has expired. Reopen setup on the installation computer.',
  setup_not_local: 'The owner can only be created on the installation computer itself.',
  setup_complete: 'An owner already exists. Sign in instead.',
  missing_fields: 'Fill in every field. The password needs at least 12 characters.',
  weak_password: 'Choose a stronger password: at least 12 characters, not a published default.',
  invalid_email: 'Enter a valid email address.',
  user_exists: 'An account with this email already exists.',
  unavailable: 'The installation did not answer. Nothing was created; try again.',
  mismatch: 'Check your password and try again.',
};
/** First run: create the owner; desktop setup code stays in memory and is never shown. */
function OwnerSetup({ client, setupCode, initialPage }: { client: SessionClient; setupCode: string | null; initialPage?: 'home' | 'account' }) {
  const [name, setName] = useState(''); const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const strength = passwordStrength(password);
  const [workspaceType, setWorkspaceType] = useState<WorkspaceType>();
  const [companyName, setCompanyName] = useState<string>();
  const [chooseType, setChooseType] = useState(true);
  const code = setupCode ?? '';
  const hasSetupLink = SETUP_CODE.test(code);
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState<keyof typeof ownerSetupNotices | null>(null);
  if (chooseType) return <WorkspaceTypeStep value={workspaceType} companyName={companyName} onNext={(type, name) => { setWorkspaceType(type); setCompanyName(name); setChooseType(false); }}/>;
  if (!hasSetupLink) return <section className="setup-pane" aria-label="Open the setup link">
    <h2>Open setup on this computer</h2>
    <p>Open the setup link shown by Girru on the installation computer. It connects this page to your new workspace.</p>
    <div className="setup-actions"><button type="button" onClick={() => setChooseType(true)}>Back</button></div>
  </section>;
  return <form className="owner-setup" aria-label="Create the owner account" method="post" onSubmit={async e => {
    e.preventDefault();
    if (password.length < 12) { setNotice('weak_password'); return; }
    setBusy(true); setNotice(null);
    const result = await client.createOwner({ name: name.trim(), email: email.trim(), password, setupToken: code.trim(), workspaceType, ...(workspaceType === 'company' ? { companyName } : {}) });
    setBusy(false);
    if (!result.ok) {
      setNotice(result.code);
    }
  }}>
    <SetupOrb/>
    <SetupSteps current="Account"/>
    <h2>Create your account</h2>
    <p>You are the owner of this workspace. Your information stays on this computer.</p>
    {notice && !['invalid_email','weak_password','missing_fields'].includes(notice) && <p role="alert">{ownerSetupNotices[notice]}</p>}
    <label htmlFor="owner-name">Your name</label><input id="owner-name" required maxLength={100} autoComplete="name" value={name} onChange={e => setName(e.target.value)} disabled={busy}/>
    <label htmlFor="owner-email">Email <span className="owner-field-hint">You sign in with it. Nothing is sent anywhere.</span></label><input id="owner-email" type="email" name="username" required maxLength={320} autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} disabled={busy}/>
    {notice === 'invalid_email' && <p className="owner-field-error" role="alert">{ownerSetupNotices[notice]}</p>}
    <label htmlFor="owner-password">Password <span className="owner-field-hint">At least 12 characters</span></label>
    <div className="owner-password-input"><input id="owner-password" type={visible ? 'text' : 'password'} name="new-password" required minLength={12} maxLength={4096} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} disabled={busy}/><button type="button" className="owner-password-action" disabled={busy} aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible} onClick={() => setVisible(!visible)}><UiIcon name={visible ? 'eye-off' : 'eye'} size={16}/></button><button type="button" className="owner-password-action" disabled={busy} aria-label="Suggest a strong password" title="Suggest a strong password" onClick={() => { setPassword(generatePassword()); setVisible(true); }}><UiIcon name="key" size={16}/></button></div>
    <div className="owner-strength" aria-label={`Password strength: ${strength.label}`}><span data-strength={strength.value}/><b>{password ? strength.label : '—'}</b></div>
    {notice === 'weak_password' && <p className="owner-field-error" role="alert">{ownerSetupNotices[notice]}</p>}
    {notice === 'missing_fields' && <p className="owner-field-error" role="alert">{ownerSetupNotices[notice]}</p>}
    <div className="setup-actions"><button type="button" disabled={busy} onClick={() => setChooseType(true)}>Back</button>
      <button className="primary" disabled={busy}>{busy ? 'Creating…' : 'Continue'}</button></div>
  </form>;
}
/** Local test accounts (dev-quick-login.ts): fills the form only; local builds on a loopback host only. */
function DevQuickLogin({ disabled, onFill, hostname }: { disabled: boolean; onFill: (a: { email: string; password: string }) => void; hostname?: string }) {
  const host = hostname ?? (typeof window !== 'undefined' ? window.location.hostname : '');
  const accounts = devQuickLoginAccounts(host);
  if (accounts.length === 0) return null;
  return <fieldset className="dev-quick-login" aria-label="Development quick sign-in">
    <legend>Development quick sign-in — local test accounts only</legend>
    {accounts.map(a => <button key={a.email} type="button" disabled={disabled} onClick={() => onFill(a)}>Fill {a.label}</button>)}
  </fieldset>;
}
export { DevQuickLogin };
