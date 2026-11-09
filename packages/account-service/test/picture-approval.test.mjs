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
// B2: a new computer is added after a Yes on an approved computer that compared the same pictures; no codes are carried.
const own=(p,enrollment,accountId,deviceId)=>deviceComparisonCode(accountId,deviceId,publicKeyText(p.key.publicKey),enrollment.comparisonNonce);
test('picture approval: the new computer and the approving one compute the same code from what each sees',async()=>{
 const owner=peer(),fresh=peer(),stranger=peer();
 const o=await login(owner,'555000111');const f=await login(fresh,'555000111');await login(stranger,'777000111');
 assert.equal(o.view.deviceStatus,'approved');assert.equal(f.view.deviceStatus,'pending');
 const mine=request(fresh,'device.enrollment');assert.equal(mine.status,'pending');assert.match(mine.comparisonNonce,/^[A-Za-z0-9_-]{43}$/);assert.equal(mine.approvedBy,null);
 assert.throws(()=>request(fresh,'device.requests'),/pending/,'a pending computer cannot list requests');
 const {requests}=request(owner,'device.requests');assert.equal(requests.length,1);const r=requests[0];
 assert.equal(r.deviceId,f.view.deviceId);assert.equal(r.publicKey,publicKeyText(fresh.key.publicKey));assert.equal(r.comparisonNonce,mine.comparisonNonce);
 assert.equal(request(stranger,'device.requests').requests.length,0,'another account never sees it');
 const newSide=own(fresh,mine,f.view.id,f.view.deviceId),oldSide=deviceComparisonCode(o.view.id,r.deviceId,r.publicKey,r.comparisonNonce);
 assert.equal(newSide,oldSide);assert.match(newSide,/^[a-f0-9]{12}$/);
 assert.throws(()=>request(owner,'device.approve.v2',{deviceId:r.deviceId,publicKey:r.publicKey,comparisonCode:'000000000000',confirmed:true}),/changed/,'different pictures are refused');
 assert.throws(()=>request(owner,'device.approve.v2',{deviceId:r.deviceId,publicKey:publicKeyText(stranger.key.publicKey),comparisonCode:oldSide,confirmed:true}),/changed/,'a swapped key is refused');
 assert.throws(()=>request(owner,'device.approve.v2',{deviceId:r.deviceId,publicKey:r.publicKey,comparisonCode:oldSide,confirmed:false}),/comparison_required/);
 assert.throws(()=>request(stranger,'device.approve.v2',{deviceId:r.deviceId,publicKey:r.publicKey,comparisonCode:oldSide,confirmed:true}),/changed/,'another account cannot approve it');
 assert.throws(()=>request(fresh,'device.approve.v2',{deviceId:r.deviceId,publicKey:r.publicKey,comparisonCode:oldSide,confirmed:true}),/pending/,'it cannot approve itself');
 const view=request(owner,'device.approve.v2',{deviceId:r.deviceId,publicKey:r.publicKey,comparisonCode:oldSide,confirmed:true});
 assert.equal(view.devices.find(d=>d.id===r.deviceId).status,'approved');
 const after=request(fresh,'device.enrollment');assert.equal(after.status,'approved');assert.equal(after.comparisonNonce,null);assert.deepEqual(after.approvedBy,{deviceId:o.view.deviceId,publicKey:publicKeyText(owner.key.publicKey),label:'Temporary computer'});
 assert.equal(request(owner,'device.requests').requests.length,0);
 assert.throws(()=>request(owner,'device.approve.v2',{deviceId:r.deviceId,publicKey:r.publicKey,comparisonCode:oldSide,confirmed:true}),/changed/,'approving twice is refused');
});
test('picture approval needs a recent Google sign-in on the approving computer, and expires',async()=>{
 const owner=peer(),late=peer();await login(owner,'555000222');const l=await login(late,'555000222');
 const r=request(owner,'device.requests').requests[0],code=deviceComparisonCode(l.view.id,r.deviceId,r.publicKey,r.comparisonNonce);
 now+=6*60000;
 assert.throws(()=>request(owner,'device.approve.v2',{deviceId:r.deviceId,publicKey:r.publicKey,comparisonCode:code,confirmed:true}),/fresh_google|expired|invalid/);
 now+=10*60000;await login(owner,'555000222');
 assert.equal(request(owner,'device.requests').requests.length,0,'an expired request is no longer listed');
 assert.throws(()=>request(owner,'device.approve.v2',{deviceId:r.deviceId,publicKey:r.publicKey,comparisonCode:code,confirmed:true}),/changed/);
});
test('No on the approving computer forgets the new computer and ends its session',async()=>{
 const owner=peer(),unwanted=peer();await login(owner,'555000333');const u=await login(unwanted,'555000333');
 const r=request(owner,'device.requests').requests[0];assert.equal(r.deviceId,u.view.deviceId);
 assert.throws(()=>request(owner,'device.deny',{deviceId:r.deviceId,confirmed:false}),/input/);
 const view=request(owner,'device.deny',{deviceId:r.deviceId,confirmed:true});assert.equal(view.devices.find(d=>d.id===r.deviceId).status,'revoked');
 assert.throws(()=>request(unwanted,'device.enrollment'));
 assert.equal(request(owner,'device.requests').requests.length,0);
});
