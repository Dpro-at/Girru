// Temporary metadata only. Google is an explicit test verifier, never a production authority.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
process.env.NODE_ENV='test';
const {AccountStore,recoverStoppedAccountWriter}=await import('../src/store.ts'),{AccountService}=await import('../src/service.ts'),{listenAccountService}=await import('../src/server.ts'),C=await import('../src/contracts.ts'),{accountProofBody}=await import('../src/proof.ts'),E=await import('../../backend/src/phone/protocol/e2e.ts');
const {createIdentity,signCommand,publicKeyText}=E;
const temp=()=>fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dpro-account-'))),root=temp(),database=path.join(root,'db','metadata.db'),epochRoot=path.join(root,'independent-epoch');let now=Date.now();let store=new AccountStore({databasePath:database,epochRoot,initializeNewStore:true,confirmedIndependentRetention:true});
const verify=async(token,_client,nonce)=>{const data=JSON.parse(token);assert.equal(data.nonce,nonce);return {issuer:'https://accounts.google.com',subject:data.subject,verifiedAt:now,expiresAt:now+300000};};const serviceOf=()=>new AccountService({store,origin:'https://accounts.example.test/identity/v1',clientId:C.DEFAULT_GOOGLE_CLIENT_ID,verifyGoogle:verify,temporaryTestOnly:true,now:()=>now,secretKey:Buffer.alloc(32,7)});let service=serviceOf();
const peer=()=>({key:createIdentity(),sequence:0,session:null});
function command(p,challenge,op,payload){return signCommand(p.key,C.servicePeerId(service.origin),++p.sequence,accountProofBody(service.origin,challenge,op,payload));}
async function login(p,subject='123456789',extra={}){const publicKey=publicKeyText(p.key.publicKey),{challenge}=service.googleChallenge({publicKey}),payload={publicKey,idToken:JSON.stringify({nonce:challenge,subject}),label:'Temporary computer',osFamily:'macos',appVersion:'1',confirmFirstDevice:true,...extra},result=await service.googleExchange({challenge,command:command(p,challenge,'google.exchange',payload),...payload});p.session=result.session;return result;}
function request(p,op,payload={}){const {challenge}=service.requestChallenge(p.session.accessToken,{publicKey:publicKeyText(p.key.publicKey),operation:op,bodyHash:C.digest(C.canonical(payload))});return service.execute(p.session.accessToken,op,{challenge,command:command(p,challenge,op,payload),payload});}
function rotate(p,token=p.session.refreshToken){const payload={refreshToken:token,publicKey:publicKeyText(p.key.publicKey)},challenge=service.refreshChallenge(payload).challenge;return service.refresh({challenge,command:command(p,challenge,'session.refresh',payload),...payload});}
const T=await import('../../backend/src/auth/verification/totp.ts');
const codeAt=(secret,t=now)=>T.hotp(T.decodeSecret(secret),BigInt(Math.floor(t/30000)));
// D11: the Dpro account's own two-step sign-in, so a new computer can join when no other computer is on.
test('turn on, add a computer with the code, other computers are told, turn off',async()=>{
 const owner=peer(),phoneless=peer(),other=peer();await login(owner,'557000111');
 assert.deepEqual(request(owner,'twofactor.status'),{enabled:false,available:true});
 const fresh=await login(phoneless,'557000111');
 assert.throws(()=>request(phoneless,'device.approve.totp',{code:'123456',confirmed:true}),/twofactor_off/,'no code path before it is turned on');
 const {secret,uri}=request(owner,'twofactor.setup');assert.match(uri,/^otpauth:\/\/totp\/Girru:/);
 assert.equal(store.one('SELECT totp_pending FROM accounts WHERE id=?',fresh.view.id).totp_pending.includes(secret),false,'the secret is sealed at rest');
 assert.throws(()=>request(owner,'twofactor.enable',{code:'000000'}),/code_wrong/);
 assert.deepEqual(request(owner,'twofactor.enable',{code:codeAt(secret)}),{enabled:true});
 assert.throws(()=>request(owner,'twofactor.setup'),/twofactor_on/);
 now+=30000;
 assert.throws(()=>request(phoneless,'device.approve.totp',{code:codeAt(secret),confirmed:false}),/input/);
 const view=request(phoneless,'device.approve.totp',{code:codeAt(secret),confirmed:true});assert.equal(view.deviceStatus,'approved');
 assert.throws(()=>request(phoneless,'device.approve.totp',{code:codeAt(secret),confirmed:true}),/unavailable/,'used once');
 const told=request(owner,'device.requests').addedWithCode;assert.equal(told.length,1);assert.equal(told[0].deviceId,fresh.view.deviceId);
 const late=await login(other,'557000111');now+=30000;
 assert.throws(()=>request(other,'device.approve.totp',{code:codeAt(secret,now-30000),confirmed:true}),/code_wrong/,'an old code is refused');
 now+=6*60000;
 assert.throws(()=>request(other,'device.approve.totp',{code:codeAt(secret),confirmed:true}),/fresh_google/,'a recent Google sign-in is needed');
 assert.ok(late);
 now+=30000;
 assert.throws(()=>request(owner,'twofactor.disable',{code:codeAt(secret),confirmed:true}),/fresh_google/);
 await login(owner,'557000111');now+=30000;
 assert.deepEqual(request(owner,'twofactor.disable',{code:codeAt(secret),confirmed:true}),{enabled:false});
 assert.equal(request(owner,'twofactor.status').enabled,false);
});
test('five wrong codes in 15 minutes make the account wait',async()=>{
 const owner=peer(),guess=peer();await login(owner,'557000222');const {secret}=request(owner,'twofactor.setup');request(owner,'twofactor.enable',{code:codeAt(secret)});
 await login(guess,'557000222');
 for(let i=0;i<5;i++)assert.throws(()=>request(guess,'device.approve.totp',{code:String(100000+i),confirmed:true}),/code_wrong/);
 now+=30000;assert.throws(()=>request(guess,'device.approve.totp',{code:codeAt(secret),confirmed:true}),/wait/,'even the right code waits');
 now+=16*60000;await login(guess,'557000222');now+=30000;
 assert.equal(request(guess,'device.approve.totp',{code:codeAt(secret),confirmed:true}).deviceStatus,'approved');
});
test('without a service key, two-step stays off',async()=>{
 const plain=new AccountService({store,origin:'https://accounts.example.test/identity/v1',clientId:C.DEFAULT_GOOGLE_CLIENT_ID,verifyGoogle:verify,temporaryTestOnly:true,now:()=>now});
 const keep=service;service=plain;try{const p=peer();await login(p,'557000333');assert.deepEqual(request(p,'twofactor.status'),{enabled:false,available:false});assert.throws(()=>request(p,'twofactor.setup'),/unavailable/);}finally{service=keep;}
});
