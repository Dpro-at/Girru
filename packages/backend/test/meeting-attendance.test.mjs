import test from 'node:test';import assert from 'node:assert/strict';import{mkdtempSync,mkdirSync,writeFileSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{pathToFileURL}from'node:url';import{randomBytes,randomUUID}from'node:crypto';
const base=process.cwd(),dir=mkdtempSync(join(tmpdir(),'girru-meetings-')),load=f=>import(pathToFileURL(join(base,f)).href);const warm=join(dir,'warm.ts');writeFileSync(warm,'export const ready: boolean = true;');await import(pathToFileURL(warm).href);mkdirSync(join(dir,'.data'));process.chdir(dir);process.env.HOME=dir;process.env.USERPROFILE=dir;process.env.DATABASE_PATH=join(dir,'.data','db.sqlite');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const{getDatabase,closeDatabase}=await load('src/db/database.ts'),db=getDatabase();await db.initialize();for(const[id,role]of[['owner-a','owner'],['owner-b','owner'],['member','user']])db.prepare('INSERT INTO users(id,email,username,password_hash,role,status) VALUES(?,?,?,?,?,?)').run(id,id+'@example.test',id,'test',role,'active');db.prepare('DELETE FROM agents_config').run();db.transaction(()=>{const s=db.prepare('INSERT INTO agents_config(id,name,department,role) VALUES(?,?,?,?)');for(let i=0;i<5000;i++)s.run('agent-'+i,'Agent '+String(i).padStart(4,'0'),'department-'+Math.floor(i/250),i%250===0?'manager':'specialist');});
const M=await load('src/services/meetings.ts'),{default:Fastify}=await import('fastify'),{meetingRoutes}=await load('src/api/routes/meetings.ts'),{generateToken}=await load('src/auth/jwt.ts'),{addUserMessage,addAssistantMessage}=await load('src/repositories/chat-conversations.ts'),{createBoard}=await load('src/services/task-board.ts');let starts=0;const fake=async x=>{starts++;await addUserMessage(x.c.id,x.displayMessage??x.message,x.runId);await addAssistantMessage(x.c.id,{runId:x.runId,content:x.message.includes('Return only JSON')?JSON.stringify({summary:'Reviewed readiness',decisions:[{title:'Verify installers',description:'Check manifests',agentId:x.agentId}]}):'Reply from '+x.agentId,parts:[],status:'complete',durationMs:1,agentId:x.agentId});return{code:202,body:{runId:x.runId}}};const app=Fastify();await app.register(meetingRoutes,{startTurn:fake});await app.ready();const call=(method,url,body,who='owner-a')=>app.inject({method,url,payload:body,headers:who?{authorization:'Bearer '+generateToken(who,1)}:{}});const selection=(departments=['department-0','department-1'],headsOnly=false)=>({mode:'departments',departments,agentIds:[],headsOnly});let meeting;
test.after(async()=>{await app.close();await(await load('src/services/discovery-fs.ts')).discoveryFs.close();closeDatabase();process.chdir(base);rmSync(dir,{recursive:true,force:true,maxRetries:10});});
const A=await load('src/services/meeting-attendance.ts');
db.prepare("UPDATE agents_config SET is_primary=1,role='main',name='Main Agent' WHERE id='agent-4999'").run();
db.prepare("UPDATE agents_config SET department='development' WHERE department='department-0'").run();
db.prepare("UPDATE agents_config SET department='marketing' WHERE department='department-1'").run();
const allHeads={mode:'all',departments:[],agentIds:[],headsOnly:true};
const developer={mode:'departments',departments:['development'],agentIds:[],headsOnly:false};
const create=()=>M.createMeeting('owner-a',{requestId:randomUUID(),title:'Attendance review',objective:'Review attendance',selection:{mode:'agents',agentIds:['agent-1','agent-2'],departments:[],headsOnly:false}});
const command=(m,mode,selection,requestId=randomUUID())=>call('POST',`/api/meetings/${m.id}/attendance`,{requestId,expectedVersion:m.version,mode,selection});
let current;
test('composed attendance commands understand heads, departments, keep/dismiss and preserve hypothetical questions',()=>{
 for(const text of ['لا تحضر كل المدراء','لا اريد كل المدراء يحضرون','لا تخرج قسم التطوير',"do not invite all managers","don't dismiss development"])assert.equal(A.attendanceCommand(text,['development']),null,text);
 assert.deepEqual(A.attendanceCommand('اريد كل مدراء الاقسام الان تحضر للاجتماع مباشر',['development','marketing']).selection,allHeads);
 assert.equal(A.attendanceCommand('الكل تخرج يبقى بس الاساسي',['development']).hostOnly,true);
 assert.equal(A.attendanceCommand('اريد بس قسم التطوير يحضر',['development']).mode,'replace');
 const dev=A.attendanceCommand('يبقى بس قسم التطوير',['development','marketing']);assert.equal(dev.mode,'keep');assert.deepEqual(dev.selection,developer);
 assert.equal(A.attendanceCommand('قسم التطوير ينسحب',['development']).mode,'dismiss');
 assert.equal(A.attendanceCommand('كيف اخلي كل المدراء يحضرون',['development']),null);
 assert.equal(A.attendanceCommand('غدا كل المدراء يحضرون',['development']),null);
 assert.equal(A.attendanceCommand('خلي قسم التطوير يشتغل على المهمة',['development']),null);
 assert.equal(A.attendanceCommand('اخرج النتائج من قسم التطوير',['development']),null);
 assert.equal(A.attendanceCommand('خلي كل مدراء الاقسام يحضرون',['development']).mode,'invite');
 assert.equal(A.attendanceCommand('كل مدراء قسم المجهول يحضرون',['development']),'clarify');
 assert.equal(A.attendanceCommand('بس قسم المجهول',['development']),'clarify');
});
test('joining heads changes only attendance and is owner-scoped, paged and idempotent',async()=>{
 let m=await create();assert.equal(m.count,3);assert.equal(m.coordinator.id,'agent-4999');
 const request=randomUUID(),payload={requestId:request,expectedVersion:m.version,mode:'invite',selection:allHeads};
 const out=await call('POST',`/api/meetings/${m.id}/attendance`,payload);assert.equal(out.statusCode,200,out.body);m=out.json().meeting;assert.equal(m.count,23);assert.equal((await M.meetingRoster('owner-a',{meetingId:m.id,limit:10})).total,23);
 const replay=await call('POST',`/api/meetings/${m.id}/attendance`,payload);assert.equal(replay.statusCode,200);assert.equal(replay.json().replayed,true);assert.equal(replay.json().meeting.count,23);
 assert.equal((await call('POST',`/api/meetings/${m.id}/attendance`,{...payload,requestId:randomUUID()},'member')).statusCode,403);
 assert.equal((await call('POST',`/api/meetings/${m.id}/attendance`,{...payload,requestId:randomUUID()},'owner-b')).statusCode,404);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM agents_config').get().n,5000);current=m;
});
test('keep only development filters existing attendance without inviting the whole department',async()=>{
 const out=await command(current,'keep',developer);assert.equal(out.statusCode,200,out.body);current=out.json().meeting;assert.equal(current.count,4);
 const roster=await M.meetingRoster('owner-a',{meetingId:current.id,limit:100});assert.equal(roster.total,4);assert.ok(roster.agents.every(a=>a.department==='development'||a.id==='agent-4999'));
 await assert.rejects(M.assertMeetingWriter('owner-a',current.conversationId,'agent-250'),{status:400});await M.assertMeetingWriter('owner-a',current.conversationId,'agent-4999');
});
test('the chat command leaves only Main, stores one real acknowledgement, preserves past attendees and retries without duplicate messages',async()=>{
 const before=starts,id='run-attendance-'+randomUUID();
 const reply=await A.meetingAttendanceChat('owner-a',current.conversationId,id,'الكل تخرج يبقى بس الاساسي');assert.equal(reply.code,202);assert.equal(reply.body.completed,true);assert.match(reply.body.assistantMessage.content,/الحاضرون الآن 1/);assert.equal(reply.body.assistantMessage.agentId,'agent-4999');
 const m=await M.getMeeting('owner-a',current.id);assert.equal(m.count,1);const participants=await M.meetingRoster('owner-a',{meetingId:m.id});assert.deepEqual(participants.agents.map(a=>a.id),['agent-4999']);
 const n=db.prepare('SELECT COUNT(*) n FROM chat_messages WHERE session_id=?').get(current.conversationId).n;
 await A.meetingAttendanceChat('owner-a',current.conversationId,id,'الكل تخرج يبقى بس الاساسي');assert.equal(db.prepare('SELECT COUNT(*) n FROM chat_messages WHERE session_id=?').get(current.conversationId).n,n);assert.equal(starts,before);
 assert.ok(db.prepare('SELECT COUNT(*) n FROM meeting_participants WHERE meeting_id=?').get(current.id).n>=23);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM agents_config').get().n,5000);current=m;
});
test('removed speakers cannot continue and rejected/stale changes do not modify attendance',async()=>{
 await assert.rejects(M.assertMeetingWriter('owner-a',current.conversationId,'agent-1'),{status:400});
 const stale=await call('POST',`/api/meetings/${current.id}/attendance`,{requestId:randomUUID(),expectedVersion:0,mode:'invite',selection:developer});assert.equal(stale.statusCode,409);assert.equal((await M.getMeeting('owner-a',current.id)).count,1);
 const invalid=await command(current,'invite',{...developer,departments:['missing']});assert.equal(invalid.statusCode,400);assert.equal((await M.getMeeting('owner-a',current.id)).count,1);
 const turn=await call('POST',`/api/meetings/${current.id}/turns`,{requestId:randomUUID()});assert.equal(turn.statusCode,202,turn.body);assert.equal(db.prepare('SELECT agent_id FROM meeting_turns WHERE run_id=?').get(turn.json().runId).agent_id,'agent-4999');
});

test('5000 attendees remain paged and can leave without invoking 5000 models or deleting their invitations',async()=>{
 let m=await create(),before=starts;const everyone={mode:'all',departments:[],agentIds:[],headsOnly:false};
 const joined=await command(m,'invite',everyone);assert.equal(joined.statusCode,200,joined.body);m=joined.json().meeting;assert.equal(m.count,5000);const page=await M.meetingRoster('owner-a',{meetingId:m.id,limit:100});assert.equal(page.agents.length,100);assert.equal(page.total,5000);
 const left=await command(m,'dismiss',everyone);assert.equal(left.statusCode,200,left.body);assert.equal(left.json().meeting.count,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM meeting_participants WHERE meeting_id=?').get(m.id).n,5000);assert.equal(starts,before);
});
