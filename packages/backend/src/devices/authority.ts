/** Server-provisioned authority interfaces. No account login, environment flag or remote packet configures them. */
import {createPublicKey} from 'node:crypto';
import type {Actor} from '../repositories/actor.js';
import {isOwner} from '../repositories/scope.js';
import {CommandVerifier,peerKey,publicKeyText,type Identity,type SignedCommand} from '../phone/protocol/e2e.js';
import {fingerprint} from './contracts.js';
export interface ComputerAuthority {
 assertPeerFresh?:(publicKey:string,epoch:number)=>Promise<void>;
 assertExecutionFresh?:(peerId:string,epoch:number)=>Promise<void>;
 readonly testOnly:boolean;
 owner(actor:Actor):void;
 identity(id:string,owner:string):boolean;
 epoch(a:string,b:string):number;
 revoke(a:string,b:string):void;
 fresh(a:string,b:string,epoch:number):boolean;
 observeCheckpoint(id:string,sequence:number):void;
 freshCheckpoint(id:string,sequence:number):boolean;
 refresh?():Promise<void>;
 commitCheckpoint?(sequence:number):Promise<void>;
 revokePeer?(actor:Actor,self:string,peer:string,epoch:number):Promise<void>;
 assertReady?():Promise<void>;
 permitRelay?(url:string):boolean;
 permitDirect?(url:string):boolean;
 permitListen?(host:string,port:number):boolean;
}
export interface CustodyAnchor {generation:number;sequence:number;membershipHash?:string}
export interface DeviceCustody {
 /** Identity is local and nonexportable to UI/peers; implementation may use an OS keystore. */
 identity():Promise<Identity>;
 /** Must attest encrypted storage and restore/cross-process generation fencing for these exact tables. */
 assertProtected(profile:string,tables:readonly string[]):Promise<void>;
 readAnchor(profile:string):Promise<{generation:number;sequence:number;membershipHash?:string}>;
 /** Atomically compare the complete durable expected anchor and advance; refuse races and every rollback. */
 advanceAnchor(profile:string,next:CustodyAnchor,expected:CustodyAnchor):Promise<void>;
}
export interface MembershipAuthorityProvider {
 /** A fresh authority-signed document addressed to this device, not an email/login assertion. */
 snapshot(localDeviceId:string):Promise<SignedCommand>;
 /** Revocation changes authority epoch durably; unavailable authority closes every effect gate. */
 revoke(localDeviceId:string,peerId:string,expectedEpoch:number):Promise<void>;
}
export interface MembershipDocument {
 version:1;workspace:string;owner:{issuer:string;subject:string};generation:number;expiresAt:number;
 devices:{id:string;publicKey:string}[];
 links:{devices:[string,string];epoch:number;revoked:boolean}[];
}
export interface ConfiguredAuthorityOptions {
 assertPeerFresh?:(publicKey:string,epoch:number)=>Promise<void>;
 assertExecutionFresh?:(peerId:string,epoch:number)=>Promise<void>;
 disposableLoopbackTransport?:true;
 ownerId:string;ownerIdentity:{issuer:string;subject:string};workspace:string;profile:string;
 authorityPublicKey:string;custody:DeviceCustody;provider:MembershipAuthorityProvider;
 relayUrls:readonly string[];directEndpoints:readonly string[];listenInterfaces:readonly {host:string;port:number}[];
}
const configured=new WeakSet<object>();
export const isConfiguredComputerAuthority=(a:ComputerAuthority)=>configured.has(a);
export async function createConfiguredComputerAuthority(options:ConfiguredAuthorityOptions){
 if(options.disposableLoopbackTransport&&process.env.NODE_ENV!=='test')throw Error('synthetic_computer_test_only');
 if(!options.ownerIdentity.issuer.startsWith('https://')||!options.ownerIdentity.subject||!options.ownerId||!options.workspace||!options.profile)throw Error('computer_identity_configuration_required');
 const identity=await options.custody.identity();const localPublicKey=publicKeyText(identity.publicKey);peerKey(localPublicKey,identity.id);
 if(publicKeyText(createPublicKey(identity.privateKey))!==localPublicKey)throw Error('computer_custody_identity_mismatch');
 const validAnchor=(raw:CustodyAnchor):CustodyAnchor=>{if(!raw||Object.keys(raw).some(k=>!['generation','sequence','membershipHash'].includes(k))||!Number.isSafeInteger(raw.generation)||raw.generation<0||!Number.isSafeInteger(raw.sequence)||raw.sequence<0||raw.membershipHash!==undefined&&!/^[a-f0-9]{64}$/.test(raw.membershipHash)||raw.generation>0&&!raw.membershipHash)throw Error('computer_restore_anchor_invalid');return {...raw};};
 let document:MembershipDocument|null=null,anchor=validAnchor(await options.custody.readAnchor(options.profile)),ready=false,observed=anchor.sequence,tail:Promise<void>=Promise.resolve();
 const exclusive=<T>(work:()=>Promise<T>):Promise<T>=>{const next=tail.then(work);tail=next.then(()=>undefined,()=>undefined);return next.catch(error=>{ready=false;throw error;});};
 const readAnchor=async()=>{const next=validAnchor(await options.custody.readAnchor(options.profile));if(next.generation<anchor.generation||next.sequence<anchor.sequence||next.generation===anchor.generation&&next.membershipHash!==anchor.membershipHash)throw Error('computer_restore_anchor_regressed');anchor=next;return {...next};};
 const advance=async(next:CustodyAnchor)=>{const expected={...anchor};await options.custody.advanceAnchor(options.profile,validAnchor(next),expected);const actual=validAnchor(await options.custody.readAnchor(options.profile));if(fingerprint(actual)!==fingerprint(next))throw Error('computer_restore_anchor_raced');anchor=actual;};
 const pair=(a:string,b:string)=>[a,b].sort().join(':');
 const current=()=>{if(!ready||!document||document.expiresAt<=Date.now()||document.generation!==anchor.generation)throw Error('computer_authority_unavailable');return document;};
 const link=(a:string,b:string)=>current().links.find(l=>pair(...l.devices)===pair(a,b));
 const authority:ComputerAuthority={testOnly:false,assertPeerFresh:options.assertPeerFresh,assertExecutionFresh:options.assertExecutionFresh,
  owner(actor){if(!isOwner(actor)||actor.kind!=='user'||actor.userId!==options.ownerId||actor.channel)throw Error('computer_owner_required');current();},
  identity(id,owner){return owner===options.ownerId&&current().devices.some(d=>d.id===id);},
  epoch(a,b){const l=link(a,b);if(!l||l.revoked)throw Error('computer_membership_stale');return l.epoch;},
  revoke(){ready=false;throw Error('computer_revocation_requires_authority');},
  fresh(a,b,e){try{const l=link(a,b);return !!l&&!l.revoked&&l.epoch===e;}catch{return false;}},
  observeCheckpoint(id,sequence){if(id!==identity.id||!Number.isSafeInteger(sequence)||sequence<0||sequence<Math.max(anchor.sequence,observed))throw Error('computer_restore_freshness_unknown');observed=sequence;},
  freshCheckpoint(id,sequence){try{return id===identity.id&&Number.isSafeInteger(sequence)&&sequence>=Math.max(anchor.sequence,observed)&&current().generation>=anchor.generation;}catch{return false;}},
  assertReady(){return exclusive(async()=>{await options.custody.assertProtected(options.profile,['computer_peers','computer_delivery','computer_attempts','computer_counters','computer_direct_endpoints','computer_sync_records','computer_sync_bindings','computer_execution_leases','computer_sync_selections','computer_sync_effect_locks','workspace_control_operations']);await readAnchor();current();});},
  refresh(){return exclusive(async()=>{try{await readAnchor();await options.custody.assertProtected(options.profile,['computer_peers','computer_delivery','computer_attempts','computer_sync_records']);const signed=await options.provider.snapshot(identity.id),verifier=new CommandVerifier(identity.id);verifier.addDevice(peerKey(options.authorityPublicKey),{lifetimeDays:null});const checked=verifier.verify(signed);if(!checked.ok)throw Error('computer_membership_signature_invalid');if(Buffer.byteLength(checked.body)>64000)throw Error('computer_membership_document_invalid');const value=JSON.parse(checked.body) as MembershipDocument;
   if(!value||Object.keys(value).some(k=>!['version','workspace','owner','generation','expiresAt','devices','links'].includes(k))||value.version!==1||value.workspace!==options.workspace||Object.keys(value.owner??{}).sort().join(',')!=='issuer,subject'||value.owner?.issuer!==options.ownerIdentity.issuer||value.owner.subject!==options.ownerIdentity.subject||!Number.isSafeInteger(value.generation)||value.generation<1||value.generation<anchor.generation||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=Date.now()||value.expiresAt>Date.now()+120000||!Array.isArray(value.devices)||value.devices.length>64||!Array.isArray(value.links)||value.links.length>2016)throw Error('computer_membership_document_invalid');
   const ids=new Set<string>();for(const d of value.devices){if(Object.keys(d).sort().join(',')!=='id,publicKey'||ids.has(d.id))throw Error('computer_membership_document_invalid');peerKey(d.publicKey,d.id);ids.add(d.id);}if(!ids.has(identity.id))throw Error('computer_local_membership_missing');if(value.devices.find(d=>d.id===identity.id)!.publicKey!==localPublicKey)throw Error('computer_custody_identity_mismatch');const links=new Set<string>();for(const l of value.links){if(Object.keys(l).sort().join(',')!=='devices,epoch,revoked'||!Array.isArray(l.devices)||l.devices.length!==2||l.devices[0]===l.devices[1]||!l.devices.every(d=>ids.has(d))||!Number.isSafeInteger(l.epoch)||l.epoch<1||typeof l.revoked!=='boolean'||links.has(pair(...l.devices)))throw Error('computer_membership_document_invalid');links.add(pair(...l.devices));}
   const documentHash=fingerprint({version:value.version,workspace:value.workspace,owner:value.owner,generation:value.generation,devices:[...value.devices].sort((a,b)=>a.id.localeCompare(b.id)),links:[...value.links].map(l=>({...l,devices:[...l.devices].sort()})).sort((a,b)=>a.devices.join(':').localeCompare(b.devices.join(':')))});if(value.generation===anchor.generation&&anchor.membershipHash&&anchor.membershipHash!==documentHash)throw Error('computer_membership_generation_changed');await readAnchor();if(value.generation<anchor.generation||value.generation===anchor.generation&&anchor.membershipHash&&anchor.membershipHash!==documentHash)throw Error('computer_membership_generation_changed');await advance({generation:value.generation,sequence:anchor.sequence,membershipHash:documentHash});document=value;ready=true;}catch(error){ready=false;throw error;}});
  },
  commitCheckpoint(sequence){return exclusive(async()=>{if(!Number.isSafeInteger(sequence)||sequence<0||sequence<observed)throw Error('computer_restore_freshness_unknown');await readAnchor();current();if(sequence<anchor.sequence)throw Error('computer_restore_freshness_unknown');await advance({generation:document!.generation,sequence,membershipHash:anchor.membershipHash});observed=sequence;});},
  async revokePeer(actor,self,peer,epoch){authority.owner(actor);if(self!==identity.id||authority.epoch(self,peer)!==epoch)throw Error('computer_membership_stale');const generation=current().generation;ready=false;await options.provider.revoke(self,peer,epoch);await authority.refresh!();const changed=link(self,peer);if(current().generation<=generation||changed&&!changed.revoked&&changed.epoch<=epoch){ready=false;throw Error('computer_revocation_not_confirmed');}},
  permitRelay:url=>options.relayUrls.includes(url)&&(new URL(url).protocol==='wss:'||options.disposableLoopbackTransport===true&&process.env.NODE_ENV==='test'&&new URL(url).protocol==='ws:'&&new URL(url).hostname==='127.0.0.1'),
  permitDirect:url=>options.directEndpoints.includes(url),
  permitListen:(host,port)=>options.listenInterfaces.some(i=>i.host===host&&i.port===port),
 };
 await authority.refresh!();await authority.assertReady!();configured.add(authority);
 return {identity,authority,revoke:async(actor:Actor,peer:string)=>{await authority.revokePeer!(actor,identity.id,peer,authority.epoch(identity.id,peer));},checkpoint:async()=>{await authority.assertReady!();},state:()=>({configured:ready,workspace:options.workspace,generation:document?.generation??null,authorityFingerprint:fingerprint(options.authorityPublicKey)})};
}
/** Recovery is an authority-epoch operation; a restored profile never self-issues authority. */
export interface ComputerRecoveryProvider {prepare(input:{owner:Actor;lostDeviceIds:string[];expectedGeneration:number}):Promise<{reviewId:string;fingerprint:string;expiresAt:number}>;complete(input:{owner:Actor;reviewId:string;fingerprint:string;ownerProof:unknown}):Promise<void>}
export const MEMORY_SYNC_GATE=Object.freeze({enabled:false,required:['accepted ENC activation','V3-6 scope/privacy contract','durable forget ledger','restore key epochs','explicit owner resume']});
