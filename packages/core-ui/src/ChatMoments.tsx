import {NativeFileReview} from './NativeFileReview';
import {FileEditReview} from './FileEditReview';
import {editReview} from './edit-review';
// CHAT-BUILD-01 stage 5 (CH2, CH6, CH10): the quiet lines and cards in the conversation that make a
// team of agents trustworthy — Allow once / Deny where an agent waits for you, hand-off cards, what you
// said while it worked, text that tried to give orders, the chat summed up, a plan limit, undo what an
// agent changed — and the task list above the box. Each is one sentence and at most one action.
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { SessionClient } from './session';
import type { Part, ToolCall, Turn } from './turns';
import { duration, toolView, turnPlan } from './turns';
import { UiIcon } from './ui-icons';
import { ContextMenu, useMenu } from './desktop-ui';
import type { MenuItem } from './desktop-ui';
import { ApprovalVerificationSheet } from './ApprovalVerificationSheet';
import { handOffTask, paramView, requestTitle } from './ApprovalPage';
import { permissionCategories } from './hire-contract.js';
import { DocumentEditor } from './DocumentEditor';
import { TASK_MAX, taskText } from './approvals-contract.js';

export type Moments = {
  nativeCode?:boolean;
  client?: SessionClient; conversationId?: string | null; agentName?: (id?: string) => string;
  /** CH6: an agent's short description, whose sub-agent it is, and the step each delegated agent runs now (while a reply works). */
  agentAbout?: (id?: string) => string | undefined; subAgentOf?: (id?: string) => string | undefined; steps?: readonly { agentId: string; tool: string; at: string }[];
  onSwitchAuto?: () => void; onStartFresh?: (summary: string) => void; onReviewChanges?: () => void; onChanged?: () => void; onDecided?: () => void; onOpenApprovals?: () => void; onStop?: () => void;
  /** CH3 ⇧⌘Z: each changes card on screen, by message id — whether its changes are undone, and its own Redo. */
  changeCards?: Map<string, { undone: boolean; redo: () => void }>;
  /** CH6/CH10 team moments: put text in the box (never sent by itself), open an agent's page, open what an agent may do for one action. */
  onDraft?: (text: string) => void; onOpenAgent?: (agentId: string) => void; onOpenRules?: (agentId: string, category: string) => void;
};
export const MomentsContext = createContext<Moments>({});

/** CH10 Steer now: what the owner said while the agent worked, and the step it was seen at. */
export function SteerLine({ part }: { part: Extract<Part, { kind: 'steer' }> }) {
  return <p className="moment-steer"><UiIcon name="send" size={12}/><span><b>You</b> · seen at step {part.step}</span><span dir="auto">{part.text}</span></p>;
}

/** CH10: notices kept with a reply. */
export function NoticeCard({ part }: { part: Extract<Part, { kind: 'notice' }> }) {
  const m = useContext(MomentsContext);
  const [shown, setShown] = useState(false);
  if (part.code === 'injection') return <div className="moment-card" data-tone="needs" role="note">
    <p><UiIcon name="shield" size={14}/>A page or file asked the agent to do something you did not ask for. Girru ignored it and carried on with your task.</p>
    {part.text && <div className="moment-actions"><button type="button" className="link-button" aria-expanded={shown} onClick={() => setShown(v => !v)}>{shown ? 'Hide the text' : 'Show the text'}</button></div>}
    {shown && part.text && <blockquote dir="auto">{part.text}</blockquote>}
  </div>;
  // FIRSTRUN-01 / ONBOARD-CHAT-01: quick answers under the Main agent's setup question; a click puts the answer in the box.
  if (part.code === 'choices') { const options = (part.text ?? '').split('\n').map(t => t.trim()).filter(Boolean).slice(0, 8);
    return options.length ? <div className="moment-choices" role="group" aria-label="Quick answers">{options.map(o => <button key={o} type="button" className="moment-choice" disabled={!m.onDraft} onClick={() => m.onDraft?.(o)}>{o}</button>)}</div> : null; }
  if (part.code === 'images_not_seen') return <p className="moment-line"><UiIcon name="image" size={12}/>{part.text ?? 'This model does not see images in this chat.'}</p>;
  if (part.code === 'plan_limit' && shown) return <p className="moment-line"><UiIcon name="pulse" size={12}/>Kept the model. It answers again when its plan allows.</p>;
  if (part.code === 'plan_limit') return <div className="moment-card" data-tone="needs" role="note">
    <p><UiIcon name="pulse" size={14}/>{part.text ?? 'The coding app hit its plan limit.'}</p>
    {m.onSwitchAuto && <div className="moment-actions"><button type="button" className="moment-main" onClick={m.onSwitchAuto}>Switch to Auto</button>
      <button type="button" className="link-button" onClick={() => setShown(true)}>Keep this model</button></div>}
  </div>;
  // The first paragraph says what happened; the rest is the summary itself.
  const [head, ...rest] = (part.text ?? 'Older messages were summed up to keep room for the work.').split('\n\n');
  const summary = rest.join('\n\n').trim();
  return <div className="moment-card" role="note">
    <p><UiIcon name="layers" size={14}/>{head} Nothing is deleted; the full history stays in the chat.</p>
    <div className="moment-actions">
      {summary && <button type="button" className="link-button" aria-expanded={shown} onClick={() => setShown(v => !v)}>{shown ? 'Hide the summary' : 'Read the summary'}</button>}
      {m.onStartFresh && <button type="button" className="link-button" onClick={() => m.onStartFresh!(summary || head)}>Start fresh with this summary</button>}
    </div>
    {shown && summary && <blockquote dir="auto" className="moment-summary">{summary}</blockquote>}
  </div>;
}

