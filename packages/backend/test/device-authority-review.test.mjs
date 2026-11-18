import test from 'node:test';
import assert from 'node:assert/strict';
import {createIdentity,publicKeyText,signCommand} from '../src/phone/protocol/e2e.ts';
import {createConfiguredComputerAuthority} from '../src/devices/authority.ts';
import {createSyntheticAuthority} from '../src/devices/synthetic-authority.ts';
import {ComputerMembership} from '../src/devices/membership.ts';
import {userActor} from '../src/repositories/actor.ts';
const fixture=()=>{const local=createIdentity(),peer=createIdentity(),signer=createIdentity();let anchor={generation:0,sequence:0},race=false,clock=0;const document={version:1,workspace:'review',owner:{issuer:'https://identity.example.test',subject:'owner'},generation:1,expiresAt:Date.now()+90000,devices:[local,peer].map(i=>({id:i.id,publicKey:publicKeyText(i.publicKey)})),links:[{devices:[local.id,peer.id],epoch:1,revoked:false}]};const options={ownerId:'owner',ownerIdentity:document.owner,workspace:'review',profile:'disposable',authorityPublicKey:publicKeyText(signer.publicKey),relayUrls:[],directEndpoints:[],listenInterfaces:[],custody:{identity:async()=>local,assertProtected:async()=>{},readAnchor:async()=>structuredClone(anchor),advanceAnchor:async(_p,next,expected)=>{if(race){race=false;anchor={...anchor,sequence:anchor.sequence+1};}assert.deepEqual(expected,anchor,'atomic compare-and-advance');if(next.generation<anchor.generation||next.sequence<anchor.sequence)throw Error('rollback');anchor=structuredClone(next);}},provider:{snapshot:async()=>signCommand(signer,local.id,++clock,JSON.stringify(document)),revoke:async()=>{}}};return {local,peer,document,options,anchor:()=>anchor,write:v=>anchor=v,race:()=>race=true};};
test('signed membership rejects malformed dates and local custody identity mismatch',async()=>{
 for(const expiry of [null,'tomorrow',String(Date.now()+60000),NaN,[],{},-1,Number.MAX_SAFE_INTEGER+1]){const f=fixture();f.document.expiresAt=expiry;await assert.rejects(()=>createConfiguredComputerAuthority(f.options));}
 const f=fixture();f.options.custody.identity=async()=>({...f.local,privateKey:f.peer.privateKey});await assert.rejects(()=>createConfiguredComputerAuthority(f.options),/custody_identity_mismatch/);
 const other=fixture();other.document.devices[0].publicKey=publicKeyText(other.peer.publicKey);await assert.rejects(()=>createConfiguredComputerAuthority(other.options));
});
test('checkpoints validate safe nonnegative monotonic values without relying on provider validation',async()=>{
 for(const value of [-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1]){const f=fixture(),a=(await createConfiguredComputerAuthority(f.options)).authority;await assert.rejects(()=>a.commitCheckpoint(value));assert.equal(a.fresh(f.local.id,f.peer.id,1),false);assert.equal(f.anchor().sequence,0);}
 const f=fixture(),a=(await createConfiguredComputerAuthority(f.options)).authority;await a.commitCheckpoint(5);await assert.rejects(()=>a.commitCheckpoint(4));assert.equal(f.anchor().sequence,5);assert.equal(a.freshCheckpoint(f.local.id,NaN),false);assert.throws(()=>a.observeCheckpoint(f.local.id,-1));
});
test('external anchor advancement, rollback and compare races close cached authority',async()=>{
 const f=fixture(),a=(await createConfiguredComputerAuthority(f.options)).authority;f.write({...f.anchor(),generation:2});await assert.rejects(()=>a.assertReady());assert.equal(a.fresh(f.local.id,f.peer.id,1),false);await assert.rejects(()=>a.refresh());
 const r=fixture(),b=(await createConfiguredComputerAuthority(r.options)).authority;await b.commitCheckpoint(8);r.write({...r.anchor(),sequence:7});await assert.rejects(()=>b.refresh());assert.equal(b.fresh(r.local.id,r.peer.id,1),false);
 const c=fixture(),d=(await createConfiguredComputerAuthority(c.options)).authority;c.race();await assert.rejects(()=>d.commitCheckpoint(1));assert.equal(d.fresh(c.local.id,c.peer.id,1),false);
 for(const bad of [{generation:-1,sequence:0},{generation:0,sequence:NaN},{generation:1,sequence:0}]){const z=fixture();z.write(bad);await assert.rejects(()=>createConfiguredComputerAuthority(z.options));}
});
test('expired joining requests release bounded pairing slots',async()=>{
 process.env.NODE_ENV='test';const local=createIdentity(),peer=createIdentity(),authority=createSyntheticAuthority({disposable:true,ownerId:'owner',identities:[local,peer]});let now=Date.now();const repo=i=>({localId:i.id,sequence:async()=>0,runner:{read:async()=>({role:'owner',status:'active'})}});const host=new ComputerMembership(local,'owner','review',repo(local),authority,()=>now),joiner=new ComputerMembership(peer,'owner','review',repo(peer),authority,()=>now),actor=userActor({id:'owner',role:'owner'});let invite=await host.invite(actor,'ws://127.0.0.1:12345/v1');for(let i=0;i<4;i++)await joiner.join(actor,{qr:invite.qr,workspace:'review',name:'Joining computer'});await assert.rejects(()=>joiner.join(actor,{qr:invite.qr,workspace:'review',name:'Joining computer'}),/capacity/);now+=121000;invite=await host.invite(actor,'ws://127.0.0.1:12345/v1');await joiner.join(actor,{qr:invite.qr,workspace:'review',name:'Joining computer'});assert.equal(joiner.pairingStatus().joins.length,1);
});
