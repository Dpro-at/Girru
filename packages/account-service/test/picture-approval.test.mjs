// Temporary metadata only. Google is an explicit test verifier, never a production authority.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
process.env.NODE_ENV='test';
const {AccountStore,recoverStoppedAccountWriter}=await import('../src/store.ts'),{AccountService}=await import('../src/service.ts'),{listenAccountService}=await import('../src/server.ts'),C=await import('../src/contracts.ts'),{accountProofBody}=await import('../src/proof.ts'),E=await import('../../backend/src/phone/protocol/e2e.ts');
const {createIdentity,signCommand,publicKeyText}=E;
const temp=()=>fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dpro-account-'))),root=temp(),database=path.join(root,'db','metadata.db'),epochRoot=path.join(root,'independent-epoch');let now=Date.now();let store=new AccountStore({databasePath:database,epochRoot,initializeNewStore:true,confirmedIndependentRetention:true});
const verify=async(token,_client,nonce)=>{const data=JSON.parse(token);assert.equal(data.nonce,nonce);return {issuer:'https://accounts.google.com',subject:data.subject,verifiedAt:now,expiresAt:now+300000};};const serviceOf=()=>new AccountService({store,origin:'https://accounts.example.test/identity/v1',clientId:C.DEFAULT_GOOGLE_CLIENT_ID,verifyGoogle:verify,temporaryTestOnly:true,now:()=>now});let service=serviceOf();
const peer=()=>({key:createIdentity(),sequence:0,session:null});
function command(p,challenge,op,payload){return signCommand(p.key,C.servicePeerId(service.origin),++p.sequence,accountProofBody(service.origin,challenge,op,payload));}
async function login(p,subject='123456789',extra={}){const publicKey=publicKeyText(p.key.publicKey),{challenge}=service.googleChallenge({publicKey}),payload={publicKey,idToken:JSON.stringify({nonce:challenge,subject}),label:'Temporary computer',osFamily:'macos',appVersion:'1',confirmFirstDevice:true,...extra},result=await service.googleExchange({challenge,command:command(p,challenge,'google.exchange',payload),...payload});p.session=result.session;return result;}
function request(p,op,payload={}){const {challenge}=service.requestChallenge(p.session.accessToken,{publicKey:publicKeyText(p.key.publicKey),operation:op,bodyHash:C.digest(C.canonical(payload))});return service.execute(p.session.accessToken,op,{challenge,command:command(p,challenge,op,payload),payload});}
function rotate(p,token=p.session.refreshToken){const payload={refreshToken:token,publicKey:publicKeyText(p.key.publicKey)},challenge=service.refreshChallenge(payload).challenge;return service.refresh({challenge,command:command(p,challenge,'session.refresh',payload),...payload});}
const {deviceComparisonCode}=await import('../../backend/src/accounts/protocol.ts');
const {randomBytes}=await import('node:crypto');
// B2: commit-then-reveal. The new computer commits to a secret, the approving computer adds its own random value, then the secret is revealed; both screens show the same pictures only if nobody swapped a key.
const secret=()=>randomBytes(32).toString('base64url');
async function pair(subject){const owner=peer(),fresh=peer();const o=await login(owner,subject),f=await login(fresh,subject);return {owner,fresh,o,f};}
const code=(accountId,deviceId,publicKey,approverId,approverKey,approverNonce,reveal)=>deviceComparisonCode({accountId,deviceId,publicKey,commitment:C.digest(reveal),approverId,approverKey,approverNonce,reveal});
test('commit, challenge, reveal: both computers compute the same code and Yes approves',async()=>{
 const {owner,fresh,o,f}=await pair('556000111');const stranger=peer();await login(stranger,'556999111');
 assert.equal(request(owner,'device.requests').requests.length,0,'nothing is listed before the new computer commits');
 const nD=secret();assert.deepEqual(request(fresh,'device.commit',{commitment:C.digest(nD)}),{committed:true});
 assert.throws(()=>request(fresh,'device.commit',{commitment:C.digest(secret())}),/committed/,'the commitment is fixed once');
 assert.throws(()=>request(fresh,'device.requests'),/pending/);assert.equal(request(stranger,'device.requests').requests.length,0);
 const r=request(owner,'device.requests').requests[0];assert.equal(r.deviceId,f.view.deviceId);assert.equal(r.approverId,null);assert.equal(r.commitment,C.digest(nD),'the approving computer sees the commitment before it adds its own value');assert.throws(()=>deviceComparisonCode({accountId:'a',deviceId:'b',publicKey:'c',commitment:r.commitment,approverId:'d',approverKey:'e',approverNonce:'f',reveal:secret()}),/reveal_changed/,'a reveal that does not match the commitment is refused locally');
 assert.throws(()=>request(fresh,'device.reveal',{reveal:nD}),/unavailable/,'reveal waits for the approving computer');
 const nA=secret();request(owner,'device.challenge',{deviceId:r.deviceId,nonce:nA});
 assert.throws(()=>request(owner,'device.challenge',{deviceId:r.deviceId,nonce:secret()}),/taken/,'the challenge is fixed once');
 const seen=request(fresh,'device.enrollment');assert.equal(seen.approverNonce,nA);assert.equal(seen.approver.deviceId,o.view.deviceId);
 assert.throws(()=>request(fresh,'device.reveal',{reveal:secret()}),/reveal_changed/,'a different secret than committed is refused');
 request(fresh,'device.reveal',{reveal:nD});
 const ok=request(owner,'device.requests').requests[0];assert.equal(ok.reveal,nD);
 const newSide=code(f.view.id,f.view.deviceId,publicKeyText(fresh.key.publicKey),seen.approver.deviceId,seen.approver.publicKey,seen.approverNonce,nD);
 const oldSide=code(o.view.id,ok.deviceId,ok.publicKey,o.view.deviceId,publicKeyText(owner.key.publicKey),nA,ok.reveal);
 assert.equal(newSide,oldSide);
 assert.throws(()=>request(owner,'device.approve.v2',{deviceId:ok.deviceId,publicKey:ok.publicKey,comparisonCode:'0'.repeat(12),confirmed:true}),/changed/);
 assert.throws(()=>request(owner,'device.approve.v2',{deviceId:ok.deviceId,publicKey:publicKeyText(stranger.key.publicKey),comparisonCode:oldSide,confirmed:true}),/changed/,'a swapped key is refused');
 const view=request(owner,'device.approve.v2',{deviceId:ok.deviceId,publicKey:ok.publicKey,comparisonCode:oldSide,confirmed:true});
 assert.equal(view.devices.find(d=>d.id===ok.deviceId).status,'approved');
 const after=request(fresh,'device.enrollment');assert.equal(after.status,'approved');assert.equal(after.approvedBy.publicKey,publicKeyText(owner.key.publicKey));
});
test('only the approving computer that set the challenge can approve, and it needs a recent Google sign-in',async()=>{
 const {owner,fresh,o,f}=await pair('556000222');const second=peer();await login(second,'556000222');
 const r0=request(owner,'device.requests').requests.find(x=>x.deviceId===f.view.deviceId);
 // the second login is itself pending; approve it with the owner first so it can try to approve
 const nS=secret();request(second,'device.commit',{commitment:C.digest(nS)});
 const sReq=request(owner,'device.requests').requests.find(x=>x.publicKey===publicKeyText(second.key.publicKey));const sA=secret();request(owner,'device.challenge',{deviceId:sReq.deviceId,nonce:sA});const sSeen=request(second,'device.enrollment');request(second,'device.reveal',{reveal:nS});
 request(owner,'device.approve.v2',{deviceId:sReq.deviceId,publicKey:sReq.publicKey,comparisonCode:code(o.view.id,sReq.deviceId,sReq.publicKey,o.view.deviceId,publicKeyText(owner.key.publicKey),sA,nS),confirmed:true});
 assert.equal(r0,undefined,'a request without a commitment is never listed');
 const nD=secret();request(fresh,'device.commit',{commitment:C.digest(nD)});const nA=secret();
 request(owner,'device.challenge',{deviceId:f.view.deviceId,nonce:nA});request(fresh,'device.reveal',{reveal:nD});
 const c=code(o.view.id,f.view.deviceId,publicKeyText(fresh.key.publicKey),o.view.deviceId,publicKeyText(owner.key.publicKey),nA,nD);
 assert.throws(()=>request(second,'device.approve.v2',{deviceId:f.view.deviceId,publicKey:publicKeyText(fresh.key.publicKey),comparisonCode:c,confirmed:true}),/changed/,'another computer cannot finish someone else’s challenge');
 now+=6*60000;
 assert.throws(()=>request(owner,'device.approve.v2',{deviceId:f.view.deviceId,publicKey:publicKeyText(fresh.key.publicKey),comparisonCode:c,confirmed:true}),/fresh_google/);
 assert.ok(sSeen.approverNonce);
});
test('No forgets the new computer and ends its session; an expired request disappears',async()=>{
 const {owner,fresh,f}=await pair('556000333');request(fresh,'device.commit',{commitment:C.digest(secret())});
 assert.throws(()=>request(owner,'device.deny',{deviceId:f.view.deviceId,confirmed:false}),/input/);
 const view=request(owner,'device.deny',{deviceId:f.view.deviceId,confirmed:true});assert.equal(view.devices.find(d=>d.id===f.view.deviceId).status,'revoked');
 assert.throws(()=>request(fresh,'device.enrollment'));
 const late=peer();await login(late,'556000333');request(late,'device.commit',{commitment:C.digest(secret())});
 now+=11*60000;await login(owner,'556000333');
 assert.equal(request(owner,'device.requests').requests.length,0);
});