/** CH1/CH6: an agent waits for you — review what it wants, then Allow once / Deny right in the chat (also in Approvals).
 * The stored request must be this call's tool in this chat; its parameters are shown before Allow once. */
type Detail = { id: string; toolName: string; sessionId?: string; status: string; paramsHash: string; params: unknown; maskedFields?: string[]; verificationRequired?: boolean; agentId?: string | null; category?: string | null; editedAt?: string };
/** CH6: a waiting hand-off's task (its `request`), or null when the request has none. */
export function taskOf(d: Pick<Detail, 'toolName' | 'params'> | null): string | null { return handOffTask(d); }
/** CH6/CH10: after Deny, how long "You said no" offers Allow now before the no is sent (a sent no is final). */
export const DENY_UNDO_MS = 6000;
/** `what`: the request in the owner's words ("hand this to QA Tester"); the tool's title otherwise.
 * CH6 Change the task… (a waiting hand-off only): the owner rewrites the task in the long-text editor; the server makes a
 * new paramsHash over the edited text, so Allow once covers exactly it. `onTask` hears the task the card will allow. */
export function ApprovalCard({ call, who, what, onTask }: { call: ToolCall; who?: string; what?: string; onTask?: (text: string, changed: boolean) => void }) {
  const { nativeCode, client, conversationId, onOpenApprovals, onOpenRules, onDecided } = useContext(MomentsContext);
  const [state, setState] = useState<'waiting' | 'busy' | 'review' | 'saidNo' | 'allowed' | 'denied' | 'gone'>('waiting');
  const denyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const more = useMenu();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [notice, setNotice] = useState('');
  const [verify, setVerify] = useState(false);
  const [task, setTask] = useState<string | null>(null);
  const [taskError, setTaskError] = useState('');
  const id = call.approvalId ?? '';
  const send = async (path: string, body?: unknown) => client!.request(body === undefined ? { method: 'POST', path } as never : { method: 'POST', path, body } as never);
  const review = async () => {
    setState('busy'); setNotice('');
    try {
      const d = await client!.request({ method: 'GET', path: `/api/approvals/${id}` } as never);
      const v = (d.body as any)?.approval as Detail | undefined;
      if (d.status !== 200 || !v) { setState('gone'); return; }
      if (v.toolName !== call.name || (conversationId && v.sessionId && v.sessionId !== conversationId)) { setState('gone'); setNotice('This card does not match the request it names. Check it in Approvals.'); return; }
      if (v.status !== 'pending') { setState(v.status === 'denied' ? 'denied' : v.status === 'expired' ? 'gone' : 'allowed'); return; }
      setDetail(v); setState('review');
    } catch { setState('waiting'); setNotice('No connection. Try again.'); }
  };
  const allow = async (receipt?: string) => {
    if (!detail) return;
    setState('busy');
    try {
      const r = await send(`/api/approvals/${id}/approve`, { paramsHash: detail.paramsHash, ...(receipt ? { verificationReceipt: receipt } : {}) });
      if (r.status === 200) { setState('allowed'); onDecided?.(); return; }
      // Decided in another place first (Approvals, another window): show what really happened.
      const d = await client!.request({ method: 'GET', path: `/api/approvals/${id}` } as never);
      const v = (d.body as any)?.approval as Detail | undefined;
      if (d.status === 200 && v && v.status !== 'pending') {
        if (v.status === 'denied') setState('denied'); else if (v.status === 'expired') setState('gone'); else { setState('allowed'); onDecided?.(); }
        return;
      }
      setState('review'); setNotice('It was not allowed. Open Approvals to check it.');
    } catch { setState('review'); setNotice('No connection. Try again.'); }
  };
  useEffect(() => { const t = taskOf(detail); if (t !== null) onTask?.(t, !!detail?.editedAt); }, [detail]);
  const saveTask = async () => {
    if (!detail || task === null || state === 'busy') return;
    if (!taskText(task)) { setTaskError(`Write the task first: 1 to ${TASK_MAX.toLocaleString()} characters.`); return; }
    if (task === taskOf(detail)) { setTask(null); return; }
    setState('busy'); setTaskError('');
    try {
      const r = await send(`/api/approvals/${id}/request`, { paramsHash: detail.paramsHash, request: task });
      const v = (r.body as any)?.approval as Detail | undefined;
      if (r.status === 200 && v && v.id === id && v.status === 'pending' && taskOf(v) === task) { setDetail(v); setTask(null); setState('review'); setNotice('Task changed. Allow once runs the new task only.'); return; }
      if (r.status === 400) { setState('review'); setTaskError(`Write the task first: 1 to ${TASK_MAX.toLocaleString()} characters.`); return; }
      // It changed or stopped waiting meanwhile: read it again, so Allow once never uses an old hash.
      setTask(null); setDetail(null); await review(); setNotice('The request changed or stopped waiting, so the task was not changed.');
    } catch { setState('review'); setTaskError('No connection. Try again.'); }
  };
  // The request is read at once, so its details and Allow once show without an extra step (what is shown is what is allowed).
  useEffect(() => { if (client && id && state === 'waiting' && !detail) void review(); }, [id]);
  const sendDeny = async () => { denyTimer.current = null; setState('busy'); try { const r = await send(`/api/approvals/${id}/deny`); setState(r.status === 200 ? 'denied' : 'waiting'); if (r.status === 200) onDecided?.(); } catch { setState('waiting'); } };
  // CH6/CH10 "You said no": a reviewed request waits a few seconds before the no is sent, so Allow now can still allow it
  // (with the owner's click and the same Allow once request; nothing is allowed by itself). Leaving the chat sends the no at once.
  const deny = () => { if (state !== 'review' || !detail) { void sendDeny(); return; } setState('saidNo'); denyTimer.current = setTimeout(() => void sendDeny(), DENY_UNDO_MS); };
  const allowNow = () => { if (denyTimer.current) clearTimeout(denyTimer.current); denyTimer.current = null; setState('review'); if (detail?.verificationRequired) setVerify(true); else void allow(); };
  useEffect(() => () => { if (denyTimer.current) { clearTimeout(denyTimer.current); void client?.request({ method: 'POST', path: `/api/approvals/${id}/deny` } as never).catch(() => null); } }, []);
  if (!client || !id) return null;
  const title = requestTitle(call.name, null);
  const said = what ?? title;
  if (state === 'allowed') return <p className="moment-line"><UiIcon name="check" size={12}/>Allowed: {title}. The chat carries on with the result.</p>;
  if (state === 'denied') return <p className="moment-line"><UiIcon name="close" size={12}/>You said no: {said}. It did not run.</p>;
  if (state === 'saidNo') return <div className="moment-card team-moment" data-tone="no" role="status">
    <p><UiIcon name="close" size={14}/>You said no: {said}.</p>
    <div className="moment-actions"><button type="button" className="moment-main" onClick={allowNow}>Allow now</button></div>
  </div>;
  if (state === 'gone') return <p className="moment-line">{notice || 'This request is no longer waiting. See Approvals.'}</p>;
  const view = detail ? paramView(detail.params, detail.maskedFields ?? []) : null;
  const fileReview=detail?editReview(detail.toolName,detail.params,detail.maskedFields??[]):null;
  const reviewComplete=!!fileReview||!!view?.complete;
  if(nativeCode&&fileReview&&detail)return <><NativeFileReview value={{id,path:fileReview.path,before:(detail.params as Record<string,string>).before,after:(detail.params as Record<string,string>).after}} onDecision={decision=>{if(state==='review'){if(decision==='approve'){if(detail.verificationRequired)setVerify(true);else void allow();}else void sendDeny();}}}/>{verify&&<ApprovalVerificationSheet client={client} id={detail.id} paramsHash={detail.paramsHash} toolName={title} onClose={()=>setVerify(false)} onApprove={receipt=>{setVerify(false);void allow(receipt);}}/>}</>;
  return <div className="moment-card" data-tone="needs">
    <p><UiIcon name="alert" size={14}/><span><b>{who ?? 'The agent'}</b> wants to: {title}</span></p>
    {fileReview?<FileEditReview review={fileReview}/>:view && (view.complete ? <dl className="approval-plain">{view.rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd dir="auto">{v}</dd></div>)}</dl>
      : <p className="moment-hint">The full request is too long to show here. Check it in Approvals.</p>)}
    <div className="moment-actions">
      {state === 'review' && reviewComplete
        ? <button type="button" className="moment-main" onClick={() => (detail?.verificationRequired ? setVerify(true) : void allow())}>Allow once</button>
        : <button type="button" className="moment-main" disabled={state === 'busy'} onClick={() => void review()}>Review…</button>}
      <button type="button" className="link-button" disabled={state === 'busy'} onClick={() => void deny()}>Deny</button>
      {state === 'review' && reviewComplete && taskOf(detail) !== null && (() => {
        const hidden = (detail?.maskedFields ?? []).some(f => f === 'request' || f.startsWith('request.'));
        return <button type="button" className="link-button" disabled={hidden} title={hidden ? 'Part of this task is hidden; change it in Approvals or ask the lead again' : 'Change the task before you allow it'}
          onClick={() => { setTaskError(''); setTask(taskOf(detail)); }}>Change the task…</button>;
      })()}
      <span className="moment-hint">Also in Approvals</span>
      {onOpenApprovals && <button type="button" className="dk-icon moment-more" aria-label="More for this request" title="More for this request"
        onClick={e => more.at(e, [{ label: 'Open in Approvals', icon: 'open', run: onOpenApprovals }, alwaysAllow(detail, onOpenRules ?? (() => onOpenApprovals()))])}><UiIcon name="more" size={14}/></button>}
    </div>
    <ContextMenu menu={more.menu} onClose={more.close}/>
    {notice && <p className="moment-hint" role="status">{notice}</p>}
    {task !== null && detail && <DocumentEditor title={what ? `Change the task · ${what}` : 'Change the task'} files={[{ id: 'task', name: 'Task.md', content: task }]} maxLength={TASK_MAX}
      note="Allow once runs only the saved text. Nothing runs until you allow it." saveLabel="Save the task" message={taskError}
      onChange={(_, text) => { setTask(text); setTaskError(''); }} onSave={() => void saveTask()} onClose={() => { setTask(null); setTaskError(''); }}/>}
    {verify && detail && <ApprovalVerificationSheet client={client} id={detail.id} paramsHash={detail.paramsHash} toolName={title} onClose={() => setVerify(false)} onApprove={receipt => { setVerify(false); void allow(receipt); }}/>}
  </div>;
}

