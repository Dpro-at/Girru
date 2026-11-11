// People (CP17): fixed public ID, nickname, adding by exact ID or nickname, a code that changes every 90 s.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
process.env.NODE_ENV='test';
const {AccountStore}=await import('../src/store.ts'),{AccountService}=await import('../src/service.ts'),C=await import('../src/contracts.ts'),{accountProofBody}=await import('../src/proof.ts'),E=await import('../../backend/src/phone/protocol/e2e.ts'),P=await import('../src/people.ts');
const {createIdentity,signCommand,publicKeyText}=E;
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'girru-people-')));
let now=Date.UTC(2026,10,11,12,0,0);
const store=new AccountStore({databasePath:path.join(root,'db','metadata.db'),epochRoot:path.join(root,'epoch'),initializeNewStore:true,confirmedIndependentRetention:true});
const verify=async(token,_client,nonce)=>{const data=JSON.parse(token);assert.equal(data.nonce,nonce);return {issuer:'https://accounts.google.com',subject:data.subject,verifiedAt:now,expiresAt:now+300000};};
const service=new AccountService({store,origin:'https://accounts.example.test/identity/v1',clientId:C.DEFAULT_GOOGLE_CLIENT_ID,verifyGoogle:verify,temporaryTestOnly:true,now:()=>now});
test.after(()=>{service.close();store.close();});
const peer=()=>({key:createIdentity(),sequence:0,session:null});
const command=(p,challenge,op,payload)=>signCommand(p.key,C.servicePeerId(service.origin),++p.sequence,accountProofBody(service.origin,challenge,op,payload));
async function login(p,subject,extra={}){const publicKey=publicKeyText(p.key.publicKey),{challenge}=service.googleChallenge({publicKey}),payload={publicKey,idToken:JSON.stringify({nonce:challenge,subject}),label:'Computer of '+subject,osFamily:'macos',appVersion:'1',confirmFirstDevice:true,...extra},result=await service.googleExchange({challenge,command:command(p,challenge,'google.exchange',payload),...payload});p.session=result.session;return result;}
function request(p,op,payload={}){const {challenge}=service.requestChallenge(p.session.accessToken,{publicKey:publicKeyText(p.key.publicKey),operation:op,bodyHash:C.digest(C.canonical(payload))});return service.execute(p.session.accessToken,op,{challenge,command:command(p,challenge,op,payload),payload});}

const mohamed=peer(),sara=peer(),ali=peer(),saraLaptop=peer();
let mine,hers,alis;
/* Access tokens last 10 minutes: sign the same computers in again after a long wait. */
const again=async()=>{await login(mohamed,'1001');await login(sara,'2002');await login(ali,'3003');};

