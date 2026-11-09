import {currentMemoryReadOrigin} from '../src/memory/encryption/read-origin-context.ts';
// Deferred actual Fastify/SQLite lifecycle fixtures on the final synthetic HOME only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import {createEncryptionDriverFixture} from './fixtures/memory-encryption-drivers.mjs';
import {createPrivateJwtContext} from '../src/auth/private-jwt-context.ts';
import {createSelectedOperationCoordinator} from '../src/memory/encryption/selected-operation-coordinator.ts';
import {createNativeRequestContext} from '../src/memory/encryption/native-request-context.ts';
import {run} from '../src/repositories/sql-steps.ts';
async function fixture(t){
 const db=await createEncryptionDriverFixture({driver:'sqlite',name:'native-request-context'}),key=Buffer.alloc(32,91),auth=createPrivateJwtContext({key,isCurrent:()=>true});
 await db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,status TEXT,token_version INTEGER);CREATE TABLE auth_sessions(id TEXT PRIMARY KEY,user_id TEXT,token_hash TEXT,token_version INTEGER,expires_at BIGINT,revoked_at BIGINT)');
 const token=jwt.sign({userId:'synthetic-owner',tokenVersion:1},key,{algorithm:'HS256',jwtid:'synthetic-context-session',expiresIn:3600}),tokenHash=createHash('sha256').update(JSON.stringify(['auth-session-v1','synthetic-context-session'])).digest('hex');
 await db.runner.tx(function*(){yield* run('INSERT INTO users VALUES(?,?,?,?)','synthetic-owner','owner','active',1);yield* run('INSERT INTO auth_sessions VALUES(?,?,?,?,?,?)','synthetic-session','synthetic-owner',tokenHash,1,Date.now()+3600000,null);});
 let physical=true;const coordinator=createSelectedOperationCoordinator({runner:db.runner,launchId:'synthetic-native-context',onPoison(){}}),app=Fastify(),beforeAuth=[];let context;
 context=createNativeRequestContext({authRunner:coordinator.runner,coordinator,captureControlFence:async()=>({storageId:'synthetic-control',isCurrent:()=>physical}),refreshBeforeAuthentication:async()=>{beforeAuth.push({authority:context.currentRequestAuthority(),operation:context.currentOperation()});}});context.register(app);
 app.addHook('onRequest',async request=>{if(request.headers.authorization==='Bearer '+token){request.authUser={id:'synthetic-owner',role:'owner'};request.actor={kind:'user',userId:'synthetic-owner'};}});
 t.after(async()=>{await app.close();context.close();coordinator.close();auth.close();key.fill(0);await db.close();});
 return{app,db,auth,context,coordinator,token,beforeAuth,revokePhysical(){physical=false;},headers:{authorization:'Bearer '+token}};
}
test('admission precedes authentication and exposes no invented owner while preserving actual request scope',async t=>{
 const f=await fixture(t);let held;
 f.app.get('/scope',async()=>{held=await f.context.captureRequestAuthority();return{ownerId:held.ownerId,current:held.isCurrent(),operationId:f.context.currentOperation().operationId};});
 await f.auth.run(async()=>{const response=await f.app.inject({method:'GET',url:'/scope',headers:f.headers});assert.equal(response.statusCode,200);assert.equal(response.json().ownerId,'synthetic-owner');assert.equal(response.json().current,true);assert.ok(response.json().operationId);});
 assert.equal(f.beforeAuth.length,1);assert.equal(f.beforeAuth[0].authority,null);assert.equal(typeof f.beforeAuth[0].operation.operationId,'string');assert.equal(f.context.currentRequestAuthority(),null);assert.equal(held.isCurrent(),false);assert.throws(()=>f.context.currentOperation());
});
test('parallel real request chains retain distinct admitted operations without global context leakage',async t=>{
 const f=await fixture(t);let arrivals=0,release;const ready=new Promise(resolve=>{release=resolve;});
 f.app.get('/parallel',async()=>{const before=f.context.currentOperation().operationId;if(++arrivals===2)release();await ready;return{before,after:f.context.currentOperation().operationId,owner:f.context.currentRequestAuthority()?.ownerId};});
 await f.auth.run(async()=>{const responses=await Promise.all([f.app.inject({url:'/parallel',headers:f.headers}),f.app.inject({url:'/parallel',headers:f.headers})]);const values=responses.map(response=>{assert.equal(response.statusCode,200);return response.json();});assert.notEqual(values[0].before,values[1].before);for(const value of values){assert.equal(value.before,value.after);assert.equal(value.owner,'synthetic-owner');}});assert.equal(f.context.currentRequestAuthority(),null);
});
test('actual session revocation after an await invalidates retained request authority',async t=>{
 const f=await fixture(t);f.app.get('/revoke',async()=>{const authority=await f.context.captureRequestAuthority();await f.coordinator.runner.tx(function*(){yield* run('UPDATE auth_sessions SET revoked_at=?',Date.now());});return{current:authority.isCurrent(),fresh:f.context.currentRequestAuthority()};});
 await f.auth.run(async()=>{const response=await f.app.inject({url:'/revoke',headers:f.headers});assert.equal(response.statusCode,200);assert.deepEqual(response.json(),{current:false,fresh:null});});
});
test('a revoked physical control fence never leaves a usable request authority',async t=>{
 const f=await fixture(t);f.app.get('/physical',async()=>{const authority=await f.context.captureRequestAuthority();f.revokePhysical();return{current:authority.isCurrent(),fresh:f.context.currentRequestAuthority()};});await f.auth.run(async()=>{const response=await f.app.inject({url:'/physical',headers:f.headers});assert.equal(response.statusCode,200);assert.deepEqual(response.json(),{current:false,fresh:null});});
});
test('unauthenticated requests receive operation metadata but no owner capability',async t=>{
 const f=await fixture(t);f.app.get('/public',async()=>({authority:f.context.currentRequestAuthority(),storage:f.context.currentOperation().controlStorageId}));await f.auth.run(async()=>{const response=await f.app.inject({url:'/public'});assert.equal(response.statusCode,200);assert.deepEqual(response.json(),{authority:null,storage:'synthetic-control'});});
});
test('an authenticated header cannot upgrade a mismatched request actor into owner authority',async t=>{
 const f=await fixture(t);f.app.get('/actor',async request=>{request.actor={kind:'agent',agentId:'synthetic-agent'};assert.equal(f.context.currentRequestAuthority(),null);await assert.rejects(()=>f.context.captureRequestAuthority());return{refused:true};});await f.auth.run(async()=>{const response=await f.app.inject({url:'/actor',headers:f.headers});assert.equal(response.statusCode,200);assert.deepEqual(response.json(),{refused:true});});
});
test('an async error response retains its actual admitted authority until the response ends',async t=>{
 const f=await fixture(t);let held;
 f.app.setErrorHandler(async(_error,_request,reply)=>{await new Promise(resolve=>setImmediate(resolve));held=await f.context.captureRequestAuthority();const rows=await f.coordinator.runner.tx(function*(){return yield* run('UPDATE users SET role=? WHERE id=?','owner','synthetic-owner');},{immediate:true});assert.equal(rows.changes,1);return reply.code(409).send({owner:held.ownerId,current:held.isCurrent()});});
 f.app.get('/error',async()=>{throw Error('synthetic request failure');});await f.auth.run(async()=>{const response=await f.app.inject({url:'/error',headers:f.headers});assert.equal(response.statusCode,409);assert.deepEqual(response.json(),{owner:'synthetic-owner',current:true});});assert.equal(held.isCurrent(),false);assert.equal(f.context.currentRequestAuthority(),null);
});

