import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes,randomUUID} from 'node:crypto';
const url=process.env.MEETING_TEST_PG_URL;
if(url){const target=new URL(url);assert.ok(['127.0.0.1','localhost'].includes(target.hostname)&&target.pathname.startsWith('/team_admin_test_'),'Use a disposable loopback test database');}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'meeting-audience-'));process.env.HOME=root;process.env.AGENT_PLAYER_DATA_DIR=root;process.env.DATABASE_PATH=path.join(root,'auth.db');process.env.AGENT_PLAYER_DB=url?'postgres':'sqlite';if(url)process.env.AGENT_PLAYER_PG_URL=url;process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('No external network in meeting acceptance');};
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase({path:process.env.DATABASE_PATH});await db.initialize();
const {q}=await import('../src/repositories/sql-steps.ts');const {createMeeting}=await import('../src/services/meetings.ts');const {dispatchReplyRound,replyRoundStatus}=await import('../src/services/chat-reply-rounds.ts');const R=await import('../src/repositories/chat-conversations.ts');
const owner='meeting-owner-'+randomUUID();await q.run("INSERT INTO users(id,email,username,password_hash,role,status) VALUES(?,?,?,'synthetic','owner','active')",owner,owner+'@example.invalid','Meeting owner');
const ids=['host','design','finance'].map(x=>x+'-'+randomUUID());
for(const [n,id] of ids.entries())await q.run('INSERT INTO agents_config(id,name,department,role,is_primary) VALUES(?,?,?,?,?)',id,['Host','Designer','Accountant'][n],['management','design','finance'][n],n?'specialist':'main',n?0:1);
// Choose the host explicitly, independent of any seeded primary fixture.
const meeting=await createMeeting(owner,{requestId:randomUUID(),title:'Synthetic invitation',objective:'Check routing',selection:{mode:'agents',agentIds:ids,departments:[],headsOnly:false}});
await q.run('UPDATE meetings SET coordinator_agent_id=? WHERE id=?',ids[0],meeting.id);await q.run('UPDATE chat_sessions SET agent_id=? WHERE id=?',ids[0],meeting.conversationId);
const c=await R.findConversation(owner,meeting.conversationId);
const specialty=randomUUID();await q.run('INSERT INTO specialty_templates(id,name,department,description,revision,content_hash,config_json) VALUES(?,?,?,?,?,?,?)',specialty,'Accountant','finance','Synthetic job',1,'synthetic','{}');await q.run('INSERT INTO agent_specialties(agent_id,template_id,linked_by) VALUES(?,?,?)',ids[2],specialty,owner);
async function round(message){
 const turns=[],runId=randomUUID();
 const start=async input=>{if(!input.continuationMessageId)await R.addUserMessage(c.id,input.message,input.runId);await R.addAssistantMessage(c.id,{runId:input.runId,content:'Synthetic contribution',parts:[],status:'complete',durationMs:1,agentId:input.agentId??ids[0]});turns.push(input);return {code:202,body:{runId:input.runId}};};
 const input={userId:owner,role:'owner',c,runId,message};const out=await dispatchReplyRound(input,start);assert.equal(out.code,202);
 for(let i=0;i<turns.length;i++)await turns[i].onFinished?.('complete');
 return {turns,input,start};
}
test('meeting routing works on the selected SQL driver without providers, duplicates or outsiders',async()=>{
 const all=await round('الكل هنا؟');assert.equal(all.turns.length,3);assert.equal(all.turns[0].agentId,ids[0]);assert.deepEqual(new Set(all.turns.map(t=>t.agentId)),new Set(ids));assert.equal((await replyRoundStatus(owner,c.id)).state,'complete');
 const replay=await dispatchReplyRound(all.input,all.start);assert.equal(replay.body.replayed,true);assert.equal(all.turns.length,3);
 assert.deepEqual((await round('قسم التصميم شنو رايكم؟')).turns.map(t=>t.agentId),[ids[1]]);
 assert.deepEqual((await round('خلي المحاسبين يردون')).turns.map(t=>t.agentId),[ids[2]]);
 assert.equal((await round('شنو رأيكم؟')).turns.length,3);
 assert.equal((await round('لخص الموضوع')).turns.length,1);
});
test.after(async()=>{globalThis.fetch=oldFetch;if(url)await (await import('../src/db/pg/pool.ts')).closePgPool();closeDatabase();fs.rmSync(root,{recursive:true,force:true});});
