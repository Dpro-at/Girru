/** Shared g1 sessions over the existing outbound connector and opt-in LAN listener. */
import {deviceIdOf} from '../phone/protocol/encoding.js';
import type {Actor} from '../repositories/actor.js';
import {RelayConnector,type RelayState} from '../phone/relay-connector.js';
import {LanListener} from '../phone/lan-listener.js';
import {signCommand,CommandVerifier,startHandshake,answerHandshake,finishHandshake,seal,open,peerKey,type Session,type PendingHandshake} from '../phone/protocol/e2e.js';
import {readEnvelope,canonical,fingerprint,type Envelope} from './contracts.js';
import type {ComputerMembership} from './membership.js';

type Path='relay'|'direct';
type Route={key:string;path:Path;send:(peer:string,env:string)=>boolean};
type Direct={url:string;binding:string;openedAt:number;connector:RelayConnector};
const DIRECT_GRACE_MS=350;
const DIRECT_ACK_MS=600;
const HANDSHAKE_MS=700;
export class ComputerTransport {
 readonly connector:RelayConnector;
 private direct=new Map<string,Direct>();
 private listener:LanListener|null=null;
 private listenerPeers=new Map<string,{epoch:number;expires:number}>();
 private seenHellos=new Map<string,number>();
 private sessions=new Map<string,Session>();
 private handshakes=new Map<string,{pending:PendingHandshake;at:number}>();
 private verifiers=new Map<string,CommandVerifier>();
 private deliveries=new Map<string,{peer:string;at:number;fallback:boolean}>();
 private lastPaths=new Map<string,Path>();
 private counts={direct:0,relay:0};
 private transmissions=new Map<string,Set<Path>>();
 pathsFor(eventId:string){return [...(this.transmissions.get(eventId)??[])];}
 private inbound:Promise<void>=Promise.resolve();
 private outbound:Promise<unknown>=Promise.resolve();private controlOutbound:Promise<unknown>=Promise.resolve();private signing:Promise<unknown>=Promise.resolve();private applicationInbound:Promise<unknown>=Promise.resolve();
 private error:string|null=null;
 private wanted=false;private generation=0;
 constructor(public membership:ComputerMembership,url:string,private receive:(e:Envelope)=>Promise<void>,private state?:(s:RelayState)=>void,private nextOuterCounter?:()=>Promise<number>){
  const endpoint=new URL(url);
  if(membership.authority.testOnly?(endpoint.protocol!=='ws:'||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)):membership.authority.permitRelay?.(url)!==true)throw Error('computer_relay_not_approved');
  this.connector=new RelayConnector({identity:membership.identity,url,onFrame:f=>this.enqueue(f,this.relayRoute()),onState:s=>{if(s!=='connected')this.clearRoute('relay');this.state?.(s);}});
 }
 private controlPeers=new Map<string,string>();
 pinControlPeer(publicKey:string){const key=peerKey(publicKey),device=deviceIdOf(key);if(this.controlPeers.size>=64&&!this.controlPeers.has(device))throw Error('computer_control_capacity');this.controlPeers.set(device,publicKey);void this.refreshPeers().catch(()=>{this.error='computer_control_allow_refresh_failed';});return device;}
 private controlReceiver:((peer:string,body:Record<string,unknown>)=>Promise<void>)|null=null;
 onControl(receiver:(peer:string,body:Record<string,unknown>)=>Promise<void>){this.controlReceiver=receiver;}
 adoptMembership(membership:ComputerMembership,receive:(e:Envelope)=>Promise<void>){if(membership.identity.id!==this.membership.identity.id)throw Error('computer_transport_identity_changed');this.generation++;this.sessions.clear();this.handshakes.clear();this.verifiers.clear();this.membership=membership;this.receive=receive;}
 private signedSend(route:Route,peer:string,session:Session,text:string):Promise<boolean>{const work=this.signing.then(async()=>{const counter=await (this.nextOuterCounter?.()??this.membership.nextSequence()),signed=signCommand(this.membership.identity,peer,counter,text);return route.send(peer,seal(session,JSON.stringify(signed)));});this.signing=work.catch(()=>undefined);return work;}
 sendControl(peer:string,body:Record<string,unknown>):Promise<boolean>{const next=this.controlOutbound.then(async()=>{if(!this.controlPeers.has(peer))throw Error('computer_control_peer_not_pinned');const route=this.relayRoute(),key=route.key+'|'+peer;if(!this.sessions.has(key)){await this.connectOn(peer,route);return false;}const text=canonical({protocol:'girru-computer-control',version:1,body});if(Buffer.byteLength(text)>64000)throw Error('computer_control_bound');return this.signedSend(route,peer,this.sessions.get(key)!,text);});this.controlOutbound=next.catch(()=>undefined);return next;}
 setStateReceiver(receiver:(state:RelayState)=>void){this.state=receiver;}
 get lastError(){return this.error;}
 get statistics(){return {...this.counts};}
 path(peer:string):Path|'waiting'{const path=this.lastPaths.get(peer);if(path==='direct'&&!this.direct.get(peer)?.connector.isReady&&!this.listener?.isConnected(peer))return 'waiting';return path??'waiting';}
 hasDirectConnection(){return [...this.direct.values()].some(d=>d.connector.isReady)||[...this.listenerPeers.keys()].some(id=>this.listener?.isConnected(id));}
 private relayRoute():Route{return {key:'relay',path:'relay',send:(p,e)=>this.connector.send(p,e)};}
 private incomingRoute(peer:string):Route{return {key:'in:'+peer,path:'direct',send:(p,e)=>p===peer&&!!this.listener?.send(p,e)};}
 private outgoingRoute(peer:string,d:Direct):Route{return {key:'out:'+peer,path:'direct',send:(p,e)=>p===peer&&d.connector.send(p,e)};}
 private clearRoute(route:string){for(const key of this.sessions.keys())if(key.startsWith(route+'|')){this.sessions.delete(key);this.verifiers.delete(key);}for(const key of this.handshakes.keys())if(key.startsWith(route+'|'))this.handshakes.delete(key);}
 private enqueue(frame:Record<string,unknown>,route:Route){const generation=this.generation;this.inbound=this.inbound.then(()=>{if(!this.wanted||generation!==this.generation)return;return this.frame(frame,route);}).catch(error=>{this.error=/^computer_[a-z_]+$/.test(error?.message??'')?error.message:'computer_frame_refused';});}
 async pairingTick(){await this.refreshPeers();for(const p of this.membership.pendingJoinFrames())this.connector.sendPairing(p.pairingId,p.env);}
 async start(){const generation=this.generation;this.wanted=true;await this.refreshPeers();if(!this.wanted||generation!==this.generation)return;this.connector.want(true);}
 private async refreshPeers(){const peers=await this.membership.repo.peers(),allowed=peers.filter(p=>!p.revoked&&this.membership.authority.fresh(p.local_device_id,p.peer_id,Number(p.epoch)));this.listenerPeers.clear();for(const peer of allowed){const endpoint=await this.membership.direct(peer.peer_id);if(endpoint)this.listenerPeers.set(peer.peer_id,{epoch:Number(peer.epoch),expires:Number(endpoint.expires_at)});}this.connector.setAllow([...allowed.map(p=>p.peer_id),...this.membership.joiningHosts(),...this.controlPeers.keys()]);this.connector.setPairings(this.membership.pairingMailboxes());this.listener?.recheck();}
 /** Test-only explicit owner consent. There is no product setting or physical-interface argument. */
 async enableSyntheticDirect(actor:Actor){if(!this.membership.authority.testOnly)throw Error('synthetic_computer_test_only');return this.enableDirect(actor,{host:'127.0.0.1',port:0});}
 async enableDirect(actor:Actor,bind:{host:string;port:number}){await this.membership.assertOwner(actor);if(this.membership.authority.testOnly?(process.env.NODE_ENV!=='test'||bind.host!=='127.0.0.1'||bind.port!==0):this.membership.authority.permitListen?.(bind.host,bind.port)!==true)throw Error('computer_interface_not_approved');await this.membership.authority.assertReady?.();if(this.listener)return this.listener.address;await this.refreshPeers();const listener=new LanListener({host:bind.host,port:bind.port,selfId:this.membership.identity.id,admit:id=>{const record=this.listenerPeers.get(id);return !!record&&record.expires>Date.now()&&this.membership.authority.fresh(this.membership.identity.id,id,record.epoch);},onEnvelope:e=>{if(!e.via)this.enqueue({t:'msg',from:e.from,env:e.env},this.incomingRoute(e.from));},pingMs:1000});this.listener=listener;try{await listener.listen();return listener.address;}catch(error){this.listener=null;await listener.close();throw error;}}
 async stopDirect(){const listener=this.listener;this.listener=null;for(const [peer,d]of this.direct){d.connector.stop();this.clearRoute('out:'+peer);}this.direct.clear();for(const peer of this.listenerPeers.keys())this.clearRoute('in:'+peer);if(listener)await listener.close();}
 stop(){this.wanted=false;this.generation++;this.connector.stop();void this.stopDirect();this.sessions.clear();this.handshakes.clear();this.verifiers.clear();this.deliveries.clear();this.lastPaths.clear();}
 private async directRoute(peer:string):Promise<{route:Route|null;waiting:boolean}>{
  const endpoint=await this.membership.direct(peer),old=this.direct.get(peer);
  if(old&&(!endpoint||endpoint.binding_hash!==old.binding)){old.connector.stop();this.direct.delete(peer);this.clearRoute('out:'+peer);}
  if(endpoint&&!this.direct.has(peer)&&this.wanted){
   const d:Direct={url:endpoint.endpoint_url,binding:endpoint.binding_hash,openedAt:Date.now(),connector:null as unknown as RelayConnector};
   d.connector=new RelayConnector({identity:this.membership.identity,url:d.url,baseDelayMs:100,maxDelayMs:1000,readyTimeoutMs:400,onFrame:f=>this.enqueue(f,this.outgoingRoute(peer,d)),onState:s=>{if(s!=='connected')this.clearRoute('out:'+peer);}});
   this.direct.set(peer,d);d.connector.want(true);
  }
  const outbound=this.direct.get(peer);
  if(outbound?.connector.isReady)return {route:this.outgoingRoute(peer,outbound),waiting:false};
  if(this.listener?.isConnected(peer)&&this.listenerPeers.has(peer))return {route:this.incomingRoute(peer),waiting:false};
  return {route:null,waiting:!!outbound&&Date.now()-outbound.openedAt<DIRECT_GRACE_MS};
 }
 private async connectOn(peer:string,route:Route){const key=route.key+'|'+peer;const pending=this.handshakes.get(key);if(pending&&Date.now()-pending.at>=HANDSHAKE_MS)this.handshakes.delete(key);if(this.sessions.has(key)||this.handshakes.has(key))return;const h=startHandshake(this.membership.identity,peer);this.handshakes.set(key,{pending:h.pending,at:Date.now()});if(!route.send(peer,h.env))this.handshakes.delete(key);}
 async connect(peer:string){await this.membership.current(peer);const direct=await this.directRoute(peer);await this.connectOn(peer,direct.route??this.relayRoute());}
 acknowledge(peer:string,eventId:string){if(this.deliveries.get(eventId)?.peer===peer)this.deliveries.delete(eventId);}
 send(e:Envelope):Promise<boolean>{const next=this.outbound.then(()=>this.sendOne(e));this.outbound=next.catch(()=>undefined);return next;}
 private async sendOne(e:Envelope){
  readEnvelope(e);const member=await this.membership.current(e.target);if(e.epoch!==Number(member.epoch)||e.workspace!==this.membership.workspace)throw Error('computer_membership_epoch_changed');await this.refreshPeers();if(e.sender!==this.membership.identity.id)throw Error('computer_wrong_sender');
  const direct=await this.directRoute(e.target);let delivery=this.deliveries.get(e.eventId);if(delivery&&Date.now()-delivery.at>=DIRECT_ACK_MS)delivery.fallback=true;
  // Keep probing the approved direct session while transient traffic uses the relay.
  let route=direct.route;const directAge=Date.now()-(this.direct.get(e.target)?.openedAt??Date.now());if(route&&!this.sessions.has(route.key+'|'+e.target)){await this.connectOn(e.target,route);if(directAge>=DIRECT_ACK_MS&&['presence','ack'].includes(e.kind))route=this.relayRoute();}
  if(delivery?.fallback||!route&&!direct.waiting)route=this.relayRoute();
  if(!route)return false;
  const key=route.key+'|'+e.target;
  if(!this.sessions.has(key)){
   await this.connectOn(e.target,route);
   // A ready socket with a refused or missing peer handshake cannot hold work indefinitely.
   if(route.path==='direct'&&e.kind!=='presence'&&e.kind!=='ack'){if(!delivery){delivery={peer:e.target,at:Date.now(),fallback:false};this.deliveries.set(e.eventId,delivery);}if(Date.now()-delivery.at>=DIRECT_ACK_MS){delivery.fallback=true;await this.connectOn(e.target,this.relayRoute());}}
   return false;
  }
  const text=canonical(e);
  const sent=await this.signedSend(route,e.target,this.sessions.get(key)!,text);
  if(sent){this.lastPaths.set(e.target,route.path);this.counts[route.path]++;if(!this.transmissions.has(e.eventId)){if(this.transmissions.size>=64)this.transmissions.delete(this.transmissions.keys().next().value!);this.transmissions.set(e.eventId,new Set());}this.transmissions.get(e.eventId)!.add(route.path);if(route.path==='direct'&&e.kind!=='ack'&&e.kind!=='presence'&&!delivery)this.deliveries.set(e.eventId,{peer:e.target,at:Date.now(),fallback:false});}
  else{this.clearRoute(route.key);if(route.path==='direct'){this.deliveries.set(e.eventId,{peer:e.target,at:Date.now(),fallback:true});await this.connectOn(e.target,this.relayRoute());}}
  return sent;
 }
 private verifier(key:string,peer:ReturnType<typeof peerKey>){const v=new CommandVerifier(this.membership.identity.id);v.addDevice(peer,{lifetimeDays:null});this.verifiers.set(key,v);}
 async frame(frame:Record<string,unknown>,route:Route=this.relayRoute()){
  if(frame.t==='drop'){this.clearRoute(route.key);return;}
  if(frame.t!=='msg'||typeof frame.from!=='string'||typeof frame.env!=='string')return;
  const from=frame.from;if(route.path==='relay'&&(typeof frame.via==='string'||frame.env.startsWith('g1.pchal.'))){const reply=await this.membership.pairingFrame(from,frame.env,typeof frame.via==='string'?frame.via:undefined);if(reply)this.connector.send(reply.to,reply.env);return;}if(route.path==='direct'&&route.key.split(':')[1]!==from)throw Error('computer_direct_peer_mismatch');
  if(route.path==='direct'){const endpoint=await this.membership.repo.direct(from),member=await this.membership.repo.peer(from);if(!endpoint||!member||member.revoked||endpoint.expires_at===null||Number(endpoint.expires_at)<=Date.now()||Number(endpoint.epoch)!==Number(member.epoch)||endpoint.public_key!==member.public_key)throw Error('computer_direct_consent_required');const {binding_hash,...record}=endpoint;if(fingerprint(record)!==binding_hash)throw Error('computer_direct_consent_required');}const pinned=route.path==='relay'?this.controlPeers.get(from):null,member=pinned?null:await this.membership.repo.peer(from),publicKey=peerKey(pinned??(!member?.revoked?member?.public_key:undefined)??'',from),env=frame.env,key=route.key+'|'+from;
  if(env.startsWith('g1.hs1.')){const seen=fingerprint([from,route.key,env.split('.')[2]]);for(const [id,at]of this.seenHellos)if(Date.now()-at>120000)this.seenHellos.delete(id);if(this.seenHellos.has(seen))return;if(this.handshakes.has(key)&&this.membership.identity.id<from)return;this.handshakes.delete(key);const h=answerHandshake(this.membership.identity,publicKey,env);if(this.seenHellos.size>=1024)this.seenHellos.delete(this.seenHellos.keys().next().value!);this.seenHellos.set(seen,Date.now());this.sessions.set(key,h.session);this.verifier(key,publicKey);route.send(from,h.env);return;}
  if(env.startsWith('g1.hs2.')){const pending=this.handshakes.get(key);if(!pending)throw Error('computer_unsolicited_handshake');this.sessions.set(key,finishHandshake(pending.pending,publicKey,env));this.handshakes.delete(key);this.verifier(key,publicKey);return;}
  const session=this.sessions.get(key);if(!session){await this.connectOn(from,route);return;}
  let plain:Buffer;try{plain=open(session,env);}catch(error){this.sessions.delete(key);this.verifiers.delete(key);await this.connectOn(from,route);throw error;}
  if(plain.byteLength>96000)throw Error('computer_envelope_too_large');const signed=JSON.parse(plain.toString('utf8'));if(!signed||typeof signed!=='object'||Object.keys(signed).some(k=>!['device','to','ctr','ts','nonce','body','sig'].includes(k)))throw Error('computer_signed_field');const checked=this.verifiers.get(key)?.verify(signed);if(!checked?.ok)throw Error('computer_signature_refused');const control=JSON.parse(checked.body);if(control?.protocol==='girru-computer-control'){if(control.version!==1||Object.keys(control).sort().join(',')!=='body,protocol,version'||!control.body||typeof control.body!=='object'||Array.isArray(control.body)||!this.controlReceiver)throw Error('computer_control_refused');const generation=this.generation;void Promise.resolve().then(()=>{if(!this.wanted||generation!==this.generation)throw Error('computer_transport_generation_changed');return this.controlReceiver!(from,control.body);}).catch(error=>{this.error=/^computer_[a-z_]+$/.test(error?.message??'')?error.message:'computer_control_refused';});return;}const e=readEnvelope(control);
  const executionMember=member??await this.membership.repo.peer(from);if(!executionMember||executionMember.revoked)throw Error('computer_unapproved_execution_peer');if(e.sender!==from||e.target!==this.membership.identity.id||e.workspace!==this.membership.workspace||e.epoch!==Number(executionMember.epoch))throw Error('computer_envelope_authority');
  this.lastPaths.set(from,route.path);const generation=this.generation,receive=this.receive;this.applicationInbound=this.applicationInbound.then(()=>{if(!this.wanted||generation!==this.generation)throw Error('computer_transport_generation_changed');return receive(e);}).catch(()=>{this.error='computer_application_frame_refused';});
 }
}
