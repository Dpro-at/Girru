/** Owner commands change attendance, never the participants' source data or chat history. */
import { scrypt, createHash } from 'node:crypto';
import { q, sql, one, all, run, type Step } from '../repositories/sql-steps.js';
import { orderedId } from '../repositories/ordered-id.js';
import { listConversationMessages } from '../repositories/chat-conversations.js';
import { vaultSecretsInText } from './chat-secrets.js';
import { chatRuns } from './chat-runs.js';
import { stopReplyRound } from './chat-reply-rounds.js';
import { stopDelegations } from '../tools/tasks/team.js';
import { addressText } from './chat-addressing.js';
import { MeetingError, getMeeting, meetingId, meetingLock, selectionInput, type Selection } from './meetings.js';

type Command = { mode: 'invite' | 'dismiss' | 'keep' | 'replace'; selection: Selection; hostOnly?: boolean };
type Row = { id: string; owner_id: string; conversation_id: string; state: string; version: number; active_run_id: string | null; coordinator_agent_id: string | null };
type Receipt = { id: string; meeting_id: string; owner_id: string; request_digest: string; joined: number; left_count: number; present: number; result_version: number };
const deptAliases: Record<string, string[]> = {
  development: ['تطوير','برمجة'], marketing: ['تسويق'], sales: ['مبيعات'], support: ['دعم','خدمة العملاء'], finance: ['مالية','محاسبة'], security: ['امن','حماية'], research: ['بحث','بحوث','ابحاث'], operations: ['عمليات','تشغيل'], design: ['تصميم'], data: ['بيانات'], legal: ['قانون','قانونية'], hr: ['موارد بشرية','توظيف'], people: ['موارد بشرية','توظيف'], education: ['تعليم'], engineering: ['هندسة'], creative: ['ابداع','انتاج ابداعي'],
};
const tokens = (text: string) => (addressText(text).match(/[\p{L}\p{N}]+/gu) ?? []).map(word => word.replace(/^[وف]?ال/u, ''));
export function attendanceCommand(message: string, departments: string[]): Command | 'clarify' | null {
  const text = addressText(message), parts = tokens(message), normalized = ' ' + parts.join(' ') + ' ';
  if (/(?:^|\s)(?:لا|مو|مش)\s+(?:اريد|نريد|تخلي|تحضر|يحضر|احضر|تدعو|تدعي|تستدع|تدخل|يدخل|تطلع|يطلع|تخرج|يخرج|تنسحب|ينسحب|يبقى|تبقى)/u.test(text)
    || /\b(?:don't|do not|never)\s+(?:invite|join|bring|add|dismiss|remove|leave|keep|let|have|make)\b/u.test(text)) return null;
  if (/^(?:كيف|شلون|how|ماذا لو|what if|قال|قالوا|كتب|اشرح|وضح|لخص|ترجم)(?:\s|$)/u.test(text.trim()) || /(?:غدا|بعدين|لاحقا|اذا|لو |tomorrow|later|what if|except|excluding|غير |عدا )/u.test(text)) return null;
  const join = /(?:يحضر|تحضر|احضر|حضروا|انضم|ينضم|ادعو|استدع|استدعي|ادخل|يدخل|تعالوا|\binvite\b|\bjoin\b|\bbring\b|\badd\b)/u.test(text);
  const leave = /(?:تخرج|يخرج|اخرج|يطلع|اطلع|يغادر|غادر|انسحب|ينسحب|\bleave\b|\bdismiss\b|\bremove\b|\bexit\b)/u.test(text);
  const only = /(?:بس|فقط|\bonly\b)/u.test(text);
  const keep = only && (/(?:يبقى|يبقون|تبقى|خلي|يضل|\bkeep\b|\bstay\b|\bremain\b)/u.test(text) || /^(?:بس|فقط|only)(?:\s|$)/u.test(text.trim()));
  if (!join && !leave && !keep) return null;
  const heads=parts.some(part=>['مدراء','مدرا','مدير','مديري','مديرين','رؤساء','روساء','روسا','رئساء','رئيس','heads','managers','leaders'].map(addressText).includes(part));
  const host = /(?:المين|الاساسي|الرئيسي|\bmain(?: agent)?\b|\bprimary\b|\bcoordinator\b)/u.test(text);
  const allPeople = /(?:^|\s)(?:الكل|كل|جميع|الجميع)(?:\s|$)|\b(?:everyone|everybody|all)\b/u.test(text);
  if(/(?:نتائج|نتايج|ملفات|تقرير|مخرجات|ملف|كود|\boutput\b|\bfiles\b|\breport\b)/u.test(text)&&!/(?:اجتماع|حضور|\bmeeting\b|\battendance\b)/u.test(text))return null;
  const names = departments.filter(name => [name.replace(/[_-]/g, ' '), ...(deptAliases[name.toLowerCase()] ?? [])].some(alias => normalized.includes(' ' + tokens(alias).join(' ') + ' ')));
  if (host && (keep || only && (join || leave))) return { mode: 'keep', hostOnly: true, selection: { mode: 'all', departments: [], agentIds: [], headsOnly: false } };
  if (join && leave && !keep) return 'clarify';
  if (!names.length && (parts.includes('قسم') || parts.includes('department')) && !normalized.includes(' كل قسم ')) return 'clarify';
  if (!names.length && /(?:اقسام|departments)/u.test(text) && !allPeople && !heads) return 'clarify';
  if (!names.length && !heads && !allPeople) return null;
  return { mode: only && join ? 'replace' : keep ? 'keep' : leave ? 'dismiss' : 'invite', selection: { mode: names.length ? 'departments' : 'all', departments: names, agentIds: [], headsOnly: heads } };
}

const digest = (data: unknown, request: string): Promise<string> => new Promise((resolve, reject) => scrypt(JSON.stringify(data), 'meeting-attendance:' + request, 64, { N: 16384, r: 8, p: 1 }, (error, key) => error ? reject(error) : resolve(key.toString('hex'))));
const bad = (message: string): never => { throw new MeetingError(400, 'invalid_meeting', message); };
const conflict = (message: string): never => { throw new MeetingError(409, 'meeting_conflict', message); };

export async function changeMeetingAttendance(owner: string, id: string, raw: unknown, chat?: { runId: string; message: string }) {
  const b = raw as Record<string, any>;
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(key => !['requestId','expectedVersion','mode','selection'].includes(key)) || !meetingId(b.requestId) || !Number.isSafeInteger(b.expectedVersion) || !['invite','dismiss','keep','replace'].includes(b.mode)) throw new MeetingError(400,'invalid_meeting','Invalid attendance command');
  const selection = selectionInput(b.selection), hash = await digest({ mode: b.mode, selection }, b.requestId);
  const scope=await q.one<{conversation_id:string}>('SELECT conversation_id FROM meetings WHERE id=? AND owner_id=?',id,owner);
  if(!scope)throw new MeetingError(404,'not_found','Meeting not found');
  const message = chat ? (await vaultSecretsInText(owner, scope.conversation_id, chat.message)).text : '';
  const userId = orderedId(), assistantId = orderedId();
  const result = await sql().tx(function* (): Step<{receipt:Receipt; replayed:boolean; session:string; active:string|null; coordinator:string}> {
    const row = yield* one<Row>('SELECT * FROM meetings WHERE id=? AND owner_id=?', id, owner);
    if (!row) throw new MeetingError(404,'not_found','Meeting not found');
    const old = yield* one<Receipt>('SELECT * FROM meeting_attendance_changes WHERE id=?', b.requestId);
    const coordinator = row.coordinator_agent_id ?? (yield* one<{id:string}>('SELECT id FROM agents_config WHERE is_primary=1 ORDER BY id LIMIT 1'))?.id ?? (yield* one<{agent_id:string}>('SELECT agent_id FROM chat_sessions WHERE id=?',row.conversation_id))?.agent_id;
    if (!coordinator) throw new MeetingError(400,'invalid_meeting','Meeting coordinator is unavailable');
    if (old) { if (old.meeting_id!==id || old.owner_id!==owner || old.request_digest!==hash) conflict('Attendance request was already used');return{receipt:old,replayed:true,session:row.conversation_id,active:null,coordinator}; }
    if (!['active','paused'].includes(row.state) || Number(row.version)!==b.expectedVersion) conflict('Reload the meeting before changing attendance');
    if (chat && (yield* one('SELECT run_id FROM chat_run_journal WHERE run_id=?',chat.runId))) conflict('This chat request was already used');
    const available = yield* all<{id:string;department:string|null;role:string|null}>('SELECT id,department,role FROM agents_config ORDER BY id LIMIT 5001');
    const selected = available.filter(a => (selection.mode==='all' || selection.mode==='agents' && selection.agentIds.includes(a.id) || selection.mode==='departments' && selection.departments.includes(a.department?.toLowerCase()??'')) && (!selection.headsOnly || a.role==='manager' || a.role==='main'));
    if (selection.mode==='agents' && selected.length!==selection.agentIds.length || selection.mode==='departments' && selection.departments.some(d=>!selected.some(a=>a.department?.toLowerCase()===d)) || !selected.length) bad('The requested participants are unavailable');
    const before = yield* all<{agent_id:string;position:number;attending:number}>('SELECT agent_id,position,attending FROM meeting_participants WHERE meeting_id=?',id);
    const current = new Set(before.filter(p=>p.attending).map(p=>p.agent_id)), target = new Set(selected.map(a=>a.id));
    const after = b.mode==='replace' ? target : new Set([...current].filter(id=>b.mode==='keep'?target.has(id):b.mode!=='dismiss'||!target.has(id)));
    if (b.mode==='invite') for (const person of target) after.add(person);
    after.add(coordinator);
    if (after.size>5000) bad('A meeting supports at most 5000 participants');
    const live=chatRuns.activeFor(row.conversation_id);
    if(live?.agentId && !after.has(live.agentId)){live.requestStop();stopDelegations(row.conversation_id);}
    yield* run("UPDATE chat_reply_rounds SET state='paused' WHERE owner_id=? AND session_id=? AND state='active'",owner,row.conversation_id);
    let position = before.reduce((max,p)=>Math.max(max,Number(p.position)), -1)+1;
    for (const person of after) if (!before.some(p=>p.agent_id===person)) yield* run('INSERT INTO meeting_participants(meeting_id,agent_id,position,attending) VALUES(?,?,?,1)',id,person,position++);
    for (const person of before) { const attending=after.has(person.agent_id)?1:0;if(attending!==Number(person.attending))yield* run('UPDATE meeting_participants SET attending=? WHERE meeting_id=? AND agent_id=?',attending,id,person.agent_id); }
    const joined=[...after].filter(id=>!current.has(id)).length,left=[...current].filter(id=>!after.has(id)).length;
    const changed=yield* run('UPDATE meetings SET coordinator_agent_id=?,cursor=CASE WHEN ?=1 THEN 0 ELSE cursor END,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_id=? AND version=?',coordinator,joined||left?1:0,id,owner,row.version);
    if(!changed.changes)conflict('Meeting changed before attendance was saved');
    yield* run('UPDATE chat_sessions SET agent_id=? WHERE id=? AND user_id=?',coordinator,row.conversation_id,owner);
    if(joined||left)yield* run("UPDATE meeting_turns SET status='superseded' WHERE meeting_id=? AND kind='summary'",id);
    yield* run('INSERT INTO meeting_attendance_changes(id,meeting_id,owner_id,request_digest,joined,left_count,present,result_version) VALUES(?,?,?,?,?,?,?,?)',b.requestId,id,owner,hash,joined,left,after.size,Number(row.version)+1);
    if(chat){
      const answer=/[\u0600-\u06ff]/u.test(chat.message)?`تم تحديث حضور الاجتماع: انضم ${joined}، وانسحب ${left}. الحاضرون الآن ${after.size}، والإيجنت الرئيسي باقٍ. سجل الاجتماع والقرارات محفوظ.`:`Meeting attendance updated: ${joined} joined, ${left} left, ${after.size} present. The coordinator remains; history and decisions are kept.`;
      yield* run("INSERT INTO chat_messages(id,session_id,role,content,run_id,status) VALUES(?,?,'user',?,?,'complete')",userId,row.conversation_id,message,chat.runId);
      yield* run("INSERT INTO chat_messages(id,session_id,role,content,run_id,status,agent_id) VALUES(?,?,'assistant',?,?,'complete',?)",assistantId,row.conversation_id,answer,chat.runId,coordinator);
    }
    return{receipt:{id:b.requestId,meeting_id:id,owner_id:owner,request_digest:hash,joined,left_count:left,present:after.size,result_version:Number(row.version)+1},replayed:false,session:row.conversation_id,active:row.active_run_id,coordinator};
  },{immediate:true});
  if(!result.replayed){
    const active=chatRuns.activeFor(result.session);
    if(active){await stopReplyRound(owner,active.id);if(active.agentId && !await q.one('SELECT agent_id FROM meeting_participants WHERE meeting_id=? AND agent_id=? AND attending=1',id,active.agentId) && active.agentId!==result.coordinator){active.requestStop();stopDelegations(result.session);}}
  }
  return{meeting:await getMeeting(owner,id),joined:Number(result.receipt.joined),left:Number(result.receipt.left_count),present:Number(result.receipt.present),replayed:result.replayed};
}

export async function meetingAttendanceChat(owner: string, session: string, runId: string, message: string) {
  const row=await q.one<Row>('SELECT * FROM meetings WHERE owner_id=? AND conversation_id=?',owner,session);if(!row)return null;
  const departments=await q.all<{name:string}>("SELECT DISTINCT lower(department) AS name FROM agents_config WHERE department IS NOT NULL");
  const command=attendanceCommand(message,departments.map(d=>d.name));if(!command)return null;if(command==='clarify')throw new MeetingError(400,'attendance_needs_scope','Specify the department and whether it should join, leave or stay.');
  return meetingLock(row.id,async()=>{
    const fresh=await q.one<Row>('SELECT * FROM meetings WHERE id=? AND owner_id=?',row.id,owner);if(!fresh)return null;
    const coordinator=fresh.coordinator_agent_id??(await q.one<{id:string}>('SELECT id FROM agents_config WHERE is_primary=1 ORDER BY id LIMIT 1'))?.id??(await q.one<{agent_id:string}>('SELECT agent_id FROM chat_sessions WHERE id=?',session))?.agent_id;
    if(!coordinator)throw new MeetingError(400,'invalid_meeting','Meeting coordinator is unavailable');
    const requestId=createHash('sha256').update(runId).digest('hex');
    await changeMeetingAttendance(owner,row.id,{requestId,expectedVersion:Number(fresh.version),mode:command.mode,selection:command.hostOnly?{mode:'agents',agentIds:[coordinator],departments:[],headsOnly:false}:command.selection},{runId,message});
    const saved=await listConversationMessages(session);
    return{code:202,body:{runId,completed:true,userMessage:saved.find(m=>m.runId===runId&&m.role==='user'),assistantMessage:saved.find(m=>m.runId===runId&&m.role==='assistant')}};
  });
}