/** CH6/CH10 Stop asking for one person: "What agents may do" with that agent and action picked (its Allow is the rule).
 * Hand-offs, commands and a tool's own request always ask; no rule lifts them, so the item says so. */
export function alwaysAllow(detail: Pick<Detail, 'agentId' | 'category'> | null, open: (agentId: string, category: string) => void): Exclude<MenuItem, 'sep'> {
  const category = detail?.category ?? '';
  if (!detail?.agentId || !(permissionCategories as readonly string[]).includes(category)) return { label: 'Always asks: no rule can allow this', icon: 'lock', disabled: true, run: () => {} };
  return { label: 'Always allow this… (What agents may do)', icon: 'check', run: () => open(detail.agentId!, category) };
}

/** CH6/CH10: why a hand-off did not finish, from the hand-off's own receipt ("Team request did not finish (timed_out): …"). */
export type HandOffFailure = 'timed_out' | 'no_model' | 'model_unavailable';
export function handOffFailure(call: Pick<ToolCall, 'name' | 'output' | 'running'>): HandOffFailure | null {
  if (call.name !== 'team_delegate' || call.running || !call.output) return null;
  return (/^Team request did not finish \((timed_out|no_model|model_unavailable)\): /.exec(call.output)?.[1] as HandOffFailure | undefined) ?? null;
}

