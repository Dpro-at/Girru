import './fixtures/trading-runtime.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes,randomUUID} from 'node:crypto';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'paper-practice-api-'));process.env.AGENT_PLAYER_DATA_DIR=root;process.env.DATABASE_PATH=path.join(root,'test.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
for(const [id,role]of [['practice-owner','owner'],['practice-other','owner'],['practice-admin','admin'],['practice-user','user']])db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES(?,?,?,'fixture',?,'active')").run(id,id+'@example.invalid',id,role);
const {default:Fastify}=await import('fastify'),{registerAuthGate}=await import('../src/auth/auth-gate.ts'),{generateToken}=await import('../src/auth/jwt.ts'),{tradingPaperPracticeRoutes}=await import('../src/api/routes/trading-paper-practice.ts');
const app=Fastify();registerAuthGate(app);await app.register(tradingPaperPracticeRoutes);await app.ready();
const {practiceResponse}=await import('../../core-ui/src/trading-practice-contract.js');
const base='/api/trading-paper/practice',headers=id=>({authorization:'Bearer '+generateToken(id,1)}),owner=headers('practice-owner');
const call=(method,suffix='',payload,user=owner)=>app.inject({method,url:base+suffix,headers:user,...(payload===undefined?{}:{payload})});
test.after(async()=>{await app.close();closeDatabase();fs.rmSync(root,{recursive:true,force:true});});
test('practice requires owner authentication before any state or input is inspected',async()=>{
 for(const [method,suffix,body]of [['GET','',undefined],['POST','',{}],['POST','/orders',{}],['POST','/end',{}],['POST','/step',{}],['POST','/stop-bot',{}]]){
 assert.equal((await call(method,suffix,body,{})).statusCode,401);for(const id of ['practice-user','practice-admin'])assert.equal((await call(method,suffix,body,headers(id))).statusCode,403);
 }
});
test('actual owner API buy/sell/step/stop/end uses only ephemeral state and preserves the main database',async()=>{
 const dump=()=>db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),before=dump(),rows=db.prepare('SELECT * FROM agents_config').all();
 assert.equal((await call('GET')).json().active,false);const first=await call('POST','',{});assert.equal(first.statusCode,200,first.body);assert.equal(practiceResponse(base,200,first.json()).active,true);const id=first.json().sessionId;assert.equal(first.headers['cache-control'],'no-store');
 const order={sessionId:id,requestId:randomUUID(),symbol:'DEMO-ALPHA',side:'buy',quantity:2};let r=await call('POST','/orders',order);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().positions[0].quantity,2);r=await call('POST','/orders',order);assert.equal(r.json().replayed,true);assert.equal(r.json().orders.length,1);
 r=await call('POST','/orders',{...order,requestId:randomUUID(),side:'sell',quantity:1});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().positions[0].quantity,1);assert.equal(r.json().netResultMinor,-8);assert.equal(practiceResponse(base+'/orders',200,r.json()).orders.length,2);
 r=await call('POST','/step',{sessionId:id,requestId:randomUUID()});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().bot.ticks,1);
 assert.equal((await call('POST','/stop-bot',{sessionId:id})).json().bot.stopped,true);assert.equal((await call('POST','/step',{sessionId:id,requestId:randomUUID()})).statusCode,409);
 assert.equal((await call('POST','/end',{sessionId:id})).json().active,false);assert.deepEqual(dump(),before);assert.deepEqual(db.prepare('SELECT * FROM agents_config').all(),rows);
});
test('cross-owner IDs, query escapes, balances, prices and extra fields are rejected',async()=>{
 const own=(await call('POST','',{})).json(),other=(await call('POST','',{},headers('practice-other'))).json();assert.notEqual(own.sessionId,other.sessionId);
 const body={sessionId:own.sessionId,requestId:randomUUID(),symbol:'DEMO-ALPHA',side:'buy',quantity:1};assert.equal((await call('POST','/orders',body,headers('practice-other'))).statusCode,409);
 for(const extra of [{priceMinor:1},{cashMinor:99999999},{ownerId:'practice-other'},{url:'https://example.invalid'},{mode:'live'}])assert.equal((await call('POST','/orders',{...body,...extra})).statusCode,400);
 assert.equal((await call('GET','?account=outside')).statusCode,400);assert.equal((await call('POST','',{cash:999})).statusCode,400);assert.equal((await call('POST','/orders',{...body,sessionId:'../outside'})).statusCode,400);
});
