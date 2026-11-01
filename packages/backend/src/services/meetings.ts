/** Owner-scoped meeting orchestration reuses saved chat turns and task-board cards. */
import { randomUUID, scrypt } from 'node:crypto';
import { q, sql, one, all, run, type Step, type SqlParam } from '../repositories/sql-steps.js';
import { createCardSteps } from './task-board.js';
import { chatRuns } from './chat-runs.js';
import { stopDelegations } from '../tools/tasks/team.js';
import { redactImportText } from '../memory/import/redact.js';
import { cleanHandoff, MAIN_AGENT } from '../memory/handoff/store.js';
export class MeetingError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
const invalid = (message: string): never => { throw new MeetingError(400, 'invalid_meeting', message); };
const missing = (): never => { throw new MeetingError(404, 'not_found', 'Meeting not found'); };
const conflict = (message: string): never => { throw new MeetingError(409, 'meeting_conflict', message); };
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const meetingId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v : invalid('Expected an object');
const keys = (v: unknown, allowed: string[]) => { const b = object(v); if (Object.keys(b).some(k => !allowed.includes(k))) invalid('Unknown meeting field'); return b; };
const text = (v: unknown, max: number, required = true): string => { if (typeof v !== 'string' || v.length > max || (required && !v.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v)) invalid('Invalid meeting text'); return redactImportText((v as string).trim()).text; };
// Request receipts may reflect low-entropy text; derive them asynchronously with a per-request salt.
const fingerprint = (value: unknown, requestId: string): Promise<string> => new Promise((resolve, reject) => {
 scrypt(JSON.stringify(value), `girru-meeting-v1:${requestId}`, 64, { N: 16384, r: 8, p: 1 }, (error, key) => error ? reject(error) : resolve(key.toString('hex')));
});
export type Selection = { mode: 'all' | 'departments' | 'agents'; departments: string[]; agentIds: string[]; headsOnly: boolean };
export type Meeting = { id: string; conversationId: string; title: string; objective: string; state: string; version: number; count: number; cursor: number; activeRunId: string | null; speaker: Agent | null; summary: string; selection: Selection; decisions: Decision[]; reviewReady: boolean };
export type Agent = { id: string; name: string; department: string | null; role: string | null };
export type Decision = { id: string; title: string; description: string; agentId: string | null; department: string | null; dueDate: string | null; enabled: boolean; boardId: string | null; cardId: string | null };
type Row = { id: string; owner_id: string; conversation_id: string; request_hash: string; title: string; objective: string; state: string; version: number; cursor: number; active_run_id: string | null; summary: string; review_run_id: string | null; selection: string };
const locks = new Map<string, Promise<unknown>>();
export async function meetingLock<T>(id: string, work: () => Promise<T>): Promise<T> { const previous = locks.get(id) ?? Promise.resolve(); const next = previous.catch(() => {}).then(work); locks.set(id, next); try { return await next; } finally { if (locks.get(id) === next) locks.delete(id); } }
export function selectionInput(value: unknown): Selection {
 const b = keys(value, ['mode', 'departments', 'agentIds', 'headsOnly']);
 if (!['all', 'departments', 'agents'].includes(b.mode) || typeof b.headsOnly !== 'boolean') invalid('Choose participants');
 const departments = b.departments ?? [], agentIds = b.agentIds ?? [];
 if (!Array.isArray(departments) || departments.length > 100 || departments.some(x => typeof x !== 'string' || !/^[a-z0-9][a-z0-9 _-]{0,63}$/.test(x))) invalid('Invalid departments');
 if (!Array.isArray(agentIds) || agentIds.length > 5000 || agentIds.some(x => !meetingId(x))) invalid('Invalid agents');
 if (b.mode === 'departments' && !departments.length || b.mode === 'agents' && !agentIds.length) invalid('Select at least one participant group');
 if (b.mode !== 'departments' && departments.length || b.mode !== 'agents' && agentIds.length) invalid('Selection fields do not match the mode');
 if (b.mode === 'agents' && b.headsOnly) invalid('Select exact agents without a role filter');
 return { mode: b.mode, departments: [...new Set<string>(departments)].sort(), agentIds: [...new Set<string>(agentIds)].sort(), headsOnly: b.headsOnly };
}
function selectionWhere(selection: Selection): { where: string; args: SqlParam[] } {
 const terms = ['1 = 1'], args: SqlParam[] = [];
 if (selection.mode === 'departments') { terms.push(`lower(COALESCE(a.department,'')) IN (${selection.departments.map(() => '?').join(',')})`); args.push(...selection.departments); }
 if (selection.mode === 'agents') { terms.push(`a.id IN (${selection.agentIds.map(() => '?').join(',')})`); args.push(...selection.agentIds); }
 if (selection.headsOnly) terms.push("a.role IN ('manager', 'main')");
 return { where: terms.join(' AND '), args };
}
function* owned(owner: string, id: string): Step<Row> { const row = yield* one<Row>('SELECT * FROM meetings WHERE id = ? AND owner_id = ?', id, owner); return row ?? missing(); }
export async function meetingDepartments() { const departments = await q.all<{ name: string; total: number; heads: number }>("SELECT lower(COALESCE(department,'')) AS name, COUNT(*) AS total, SUM(CASE WHEN role IN ('manager','main') THEN 1 ELSE 0 END) AS heads FROM agents_config GROUP BY lower(COALESCE(department,'')) ORDER BY 1"); return { departments: departments.map(d => ({ name: d.name, total: Number(d.total), heads: Number(d.heads) })), totalAgents: departments.reduce((n, d) => n + Number(d.total), 0) }; }
export async function meetingRoster(owner: string, raw: Record<string, any>) {
 const b = keys(raw, ['meetingId', 'mode', 'departments', 'heads', 'q', 'offset', 'limit']);
 const offset = Number(b.offset ?? 0), limit = Number(b.limit ?? 50);
 if (!Number.isInteger(offset) || offset < 0 || offset > 1000000 || !Number.isInteger(limit) || limit < 1 || limit > 100) invalid('Invalid participant page');
 if (b.heads !== undefined && !['0','1'].includes(b.heads)) invalid('Invalid head filter');
 const search = b.q === undefined ? '' : text(b.q, 100, false).toLowerCase();
 const selection = selectionInput({ mode: b.mode ?? 'all', departments: b.departments ? String(b.departments).split(',') : [], agentIds: [], headsOnly: b.heads === '1' });
 let { where, args } = selectionWhere(selection), join = '';
 if (b.meetingId !== undefined) { if (!meetingId(b.meetingId)) missing(); await sql().read(owned(owner, b.meetingId)); join = ' JOIN meeting_participants p ON p.agent_id = a.id AND p.meeting_id = ?'; args = [b.meetingId, ...args]; }
 if (search) { where += " AND (lower(a.name) LIKE ? ESCAPE '!' OR lower(COALESCE(a.department,'')) LIKE ? ESCAPE '!')"; const pattern = '%' + search.replace(/[!%_]/g, c => '!' + c) + '%'; args.push(pattern, pattern); }
 const count = await q.one<{ n: number }>(`SELECT COUNT(*) AS n FROM agents_config a${join} WHERE ${where}`, ...args);
 const agents = await q.all<Agent>(`SELECT a.id, a.name, a.department, a.role FROM agents_config a${join} WHERE ${where} ORDER BY lower(a.name), a.id LIMIT ? OFFSET ?`, ...args, limit, offset);
 return { agents, total: Number(count?.n ?? 0), offset, nextOffset: offset + agents.length < Number(count?.n ?? 0) ? offset + agents.length : null };
}
export async function createMeeting(owner: string, raw: unknown) {
 const b = keys(raw, ['requestId', 'title', 'objective', 'selection', 'projectId']);
 if (!meetingId(b.requestId)) invalid('A request id is required');
 const title = text(b.title, 160), objective = text(b.objective, 4000), selection = selectionInput(b.selection);
 if (b.projectId !== undefined && b.projectId !== null && !meetingId(b.projectId)) invalid('Invalid project');
 const hash = await fingerprint({ title, objective, selection, projectId: b.projectId ?? null }, b.requestId);
 const id = b.requestId, conversationId = randomUUID(), now = new Date().toISOString();
 await sql().tx(function* () {
  const existing = yield* one<Row>('SELECT * FROM meetings WHERE id = ?', id);
  if (existing) { if (existing.owner_id !== owner) missing(); if (existing.request_hash !== hash) conflict('This request was already used for another meeting'); return; }
  if (b.projectId && !(yield* one('SELECT id FROM chat_projects WHERE id = ? AND user_id = ?', b.projectId, owner))) invalid('Project not found');
  const filter = selectionWhere(selection), agents = yield* all<Agent>(`SELECT a.id,a.name,a.department,a.role FROM agents_config a WHERE ${filter.where} ORDER BY lower(a.name),a.id`, ...filter.args);
  if (!agents.length || agents.length > 5000) invalid('Select between 1 and 5000 agents');
  if (selection.mode === 'agents' && agents.length !== selection.agentIds.length) invalid('One or more selected agents are unavailable');
  if (selection.mode === 'departments' && selection.departments.some(d => !agents.some(a => a.department?.toLowerCase() === d))) invalid(selection.headsOnly ? 'One selected department has no head. Choose its agents instead.' : 'One selected department has no agents');
  yield* run('INSERT INTO chat_sessions (id,user_id,title,model,agent_id,project_id,mode,thinking) VALUES (?,?,?,?,?,?,?,?)', conversationId, owner, title, 'default', agents[0].id, b.projectId ?? null, 'ask', null);
  yield* run('INSERT INTO meetings (id,owner_id,conversation_id,request_hash,title,objective,selection,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', id, owner, conversationId, hash, title, objective, JSON.stringify(selection), now, now);
  for (let i = 0; i < agents.length; i++) yield* run('INSERT INTO meeting_participants(meeting_id,agent_id,position) VALUES (?,?,?)', id, agents[i].id, i);
 }, { immediate: true });
 return getMeeting(owner, id);
}
async function reconcile(owner: string, id: string) {
 const row = await sql().read(owned(owner, id)); if (!row.active_run_id) return row;
 const live = chatRuns.get(row.active_run_id); if (live?.status === 'running') return row;
 const stored = await q.one<{ status: string }>("SELECT status FROM chat_messages WHERE run_id = ? AND session_id = ? AND role = 'assistant'", row.active_run_id, row.conversation_id);
 const state = live?.status ?? stored?.status;
 // A reservation without a durable reply after restart is paused, never replayed automatically.
 if (!state) { const pending = await q.one<{ status: string }>('SELECT status FROM meeting_turns WHERE run_id = ?', row.active_run_id); if (pending?.status === 'starting' && locks.has(id)) return row; }
 await q.run('UPDATE meeting_turns SET status = ? WHERE run_id = ?', state ?? 'interrupted', row.active_run_id);
 await q.run("UPDATE meetings SET active_run_id = NULL, state = CASE WHEN ? = 1 AND state = 'active' THEN 'paused' ELSE state END, version = version + 1 WHERE id = ? AND owner_id = ? AND active_run_id = ?", !state || state === 'error' || state === 'stopped' ? 1 : 0, id, owner, row.active_run_id);
 return sql().read(owned(owner, id));
}
export async function getMeeting(owner: string, id: string): Promise<Meeting> {
 if (!meetingId(id)) missing(); const row = await reconcile(owner, id);
 const count = await q.one<{ n: number }>('SELECT COUNT(*) AS n FROM meeting_participants WHERE meeting_id = ?', id);
 const speaker = row.active_run_id ? await q.one<Agent>('SELECT a.id,a.name,a.department,a.role FROM meeting_turns t JOIN agents_config a ON a.id=t.agent_id WHERE t.run_id = ?', row.active_run_id) : undefined;
 const decisions = await q.all<{ id: string; title: string; description: string; agent_id: string | null; department: string | null; due_date: string | null; enabled: number; board_id: string | null; card_id: string | null }>('SELECT * FROM meeting_decisions WHERE meeting_id = ? ORDER BY position', id);
 const ready = await q.one("SELECT run_id FROM meeting_turns WHERE meeting_id = ? AND kind = 'summary' AND status = 'complete' LIMIT 1", id);
 const passed = await q.one<{n:number}>('SELECT COUNT(*) AS n FROM meeting_participants WHERE meeting_id = ? AND position < ?', id, Number(row.cursor));
 return { id, conversationId: row.conversation_id, title: row.title, objective: row.objective, state: row.state, version: Number(row.version), count: Number(count?.n ?? 0), cursor: Number(passed?.n ?? 0), activeRunId: row.active_run_id, speaker: speaker ?? null, summary: row.summary, selection: JSON.parse(row.selection), reviewReady: !!ready, decisions: decisions.map(d => ({ id: d.id, title: d.title, description: d.description, agentId: d.agent_id, department: d.department, dueDate: d.due_date, enabled: !!d.enabled, boardId: d.board_id, cardId: d.card_id })) };
}
export async function meetingsFor(owner: string, conversationId?: string) {
 if (conversationId !== undefined && !meetingId(conversationId)) invalid('Invalid conversation');
 if (!conversationId) return { meetings: await q.all<{id:string;conversationId:string;title:string;state:string}>(`SELECT id, conversation_id AS "conversationId", title, state FROM meetings WHERE owner_id=? ORDER BY updated_at DESC LIMIT 50`,owner) };
 const rows=await q.all<{id:string}>('SELECT id FROM meetings WHERE owner_id=? AND conversation_id=?',owner,conversationId);
 return {meetings:await Promise.all(rows.map(r=>getMeeting(owner,r.id)))};
}