test('each account gets one fixed public ID; it never changes',async()=>{
  await login(mohamed,'1001');await login(sara,'2002');await login(ali,'3003');
  mine=request(mohamed,'people.me');hers=request(sara,'people.me');alis=request(ali,'people.me');
  assert.match(mine.publicId,/^GR-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  assert.equal(mine.nickname,null);
  assert.deepEqual(request(mohamed,'people.me'),mine);
  assert.notEqual(mine.publicId,hers.publicId);
});

test('nickname: optional, unique, 3-24 letters/numbers/dot/dash, never shaped like an ID',()=>{
  assert.equal(request(mohamed,'people.nickname',{nickname:'Mohamed.Alarade'}).nickname,'mohamed.alarade');
  assert.equal(request(mohamed,'people.me').publicId,mine.publicId);
  for(const bad of ['ab','gr-abc','-sara','sara..dev','sara dev','x'.repeat(25),'سارة'])assert.throws(()=>request(sara,'people.nickname',{nickname:bad}),/nickname_invalid/,bad);
  assert.throws(()=>request(sara,'people.nickname',{nickname:'mohamed.alarade'}),/nickname_taken/);
  assert.equal(request(sara,'people.nickname',{nickname:'sara.dev'}).nickname,'sara.dev');
  assert.throws(()=>request(sara,'people.nickname',{nickname:'sara.k'}),/wait/);
  now+=61_000;
  assert.equal(request(sara,'people.nickname',{nickname:null}).nickname,null);
  now+=61_000;
  request(sara,'people.nickname',{nickname:'sara.dev'});
});

test('find only by the exact nickname or ID; never yourself; no listing',()=>{
  const byName=request(mohamed,'people.find',{query:'Sara.Dev'});
  assert.equal(byName.found,true);assert.equal(byName.person.publicId,hers.publicId);assert.equal(byName.computers,1);
  assert.equal(request(mohamed,'people.find',{query:hers.publicId.toLowerCase()}).person.nickname,'sara.dev');
  assert.equal(request(mohamed,'people.find',{query:'sara'}).found,false);
  assert.equal(request(mohamed,'people.find',{query:'%'}).found,false);
  assert.equal(request(mohamed,'people.find',{query:mine.publicId}).found,false);
});

test('a pending computer cannot use people; find is rate limited',async()=>{
  await login(saraLaptop,'2002');
  assert.throws(()=>request(saraLaptop,'people.me'),/pending/);
  for(let i=0;i<30;i++)request(ali,'people.find',{query:'nobody.here'});
  assert.throws(()=>request(ali,'people.find',{query:'nobody.here'}),/wait/);
  now+=10*60_000+1;await again();
  assert.equal(request(ali,'people.find',{query:'nobody.here'}).found,false);
});

test('request → both see the same code; it changes every 90 s; only the receiver accepts with the current code',()=>{
  const sent=request(mohamed,'people.request',{publicId:hers.publicId});
  assert.match(sent.code,/^\d{8}$/);
  const incoming=request(sara,'people.requests').incoming;
  assert.equal(incoming.length,1);assert.equal(incoming[0].code,sent.code);assert.equal(incoming[0].person.nickname,'mohamed.alarade');
  assert.equal(request(mohamed,'people.requests').outgoing[0].linkId,sent.linkId);
  assert.throws(()=>request(mohamed,'people.accept',{linkId:sent.linkId,code:sent.code,confirmed:true}),/unavailable/);
  assert.throws(()=>request(sara,'people.accept',{linkId:sent.linkId,code:'00000000',confirmed:true}),/code_changed/);
  assert.throws(()=>request(sara,'people.request',{publicId:mine.publicId}),/request_waiting/);
  now+=P.CODE_WINDOW_MS*2;
  const fresh=request(sara,'people.requests').incoming[0].code;
  assert.notEqual(fresh,sent.code);
  assert.throws(()=>request(sara,'people.accept',{linkId:sent.linkId,code:sent.code,confirmed:true}),/code_changed/);
  const done=request(sara,'people.accept',{linkId:sent.linkId,code:fresh,confirmed:true});
  assert.equal(done.linked,true);assert.equal(done.person.publicId,mine.publicId);
  assert.throws(()=>request(mohamed,'people.request',{publicId:hers.publicId}),/linked/);
});

test('linked people see only each other\'s approved computers (public keys), nothing else',()=>{
  const list=request(mohamed,'people.list');
  assert.equal(list.people.length,1);
  const sara1=list.people[0];
  assert.equal(sara1.person.nickname,'sara.dev');
  assert.equal(sara1.computers.length,1,'the pending laptop is not shared');
  assert.deepEqual(Object.keys(sara1.computers[0]).sort(),['deviceId','label','osFamily','presence','publicKey','viaGoogle']);
  assert.equal(request(sara,'people.list').people[0].person.publicId,mine.publicId);
  assert.equal(request(ali,'people.list').people.length,0);
});

test('requests expire after 15 minutes; decline with block hides you from that person',async()=>{
  const r=request(ali,'people.request',{publicId:hers.publicId});
  now+=P.REQUEST_LIFETIME_MS+1;await again();
  assert.equal(request(sara,'people.requests').incoming.length,0);
  assert.throws(()=>request(sara,'people.accept',{linkId:r.linkId,code:'12345678',confirmed:true}),/unavailable|input/);
  const second=request(ali,'people.request',{publicId:hers.publicId});
  assert.equal(request(sara,'people.decline',{linkId:second.linkId,block:true}).blocked,true);
  assert.equal(request(ali,'people.find',{query:'sara.dev'}).found,false);
  assert.throws(()=>request(ali,'people.request',{publicId:hers.publicId}),/unavailable/);
  const blocked=request(sara,'people.list').blocked;
  assert.equal(blocked.length,1);
  assert.throws(()=>request(ali,'people.remove',{linkId:blocked[0].linkId,confirmed:true}),/unavailable/);
  request(sara,'people.remove',{linkId:blocked[0].linkId,confirmed:true});
  assert.equal(request(ali,'people.find',{query:'sara.dev'}).found,true);
});

test('either person can remove the link; a stranger cannot touch it',()=>{
  const link=request(sara,'people.list').people[0].linkId;
  assert.throws(()=>request(ali,'people.remove',{linkId:link,confirmed:true}),/unavailable/);
  assert.throws(()=>request(sara,'people.remove',{linkId:link,confirmed:false}),/input/);
  request(sara,'people.remove',{linkId:link,confirmed:true});
  assert.equal(request(mohamed,'people.list').people.length,0);
});

test('deleting an account removes its ID, nickname and links; the database has no content columns',()=>{
  request(mohamed,'people.request',{publicId:alis.publicId});
  request(ali,'account.delete',{confirmation:'DELETE MY DPRO ACCOUNT'});
  assert.equal(store.one('SELECT COUNT(*) n FROM people_links').n,0);
  assert.equal(store.one('SELECT COUNT(*) n FROM people_profiles WHERE public_id=?',alis.publicId).n,0);
  const columns=[...store.all('PRAGMA table_info(people_links)'),...store.all('PRAGMA table_info(people_profiles)')].map(c=>c.name);
  for(const name of columns)assert.ok(!/task|message|content|file|memory/.test(name),name);
});

test('the code is the same for both sides in one window and differs across windows',()=>{
  const seed=C.opaque();
  assert.equal(P.peopleCode(seed,10),P.peopleCode(seed,10));
  assert.notEqual(P.peopleCode(seed,10),P.peopleCode(seed,11));
  assert.notEqual(P.peopleCode(seed,10),P.peopleCode(C.opaque(),10));
});

test('a computer added by Google sign-in alone is shared with people only after its owner confirms it',async()=>{
  const added=peer(),r=await login(added,'1001',{addByGoogle:true}),first=request(mohamed,'account.view').deviceId,key=publicKeyText(added.key.publicKey),firstKey=publicKeyText(mohamed.key.publicKey);
  assert.equal(store.one('SELECT approved_via v FROM devices WHERE id=?',r.view.deviceId).v,'google');
  assert.throws(()=>request(added,'device.confirm',{deviceId:first,publicKey:firstKey,confirmed:true}),/unconfirmed/,'an unconfirmed computer cannot vouch for others');
  assert.throws(()=>request(mohamed,'device.confirm',{deviceId:r.view.deviceId,publicKey:key,confirmed:false}),/input/);
  assert.throws(()=>request(mohamed,'device.confirm',{deviceId:r.view.deviceId,publicKey:firstKey,confirmed:true}),/key_changed/,'only the compared key');
  assert.deepEqual(request(mohamed,'device.confirm',{deviceId:r.view.deviceId,publicKey:key,confirmed:true}),{confirmed:true});
  assert.equal(store.one('SELECT approved_via v FROM devices WHERE id=?',r.view.deviceId).v,'kept');
  assert.deepEqual(request(mohamed,'device.confirm',{deviceId:r.view.deviceId,publicKey:key,confirmed:true}),{confirmed:false},'already confirmed');
  assert.throws(()=>request(sara,'device.confirm',{deviceId:r.view.deviceId,publicKey:key,confirmed:true}),/unavailable/,'never across accounts');
});