/** CH6/CH10: a hand-off that ran out of time or whose person cannot answer — one sentence and the owner's next step. */
function HandOffMoment({ why, name, agentId, request }: { why: HandOffFailure; name: string; agentId?: string; request?: string }) {
  const { onDraft, onOpenAgent } = useContext(MomentsContext);
  const timed = why === 'timed_out';
  // Hand it again only drafts a message to the lead; it is sent (and approved) like any other.
  const act = timed ? (onDraft && request ? { label: 'Hand it again', run: () => onDraft(`Hand this to ${name} again: ${request}`) } : null)
    : onOpenAgent && agentId ? { label: 'Set a model', run: () => onOpenAgent(agentId) } : null;
  return <div className="moment-card team-moment" data-tone="needs" role="note">
    <p><UiIcon name={timed ? 'clock' : 'cpu'} size={14}/>{timed ? `${name} ran out of time.` : `${name} cannot answer: ${why === 'no_model' ? 'no model is set' : 'its model is not available'}.`}</p>
    {act && <div className="moment-actions"><button type="button" className="moment-main" onClick={act.run}>{act.label}</button></div>}
  </div>;
}

/** CH6: a part of the work handed to another agent — the ask, then its report. */
export function DelegationCard({ call, nested, children }: { call: ToolCall; nested?: boolean; children?: ReactNode }) {
  const { agentName, agentAbout, subAgentOf, steps, onStop } = useContext(MomentsContext);
  const [open, setOpen] = useState(false);
  // CH6: the task the waiting approval holds now (the owner may have changed it before Allow once).
  const [task, setTask] = useState<{ text: string; changed: boolean } | null>(null);
  let input: { agent_id?: string; request?: string } = {};
  try { input = JSON.parse(call.input); } catch { /* shown without the ask */ }
  const name = agentName?.(input.agent_id) ?? input.agent_id ?? 'an agent';
  const about = agentAbout?.(input.agent_id);
  const parentId = subAgentOf?.(input.agent_id);
  const why = handOffFailure(call);
  const state = call.running ? 'Working' : call.approvalId ? 'Waits for you' : why === 'timed_out' ? 'Ran out of time' : why ? 'Cannot answer' : call.isError ? 'Did not finish' : 'Done';
  const moment = why && <HandOffMoment why={why} name={name} agentId={input.agent_id} request={input.request}/>;
  const time = call.ms && !call.running ? ` · ${duration(call.ms)}` : '';
  // CH6: a hand-off to a sub-agent says whose it is; under its lead's card it is one nested line.
  const verb = call.approvalId ? 'Wants to hand to' : nested && parentId ? `${agentName?.(parentId) ?? 'It'} handed to its sub-agent` : parentId ? `Handed to ${agentName?.(parentId) ?? 'a lead'}’s sub-agent` : 'Handed to';
  const step = call.running ? steps?.find(x => x.agentId === input.agent_id) : undefined;
  const head = <p className="handoff-head">{!nested && <UiIcon name="handoff" size={14}/>}<span className="handoff-verb">{verb}</span><span className="composer-face" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span><b>{name}</b>{about && !nested && <span className="handoff-about">{about}</span>}<span className="moment-hint handoff-state">{state}{time}</span></p>;
  if (nested) return <div className="handoff-sub">{head}{input.request && <p className="handoff-ask" dir="auto">{input.request}</p>}{moment}</div>;
  return <div className="moment-card handoff" data-tone={call.approvalId ? 'needs' : undefined}>
    {head}
    {(task?.text ?? input.request) && <p className="handoff-ask" dir="auto">{task?.text ?? input.request}</p>}
    {call.approvalId && task && (task.changed || task.text !== input.request) && <p className="moment-hint handoff-changed"><UiIcon name="pencil" size={11}/>You changed the task. Allow once runs this text.</p>}
    {children}
    {/* CH6: while it works, one live line with the step it is on and Stop. */}
    {call.running && <div className="handoff-live" role="status"><span className="pulse" aria-hidden="true"/><span className="handoff-step">{stepLabel(step?.tool)}</span>
      {step && <Since at={step.at}/>}
      {onStop && <button type="button" className="row-tool handoff-stop" aria-label="Stop" title="Stop (also stops what it was handed)" onClick={onStop}><UiIcon name="stop" size={10}/></button>}</div>}
    {moment}
    {call.output && !call.approvalId && !why && <><button type="button" className="handoff-fold" aria-expanded={open} onClick={() => setOpen(v => !v)}><span className="caret" aria-hidden="true"><UiIcon name="chevron" size={12}/></span>{`${name}’s report`}</button>
      {open && <div className="handoff-report" dir="auto">{call.output}</div>}</>}
    {call.approvalId && <ApprovalCard call={call} who="The lead" what={`hand this to ${name}`} onTask={(text, changed) => setTask({ text, changed })}/>}
  </div>;
}

