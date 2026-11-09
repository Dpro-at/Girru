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
test('twenty wrong codes in a day lock the code path; the owner sees it; a Google-only reset needs the code',async()=>{
 const owner=peer(),thief=peer();const o=await login(owner,'557000444');const {secret}=request(owner,'twofactor.setup');request(owner,'twofactor.enable',{code:codeAt(secret)});
 await login(thief,'557000444');
 for(let round=0;round<4;round++){for(let i=0;i<5;i++)assert.throws(()=>request(thief,'device.approve.totp',{code:String(200000+round*10+i),confirmed:true}),/code_wrong/);now+=16*60000;await login(thief,'557000444');}
 now+=30000;assert.throws(()=>request(thief,'device.approve.totp',{code:codeAt(secret),confirmed:true}),/locked/,'after 20 wrong codes in a day only an approved computer can help');
 await login(owner,'557000444');assert.ok(request(owner,'device.requests').twoFactorFailuresToday>=20,'the owner is told about failed attempts');
 const fresh=peer(),publicKey=publicKeyText(fresh.key.publicKey),{challenge}=service.googleChallenge({publicKey});
 const payload={publicKey,idToken:JSON.stringify({nonce:challenge,subject:'557000444'}),label:'Thief',osFamily:'macos',appVersion:'1',confirmFirstDevice:false,resetAccount:true,resetConfirmation:'START A NEW DEVICE GROUP'};
 await assert.rejects(()=>service.googleExchange({challenge,command:command(fresh,challenge,'google.exchange',payload),...payload}),/locked|code_wrong|wait/,'Google alone cannot reset an account with two-step on');
 assert.equal(request(owner,'account.view').deviceStatus,'approved');assert.ok(o);
});
test('a computer approved by a computer that joined with the code also counts as joined with the code',async()=>{
 const owner=peer(),byCode=peer(),later=peer();await login(owner,'557000555');const {secret}=request(owner,'twofactor.setup');request(owner,'twofactor.enable',{code:codeAt(secret)});
 const b=await login(byCode,'557000555');now+=30000;request(byCode,'device.approve.totp',{code:codeAt(secret),confirmed:true});
 const l=await login(later,'557000555');const nD=(await import('node:crypto')).randomBytes(32).toString('base64url');request(later,'device.commit',{commitment:C.digest(nD)});
 const nA=(await import('node:crypto')).randomBytes(32).toString('base64url');request(byCode,'device.challenge',{deviceId:l.view.deviceId,nonce:nA});request(later,'device.reveal',{reveal:nD});
 const {deviceComparisonCode}=await import('../../backend/src/accounts/protocol.ts');
 request(byCode,'device.approve.v2',{deviceId:l.view.deviceId,publicKey:publicKeyText(later.key.publicKey),comparisonCode:deviceComparisonCode({accountId:b.view.id,deviceId:l.view.deviceId,publicKey:publicKeyText(later.key.publicKey),commitment:C.digest(nD),approverId:b.view.deviceId,approverKey:publicKeyText(byCode.key.publicKey),approverNonce:nA,reveal:nD}),confirmed:true});
 const ids=request(owner,'device.requests').viaCodeIds;assert.ok(ids.includes(b.view.deviceId)&&ids.includes(l.view.deviceId),'the chain is marked, so it needs Keep too');
});