test('official coding-app read origin remains isolated across concurrent authenticated requests',async t=>{
 const f=await fixture(t);let arrivals=0,release;const ready=new Promise(resolve=>{release=resolve;});
 f.app.get('/reader-origin',async()=>{const before=currentMemoryReadOrigin();if(++arrivals===2)release();await ready;return{before,after:currentMemoryReadOrigin(),owner:f.context.currentRequestAuthority()?.ownerId};});
 await f.auth.run(async()=>{const [automated,human]=await Promise.all([f.app.inject({url:'/reader-origin',headers:{...f.headers,'x-girru-memory-reader':'coding-app'}}),f.app.inject({url:'/reader-origin',headers:f.headers})]);assert.equal(automated.statusCode,200);assert.equal(human.statusCode,200);const expected={readerKind:'coding-app',readerId:'girru-mcp'};assert.deepEqual(automated.json(),{before:expected,after:expected,owner:'synthetic-owner'});assert.deepEqual(human.json(),{before:null,after:null,owner:'synthetic-owner'});});assert.equal(currentMemoryReadOrigin(),null);
});
test('coding-app classification grants no owner authority and unknown reader claims are ignored',async t=>{
 const f=await fixture(t);f.app.get('/reader-public',async()=>({origin:currentMemoryReadOrigin(),owner:f.context.currentRequestAuthority()}));await f.auth.run(async()=>{const automated=await f.app.inject({url:'/reader-public',headers:{'x-girru-memory-reader':'coding-app'}});assert.equal(automated.statusCode,200);assert.deepEqual(automated.json(),{origin:{readerKind:'coding-app',readerId:'girru-mcp'},owner:null});const forged=await f.app.inject({url:'/reader-public',headers:{'x-girru-memory-reader':'human'}});assert.equal(forged.statusCode,200);assert.deepEqual(forged.json(),{origin:null,owner:null});});
});
