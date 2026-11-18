/** Private native/Node proof adapter. It never receives a path or key from a renderer or environment. */
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
const C=createRequire(import.meta.url)('../../../../identity/src/memory-native-proof.cjs');
export type NativeMemoryProofField='profile'|'genesis'|'restore'|'audit'|'graph'|'auxiliary'|'presence';
export interface NativeMemoryProofLease {readonly descriptor:any;readonly values:Readonly<Record<string,any>>;isCurrent():boolean}
export interface NativeMemoryIngressTicket {operationId:string;isCurrent():boolean;release():void|Promise<void>}
interface ClientOptions {
 bootstrap:unknown;
 /** Exact private IPC request/response; transport must bind the real child and current operation. */
 requestFresh:(request:unknown)=>Promise<unknown>;
 parkIngress:(event:any)=>Promise<NativeMemoryIngressTicket>;
 drainOperations:(event:any,ticket:NativeMemoryIngressTicket)=>Promise<{suspendedOperationId:string;activeOperations:number;openTransactions:number}>;
 resumeIngress:(event:any,ticket:NativeMemoryIngressTicket)=>Promise<void>;
 /** Must synchronously revoke only affected leases; audit-only refresh must not lock unrelated authority. */
 onRevoke:(fields:readonly NativeMemoryProofField[])=>void;
}
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export function createMemoryNativeProofClient(options:ClientOptions){
 if(!options||['requestFresh','parkIngress','drainOperations','resumeIngress','onRevoke'].some(k=>typeof (options as any)[k]!=='function'))C.unsupported();
 const boot=C.bootstrap(options.bootstrap),key=Buffer.from(boot.macKey,'base64url');if(key.length!==32||key.toString('base64url')!==boot.macKey)throw C.error();
 const binding=freeze(boot.binding),leases=new Map<string,{descriptor:any;values:any;deadline:number;revoked:boolean;enrollment?:boolean}>();
 const foundations=new Set<{initial:any;values:any;lease:NativeMemoryProofLease;revoked:boolean}>();
 let closed=false,poisoned=false,pending:{event:any;ticket:NativeMemoryIngressTicket}|null=null,highestSerial=0;
 function revoke(fields:NativeMemoryProofField[]){for(const cell of foundations)if(fields.some(f=>Object.hasOwn(cell.initial,f)))cell.revoked=true;for(const held of leases.values())if(fields.some(f=>Object.hasOwn(held.descriptor.fields,f)))held.revoked=true;const returned=(options.onRevoke as any)(Object.freeze([...fields]));if(returned&&typeof returned.then==='function')throw C.error();}
 function poison(){if(poisoned)return;poisoned=true;try{revoke(C.FIELDS);}catch{}}
 function snapshot(active=true){
  if(closed||poisoned)throw C.error();
  const capsuleBytes=C.readProtectedFile(boot.capsulePath,C.MAX_WIRE).bytes,cap=C.openSigned(capsuleBytes,key,C.capsule);
  if(!C.sameBinding(cap.binding,binding)||cap.serial<highestSerial)throw C.error();highestSerial=Math.max(highestSerial,cap.serial);
  if(active&&cap.state==='blocked')throw Error('memory_native_proof_suspended');
  if(active&&cap.state!=='active')throw C.error();
  if(cap.state==='poisoned'||cap.state==='closed'){poison();throw C.error();}
  const proofBytes=C.readProtectedFile(boot.proofPath,C.MAX_WIRE).bytes,proof=C.openSigned(proofBytes,key,C.proof);
  if(C.digest(proofBytes)!==cap.proofHash||!C.sameBinding(proof.binding,binding)||cap.state==='active'&&(proof.serial!==cap.serial||C.canonical(proof.fields)!==C.canonical(cap.fields))||C.canonical(C.fingerprintNativeFiles(boot.cipherFiles,proof.fingerprints))!==C.canonical(proof.fingerprints))throw C.error();
  return {cap,proof};
 }
 function current(held:{descriptor:any;deadline:number;revoked:boolean;enrollment?:boolean}){if(closed||poisoned||held.revoked||Date.now()>=held.descriptor.expiresAt||performance.now()>=held.deadline)return false;try{const initial=held.enrollment===true,{cap}=snapshot(!initial);if(boot.directoryProofs.length)C.verifyDirectories(boot.directoryProofs);if(initial&&cap.state!=='active'&&(cap.state!=='blocked'||cap.mutationId!==null||Object.keys(cap.fields).join()!=='profile'))return false;return Object.entries(held.descriptor.fields).every(([f,v])=>C.canonical(v)===C.canonical(cap.fields[f]));}catch(error){if(!(error instanceof Error)||error.message!=='memory_native_proof_suspended')poison();return false;}}
 function accept(raw:unknown,req:any,prior?:{descriptor:any;values:any;deadline:number;revoked:boolean;enrollment?:boolean}):NativeMemoryProofLease{
  const out=C.response(raw),d=out.descriptor,now=Date.now();if(out.requestId!==req.requestId||!C.sameBinding(d.binding,binding)||d.operationId!==req.operationId||d.issuedAt>now+1000||d.expiresAt<=now||d.expiresAt>now+C.MAX_LEASE_MS||prior&&(d.handle!==prior.descriptor.handle||C.canonical(d.fields)!==C.canonical(prior.descriptor.fields)))throw C.error();
  const wanted=req.operation==='enrollment-profile'?['profile']:req.operation==='capture'?C.fields(['profile',...req.fields.filter((f:string)=>f!=='profile')]):Object.keys(prior!.descriptor.fields);if(req.operation==='enrollment-profile'&&(!['profile-root','journal-root'].every(id=>boot.directoryProofs.some((d:any)=>d.id===id))||process.platform==='win32'))C.unsupported();
  if(C.canonical(Object.keys(d.fields).sort())!==C.canonical([...wanted].sort()))throw C.error();
  for(const [id,held]of leases)if(held.revoked||held.descriptor.expiresAt<=now||performance.now()>=held.deadline)leases.delete(id);
  const held={descriptor:freeze(d),values:freeze(out.values),deadline:performance.now()+Math.min(C.MAX_LEASE_MS,d.expiresAt-now),revoked:false,enrollment:req.operation==='enrollment-profile'};leases.set(d.handle,held);if(leases.size>256){leases.delete(d.handle);throw C.error();}if(!current(held)){leases.delete(d.handle);throw C.error();}
  return Object.freeze({descriptor:held.descriptor,values:held.values,isCurrent:()=>current(held)});
 }
 async function call(req:any,prior?:{descriptor:any;values:any;deadline:number;revoked:boolean;enrollment?:boolean}){if(closed||poisoned||pending)throw C.error();const normalized=C.request(req);const out=await options.requestFresh(normalized);if(closed||poisoned||pending)throw C.error();return accept(out,normalized,prior);}
 return Object.freeze({
  binding,
  captureEnrollmentProfile(operationId:string):Promise<NativeMemoryProofLease>{return call({v:1,type:'memory-proof-request',binding,requestId:randomBytes(32).toString('base64url'),operation:'enrollment-profile',operationId});},
  capture(fields:NativeMemoryProofField[],operationId:string):Promise<NativeMemoryProofLease>{return call({v:1,type:'memory-proof-request',binding,requestId:randomBytes(32).toString('base64url'),operation:'capture',operationId,fields});},
  async captureEnrollmentFoundation(operationId:string):Promise<NativeMemoryProofLease>{
   for(const cell of foundations)if(cell.revoked)foundations.delete(cell);if(foundations.size>=16)throw C.error();const lease=await call({v:1,type:'memory-proof-request',binding,requestId:randomBytes(32).toString('base64url'),operation:'enrollment-profile',operationId});
   const cell={initial:lease.descriptor.fields,values:lease.values,lease,revoked:false};foundations.add(cell);return Object.freeze({get descriptor(){return cell.lease.descriptor;},values:cell.values,isCurrent:()=>!cell.revoked&&cell.lease.isCurrent()});
  },
  async captureFoundation(fields:NativeMemoryProofField[],operationId:string):Promise<NativeMemoryProofLease>{
   for(const cell of foundations)if(cell.revoked)foundations.delete(cell);if(foundations.size>=16)throw C.error();const lease=await call({v:1,type:'memory-proof-request',binding,requestId:randomBytes(32).toString('base64url'),operation:'capture',operationId,fields});
   const cell={initial:lease.descriptor.fields,values:lease.values,lease,revoked:false};foundations.add(cell);
   return Object.freeze({get descriptor(){return cell.lease.descriptor;},values:cell.values,isCurrent:()=>!cell.revoked&&cell.lease.isCurrent()});
  },
  /** Must run under each NEW genuine coordinator operation before any session-current check. */
  async refreshFoundations(operationId:string):Promise<void>{
   if(closed||poisoned||pending)throw C.error();const updates:Array<{cell:any;lease:NativeMemoryProofLease}>=[];
   for(const cell of foundations){if(cell.revoked)continue;const fields=Object.keys(cell.initial) as NativeMemoryProofField[];
    const lease=await call({v:1,type:'memory-proof-request',binding,requestId:randomBytes(32).toString('base64url'),operation:'capture',operationId,fields});
    if(C.canonical(lease.descriptor.fields)!==C.canonical(cell.initial)||C.canonical(lease.values)!==C.canonical(cell.values)){cell.revoked=true;revoke(fields);throw C.error();}updates.push({cell,lease});
   }
   for(const update of updates)update.cell.lease=update.lease;
  },
  /** Before authentication only already enrolled profile/genesis metadata can be renewed. No user/session is invented. */
  async refreshFoundationFields(fields:readonly NativeMemoryProofField[],operationId:string):Promise<void>{
   const permitted=C.fields([...fields]);if(permitted.some((field:string)=>!['profile','genesis'].includes(field))||closed||poisoned||pending)C.unsupported();const updates:Array<{cell:any;lease:NativeMemoryProofLease}>=[];
   for(const cell of foundations){if(cell.revoked)continue;const wanted=Object.keys(cell.initial) as NativeMemoryProofField[];if(wanted.some(field=>!permitted.includes(field)))continue;const lease=await call({v:1,type:'memory-proof-request',binding,requestId:randomBytes(32).toString('base64url'),operation:'capture',operationId,fields:wanted});if(C.canonical(lease.descriptor.fields)!==C.canonical(cell.initial)||C.canonical(lease.values)!==C.canonical(cell.values)){cell.revoked=true;revoke(wanted);throw C.error();}updates.push({cell,lease});}for(const update of updates)update.cell.lease=update.lease;
  },
  async fresh(lease:NativeMemoryProofLease,operationId:string):Promise<NativeMemoryProofLease>{const d=C.descriptor(lease?.descriptor),held=leases.get(d.handle);if(!held||held.revoked||!current(held)||held.descriptor.operationId!==operationId)throw C.error();return call({v:1,type:'memory-proof-request',binding,requestId:randomBytes(32).toString('base64url'),operation:'fresh',operationId,handle:d.handle},held);},
  /** Sender identity is enforced by the private transport before this method is called. */
  async handleInvalidation(raw:unknown){
   if(closed||poisoned||pending)throw C.error();const event=C.invalidation(raw);if(!C.sameBinding(event.binding,binding))throw C.error();
   let ticket:NativeMemoryIngressTicket|undefined;
   try{ticket=await options.parkIngress(event);if(!ticket||ticket.operationId!==event.operationId||typeof ticket.isCurrent!=='function'||typeof ticket.release!=='function'||ticket.isCurrent()!==true)C.unsupported();const {cap}=snapshot(false);if(cap.state!=='blocked'||cap.mutationId!==event.mutationId||cap.serial!==event.serial)throw C.error();
    pending={event,ticket};revoke(event.changedFields);const drained=await options.drainOperations(event,ticket);C.exact(drained,['suspendedOperationId','activeOperations','openTransactions']);if(!ticket.isCurrent()||closed||poisoned)throw C.error();
    return C.ack({v:1,type:'memory-proof-drained',binding,mutationId:event.mutationId,operationId:event.operationId,serial:event.serial,nonce:event.nonce,...drained});
   }catch{poison();throw C.error();}
  },
  async handleResume(raw:unknown){
   const event=C.resume(raw),held=pending;if(closed||poisoned||!held||!C.sameBinding(event.binding,binding)||event.mutationId!==held.event.mutationId||event.operationId!==held.event.operationId||event.nonce!==held.event.nonce||event.serial<=held.event.serial)throw C.error();
   try{const {cap}=snapshot();if(cap.serial!==event.serial||!held.ticket.isCurrent())throw C.error();await options.resumeIngress(event,held.ticket);if(closed||poisoned)throw C.error();pending=null;return C.resumed({...event,type:'memory-proof-resumed'});}catch{poison();throw C.error();}
  },
  /** One-shot acceptance metadata may bind all actual signed ciphertext fingerprints. It is not an authority lease. */
  bindAggregate(lease:NativeMemoryProofLease){const d=C.descriptor(lease?.descriptor),held=leases.get(d.handle);if(!held||!lease.isCurrent())throw C.error();const expected=snapshot().cap.proofHash;return Object.freeze({isCurrent:()=>{try{return lease.isCurrent()&&snapshot().cap.proofHash===expected;}catch{return false;}}});},
  /** Exposes only an active registered private proof; never bypasses a suspension. */
  descriptorOf(lease:NativeMemoryProofLease){const held=leases.get(C.descriptor(lease?.descriptor).handle);if(!held||!current(held))throw C.error();return held.descriptor;},
  close(){if(closed)return;closed=true;try{revoke(C.FIELDS);}finally{key.fill(0);leases.clear();foundations.clear();}},
 });
}