/** The step a delegated agent is on, in plain words ("Reading Hero.tsx" style verbs; the tool name otherwise). */
function stepLabel(tool?: string): string {
  if (!tool || tool === 'thinking') return 'Thinking…';
  const v = toolView({ name: tool, input: '{}', running: true });
  return v.verb && v.target && v.target !== tool.toLowerCase() ? `${v.verb} ${v.target}` : v.verb || tool;
}

/** "0:32" since a time, ticking every second. */
function Since({ at }: { at: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  return Number.isFinite(s) ? <span className="moment-hint">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span> : null;
}

/** CH10 Undo: a reply that changed files offers Review and Undo; afterwards Redo. */
export function ChangesLine({ turn, messageId }: { turn: Turn; messageId: string }) {
  const { client, conversationId, onReviewChanges, onChanged, changeCards } = useContext(MomentsContext);
  const [undone, setUndone] = useState(turn.changes?.undone ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async (redo: boolean) => {
    if (!client || !conversationId || busy) return;
    setBusy(true); setError('');
    try {
      const r = await client.request({ method: 'POST', path: `/api/chat/conversations/${conversationId}/messages/${messageId}/undo`, body: redo ? { redo: true } : {} } as never);
      if (r.status === 200) { setUndone(!redo); onChanged?.(); }
      else setError(r.status === 409 ? 'Some of these files changed since, so nothing was undone.' : 'It did not work. Try again.');
    } catch { setError('No connection. Try again.'); }
    setBusy(false);
  };
  // ⇧⌘Z in the chat redoes the newest undone card (ChatView picks it); the card runs its own Redo, so its errors show here.
  const usable = !!turn.changes?.files && !turn.changes.unavailable && !!client && !!conversationId;
  useEffect(() => {
    if (!changeCards || !usable) return;
    changeCards.set(messageId, { undone, redo: () => void go(true) });
    return () => { changeCards.delete(messageId); };
  });
  if (turn.changes?.unavailable) return <p className="moment-line changes"><UiIcon name="lock" size={12}/>Undo not available for this folder: its git settings could run a program, so no snapshot was kept.</p>;
  if (!usable || !turn.changes) return null;
  const n = turn.changes.files;
  // CH10: one card — what changed, then Review (main) and Undo.
  return <div className="moment-card changes" role="note">
    <p><UiIcon name="undo" size={15}/><span>{undone ? `Undone: ${n} ${n === 1 ? 'file is' : 'files are'} back as before.` : `Changed ${n} ${n === 1 ? 'file' : 'files'}`}
      {!undone && turn.changes?.added !== undefined && <> · <span className="diff-add">+{turn.changes.added}</span> <span className="diff-del">−{turn.changes.removed}</span></>}</span></p>
    <div className="moment-actions">
      {!undone && onReviewChanges && <button type="button" className="moment-main" onClick={onReviewChanges}>Review</button>}
      <button type="button" className={undone ? 'moment-main' : 'link-button'} disabled={busy} onClick={() => void go(undone)}>{undone ? 'Redo' : 'Undo these changes'}</button>
      {error && <span className="moment-hint" role="alert">{error}</span>}
    </div>
  </div>;
}

/** CH3 ⇧⌘Z: the newest reply whose file changes are undone (its card is on screen), or null when there is none. */
export function redoTarget(turns: readonly Turn[], cards: ReadonlyMap<string, { undone: boolean }>): string | null {
  for (let i = turns.length - 1; i >= 0; i--) { const t = turns[i]; if (t.role === 'assistant' && t.changes?.files && cards.get(t.key)?.undone) return t.key; }
  return null;
}

/** CH1/CH8c: who works or answered in this chat — the lead, each agent that wrote a reply, then each agent handed a part (first seen first). */
export function chatPeople(turns: readonly Turn[], leadId: string | null, nameOf: (id: string | null | undefined) => string): string[] {
  const ids: (string | null)[] = [leadId];
  for (const t of turns) {
    if (t.role !== 'assistant') continue;
    ids.push(t.agentId ?? leadId);
    for (const p of t.parts) if (p.kind === 'tools') for (const c of p.calls) if (c.name === 'team_delegate') { try { const a = (JSON.parse(c.input) as { agent_id?: unknown }).agent_id; if (typeof a === 'string' && a) ids.push(a); } catch { /* no target */ } }
  }
  return [...new Set(ids.map(nameOf))];
}

/** CH1/CH8c: with the side panel hidden, up to three small faces in the title bar; the tooltip names everyone, a click opens Team. */
export function TitleFaces({ names, onOpen }: { names: readonly string[]; onOpen: () => void }): ReactNode {
  if (!names.length) return null;
  const all = names.join(', ');
  return <button type="button" className="tool title-faces" aria-label={`Team: ${all}`} title={`${all} · open Team`} onClick={onOpen}>
    {names.slice(0, 3).map((n, i) => <span key={i} className="composer-face" aria-hidden="true">{n.slice(0, 1).toUpperCase()}</span>)}
  </button>;
}

/** CH2: the chat's task list above the box (the latest plan), folded to one line. */
export function TaskList({ turns, who, waits = 0 }: { turns: readonly Turn[]; who?: string; waits?: number }): ReactNode {
  const [open, setOpen] = useState(false);
  const last = [...turns].reverse().find(t => t.role === 'assistant' && turnPlan(t.parts));
  const steps = last ? turnPlan(last.parts) : null;
  if (!steps?.length) return null;
  const done = steps.filter(s => s.status === 'done').length;
  const working = last!.status === 'running' ? steps.find(s => s.status === 'active') ?? steps.find(s => s.status === 'pending') : undefined;
  return <section className="task-list" aria-label="Tasks">
    <button type="button" className="task-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <span className="chat-project-chevron" data-open={open || undefined}><UiIcon name="chevron" size={11}/></span>
      <b>Tasks</b><span>{done} of {steps.length} done</span>{working && <span className="task-now">· {working.title}</span>}
      {/* CH1: approvals of this chat that wait for the owner, in amber. */}
      {waits > 0 && <span className="task-waits">· {waits} {waits === 1 ? 'waits' : 'wait'} for you</span>}</button>
    {open && <ol>{steps.map((s, i) => <li key={i} data-state={s.status}><span className="task-dot" aria-hidden="true">{s.status === 'done' ? <UiIcon name="check" size={10}/> : null}</span><span dir="auto">{s.title}</span>{who && (s === working || s.status === 'done') && <small>{who}</small>}</li>)}</ol>}
  </section>;
}

/** Desktop notification when long work ends while the window is in the back (CH10). */
export function notifyDone(title: string, body: string) {
  try {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') return;
    const desktop = typeof window === 'undefined' ? undefined : (window as unknown as { dproApp?: { notifyDone?: () => Promise<boolean> } }).dproApp;
    if (desktop?.notifyDone) { void desktop.notifyDone().catch(() => {}); return; }
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') new Notification(title, { body, silent: false });
    else if (Notification.permission === 'default') void Notification.requestPermission();
  } catch { /* notifications are optional */ }
}