export async function changeMeetingState(owner: string, id: string, raw: unknown) {
 const b = keys(raw, ['expectedVersion', 'state']); if (!['active', 'paused', 'review'].includes(b.state) || !Number.isSafeInteger(b.expectedVersion)) invalid('Invalid state');
 const row = await sql().read(owned(owner, id)); if (row.state === 'completed') conflict('Meeting is already completed');
 const result = await q.run('UPDATE meetings SET state = ?, version = version+1 WHERE id = ? AND owner_id = ? AND version = ?', b.state, id, owner, b.expectedVersion);
 if (!result.changes) conflict('Meeting changed. Reload before editing');
 if (b.state !== 'active' && row.active_run_id) { chatRuns.get(row.active_run_id)?.requestStop(); stopDelegations(row.conversation_id); }
 return getMeeting(owner, id);
}
export type StartMeetingTurn = (input: { userId: string; role: string; c: any; runId: string; message: string; displayMessage?: string; model?: string; agentId: string; images?: string[] }) => Promise<{ code: number; body: Record<string, unknown> }>;
export async function nextMeetingTurn(owner: string, id: string, raw: unknown, start: StartMeetingTurn) {
 const b = keys(raw, ['requestId', 'agentId', 'message', 'kind', 'images']); if (!meetingId(b.requestId)) invalid('A turn request id is required');
 if (b.agentId !== undefined && !meetingId(b.agentId)) invalid('Invalid participant');
 const kind = b.kind ?? 'discussion'; if (!['discussion', 'summary'].includes(kind)) invalid('Invalid turn');
 const message = b.message === undefined ? '' : text(b.message, 12000, false);
 if (b.images !== undefined && (!Array.isArray(b.images) || b.images.length > 5 || b.images.some((x: unknown) => !meetingId(x)))) invalid('Invalid image references');
 const hash = await fingerprint({ agentId: b.agentId ?? null, message, kind, images: b.images ?? [] }, b.requestId);
 await reconcile(owner, id);
 const reserved = await sql().tx(function* () {
  const row = yield* owned(owner, id);
  const previous = yield* one<{ run_id: string; request_hash: string }>('SELECT * FROM meeting_turns WHERE meeting_id = ? AND request_id = ?', id, b.requestId);
  if (previous) { if (previous.request_hash !== hash) conflict('Turn request was already used'); return { replay: previous.run_id, row }; }
  if (row.state !== 'active' || row.active_run_id || chatRuns.activeFor(row.conversation_id)) conflict('Pause, busy or closed meeting');
  const agent = b.agentId ? yield* one<Agent & { position: number }>('SELECT a.id,a.name,a.department,a.role,p.position FROM agents_config a JOIN meeting_participants p ON p.agent_id=a.id WHERE p.meeting_id = ? AND a.id = ?', id, b.agentId) : yield* one<Agent & { position: number }>('SELECT a.id,a.name,a.department,a.role,p.position FROM agents_config a JOIN meeting_participants p ON p.agent_id=a.id WHERE p.meeting_id = ? AND p.position >= ? ORDER BY p.position LIMIT 1', id, kind === 'summary' ? 0 : Number(row.cursor));
  if (!agent) conflict(b.agentId ? 'The agent is not invited' : 'Every invited agent has had a turn. Select a participant to ask again');
  const runId = randomUUID();
  const changed = yield* run('UPDATE meetings SET active_run_id = ?, cursor = ?, version = version+1 WHERE id = ? AND version = ? AND state = ? AND active_run_id IS NULL', runId, !b.agentId && kind === 'discussion' ? Number(agent!.position) + 1 : Number(row.cursor), id, row.version, 'active');
  if (!changed.changes) conflict('Meeting changed. Try again');
  if(kind==='discussion')yield* run("UPDATE meeting_turns SET status='superseded' WHERE meeting_id=? AND kind='summary'",id);
  yield* run('INSERT INTO meeting_turns(meeting_id,request_id,request_hash,run_id,agent_id,kind,status) VALUES (?,?,?,?,?,?,?)', id, b.requestId, hash, runId, agent!.id, kind, 'starting');
  return { runId, agent, row };
 }, { immediate: true });
 if ('replay' in reserved) return { runId: reserved.replay, replayed: true };
 const { findConversation } = await import('../repositories/chat-conversations.js');
 const c = await findConversation(owner, reserved.row.conversation_id); if (!c) missing();
 const prompt = kind === 'summary' ? `Meeting: ${reserved.row.title}\nObjective: ${reserved.row.objective}\nSummarize this meeting from the recorded discussion. Return only JSON with "summary" (text) and "decisions" (array, maximum 30 items). Each actionable item has "title", "description", "agentId" (only an exact participant id if known, otherwise null), "assigneeName" (exact recorded participant name, otherwise null), "department" (or null). With no recorded discussion, return an empty decisions array. Separate decisions from speculation. Do not execute actions or create tasks; the owner reviews all proposals.` : `Meeting: ${reserved.row.title}\nObjective: ${reserved.row.objective}\nYou are ${reserved.agent!.name} from ${reserved.agent!.department ?? 'the team'}. Contribute as yourself, considering the prior participants' replies. Keep your contribution focused on this agenda. Do not impersonate other participants. Decisions are proposals until the owner approves them.${message ? '\nOwner: '+message : '\nGive your contribution to the discussion.'}`;
 try {
  const out = await start({ userId: owner, role: 'owner', c, runId: reserved.runId, message: prompt, displayMessage: kind === 'summary' ? 'Finish the meeting and prepare its decisions for review.' : message || `Invite ${reserved.agent!.name} to contribute to “${reserved.row.title}”.`, agentId: reserved.agent!.id, ...(c?.model ? { model: c.model } : {}), ...(b.images?.length ? { images: b.images } : {}) });
  if (out.code !== 202) throw new MeetingError(out.code, 'meeting_turn_failed', typeof out.body.error === 'string' ? out.body.error : 'The turn could not start');
  await q.run("UPDATE meeting_turns SET status = 'running' WHERE run_id = ?", reserved.runId);
  return { runId: reserved.runId, replayed: false };
 } catch (error) { await q.run("UPDATE meeting_turns SET status = 'error' WHERE run_id = ?", reserved.runId); await q.run("UPDATE meetings SET active_run_id = NULL, state = 'paused', version = version+1 WHERE id = ? AND active_run_id = ?", id, reserved.runId); throw error; }
}
function decisionInput(value: unknown): Decision {
 const b = keys(value, ['id','title','description','agentId','department','dueDate','enabled']);
 if (!meetingId(b.id) || typeof b.enabled !== 'boolean' || b.agentId != null && !meetingId(b.agentId)) invalid('Invalid decision');
 const department = b.department == null || b.department === '' ? null : text(b.department, 64).toLowerCase();
 if (department && !/^[a-z0-9][a-z0-9 _-]{0,63}$/.test(department)) invalid('Invalid department');
 const dueDate = b.dueDate == null || b.dueDate === '' ? null : text(b.dueDate, 10);
 if (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(Date.parse(dueDate)) || new Date(dueDate).toISOString().slice(0,10) !== dueDate)) invalid('Invalid due date');
 return { id: b.id, title: text(b.title, 160), description: text(b.description ?? '', 8000, false), agentId: b.agentId ?? null, department, dueDate, enabled: b.enabled, cardId: null, boardId: null };
}
export async function saveMeetingDecisions(owner: string, id: string, raw: unknown) {
 const b = keys(raw, ['expectedVersion','summary','decisions']); if (!Number.isSafeInteger(b.expectedVersion) || !Array.isArray(b.decisions) || b.decisions.length > 200) invalid('Invalid decision list');
 const summary = text(b.summary, 20000, false), decisions: Decision[] = b.decisions.map(decisionInput);
 if (new Set(decisions.map(d=>d.id)).size !== decisions.length) invalid('Duplicate decisions');
 await sql().tx(function* () {
  const row = yield* owned(owner,id); if (row.state !== 'review' || row.active_run_id || row.version !== b.expectedVersion) conflict('Finish the discussion and reload the latest review');
  for(const d of decisions) if(d.agentId && !(yield* one('SELECT agent_id FROM meeting_participants WHERE meeting_id = ? AND agent_id = ?',id,d.agentId))) invalid('Assign decisions to an invited agent');
  const changed = yield* run('UPDATE meetings SET summary = ?, version = version+1 WHERE id = ? AND owner_id = ? AND version = ?',summary,id,owner,b.expectedVersion); if(!changed.changes)conflict('Review changed');
  yield* run('DELETE FROM meeting_decisions WHERE meeting_id = ?',id);
  for(let i=0;i<decisions.length;i++){const d=decisions[i];yield* run('INSERT INTO meeting_decisions(id,meeting_id,title,description,agent_id,department,due_date,enabled,position) VALUES(?,?,?,?,?,?,?,?,?)',d.id,id,d.title,d.description,d.agentId,d.department,d.dueDate,d.enabled?1:0,i);}
 },{immediate:true}); return getMeeting(owner,id);
}
export async function proposeMeetingReview(owner: string,id: string) {
 const meeting=await getMeeting(owner,id);if(meeting.activeRunId)conflict('Wait for the summary reply');
 if(meeting.state==='completed')return meeting;
 const answer=await q.one<{content:string;run_id:string}>("SELECT m.content,t.run_id FROM meeting_turns t JOIN chat_messages m ON m.run_id=t.run_id AND m.session_id=? AND m.role='assistant' WHERE t.meeting_id=? AND t.kind='summary' AND t.status='complete' ORDER BY m.created_at DESC, m.id DESC LIMIT 1",meeting.conversationId,id);
 if(!answer)conflict('Ask for a meeting summary first');
 let parsed:any;try{const raw=answer!.content.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');parsed=JSON.parse(raw);}catch{invalid('The summary was not structured. You can write or edit the review yourself');}
 const summary=text(parsed.summary,20000);if(!Array.isArray(parsed.decisions)||parsed.decisions.length>30)invalid('Invalid proposed decisions');
 const decisions=[];
 for(const item of parsed.decisions){
  const o=object(item); let agent=meetingId(o.agentId)?await q.one<Agent>('SELECT a.id,a.name,a.department,a.role FROM meeting_participants p JOIN agents_config a ON a.id=p.agent_id WHERE p.meeting_id=? AND a.id=?',id,o.agentId):undefined;
  if(!agent && typeof o.assigneeName==='string' && o.assigneeName.length<=160){
   const matches=await q.all<Agent>('SELECT a.id,a.name,a.department,a.role FROM meeting_participants p JOIN agents_config a ON a.id=p.agent_id WHERE p.meeting_id=? AND a.name=? LIMIT 2',id,o.assigneeName);
   if(matches.length===1)agent=matches[0];
  }
  decisions.push({id:randomUUID(),title:text(o.title,160),description:text(o.description??'',8000,false),agentId:agent?.id??null,department:agent?.department??null,dueDate:null,enabled:true});
 }
 if(meeting.state!=='review')await changeMeetingState(owner,id,{expectedVersion:meeting.version,state:'review'});
 const latest=await getMeeting(owner,id),row=await sql().read(owned(owner,id));if(row.review_run_id===answer!.run_id)return latest;
 const result=await saveMeetingDecisions(owner,id,{expectedVersion:latest.version,summary,decisions});
 await q.run('UPDATE meetings SET review_run_id=? WHERE id=? AND owner_id=?',answer!.run_id,id,owner);return result;
}
export async function approveMeeting(owner:string,id:string,raw:unknown) {
 const b=keys(raw,['expectedVersion','boardId']);if(!Number.isSafeInteger(b.expectedVersion)||!meetingId(b.boardId))invalid('Choose a task board');
 await sql().tx(function*(){
  const row=yield* owned(owner,id);if(row.state==='completed'){const previous=yield* one('SELECT id FROM meeting_decisions WHERE meeting_id=? AND card_id IS NOT NULL AND board_id<>? LIMIT 1',id,b.boardId);if(previous)conflict('The decisions were already approved on another board');return;}
  if(row.state!=='review'||row.active_run_id||row.version!==b.expectedVersion)conflict('Reload and review the latest decisions');
  if(!(yield* one('SELECT id FROM boards WHERE id=? AND owner_id=? AND archived=0',b.boardId,owner)))invalid('Task board not found');
  const column=yield* one<{id:string}>('SELECT id FROM board_columns WHERE board_id=? ORDER BY position LIMIT 1',b.boardId);if(!column)invalid('The task board has no column');
  const decisions=yield* all<{id:string;title:string;description:string;agent_id:string|null;department:string|null;due_date:string|null;enabled:number}>('SELECT * FROM meeting_decisions WHERE meeting_id=? ORDER BY position',id);
  for(const d of decisions.filter(d=>d.enabled)){
   if(!d.agent_id||!(yield* one('SELECT agent_id FROM meeting_participants WHERE meeting_id=? AND agent_id=?',id,d.agent_id)))invalid('Choose an invited agent for every selected task');
   const card=yield* createCardSteps(owner,b.boardId,{columnId:column!.id,title:d.title,description:d.description,agents:[d.agent_id],departments:d.department?[d.department]:[],...(d.due_date?{dueDate:d.due_date}:{})},{conversationId:row.conversation_id});
   yield* run('UPDATE meeting_decisions SET board_id=?,card_id=? WHERE id=? AND meeting_id=?',b.boardId,card.id,d.id,id);
  }
  const note=cleanHandoff({done:[row.title,row.summary.slice(0,300)],next:decisions.filter(d=>d.enabled).slice(0,8).map(d=>d.title),left:[],questions:[]});
  const agent=yield* one<{agent_id:string}>('SELECT agent_id FROM meeting_participants WHERE meeting_id=? ORDER BY position LIMIT 1',id);const agentId=agent?.agent_id??MAIN_AGENT;
  const top=yield* one<{v:number}>('SELECT MAX(version) AS v FROM agent_handoffs WHERE owner_id=? AND agent_id=? AND scope_kind=? AND scope_id=?',owner,agentId,'conversation',row.conversation_id);
  yield* run('INSERT INTO agent_handoffs(id,owner_id,agent_id,scope_kind,scope_id,version,done,remaining,next_steps,open_questions,source) VALUES(?,?,?,?,?,?,?,?,?,?,?)',randomUUID(),owner,agentId,'conversation',row.conversation_id,Number(top?.v??0)+1,JSON.stringify(note.done),JSON.stringify(note.left),JSON.stringify(note.next),JSON.stringify(note.questions),'owner');
  const done=yield* run("UPDATE meetings SET state='completed',version=version+1 WHERE id=? AND owner_id=? AND version=?",id,owner,b.expectedVersion);if(!done.changes)conflict('Meeting changed during approval');
 },{immediate:true});return getMeeting(owner,id);
}

/** The ordinary chat composer may address only an invited participant while a meeting is active. */
export async function assertMeetingWriter(owner: string, conversation: string, agentId?: string | null) {
 const row = await q.one<Row>('SELECT * FROM meetings WHERE owner_id = ? AND conversation_id = ?', owner, conversation);
 if (!row) return;
 if (row.state !== 'active') conflict('Resume the meeting before sending another message');
 const id = agentId || (await q.one<{agent_id:string}>('SELECT agent_id FROM chat_sessions WHERE id=?',conversation))?.agent_id;
 if (!id || !await q.one('SELECT agent_id FROM meeting_participants WHERE meeting_id=? AND agent_id=?',row.id,id)) invalid('Choose an invited meeting participant');
}

/** A new owner contribution invalidates the earlier generated summary, retaining the editable draft until the next review. */
export async function invalidateMeetingSummary(owner: string, conversation: string) {
 await sql().tx(function*(){const row=yield* one<Row>("SELECT * FROM meetings WHERE owner_id=? AND conversation_id=? AND state='active'",owner,conversation);if(!row)return;yield* run("UPDATE meeting_turns SET status='superseded' WHERE meeting_id=? AND kind='summary'",row.id);yield* run('UPDATE meetings SET version=version+1 WHERE id=?',row.id);},{immediate:true});
}
