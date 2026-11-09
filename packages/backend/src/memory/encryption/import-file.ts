import {assertNoProtectedDatabaseAlias,assertProtectedMemoryFileDescriptor,closeProtectedMemoryFileDescriptor} from './protected-filesystem.js';
/** Explicit trusted-host file import. No path discovery, renderer authority or plaintext staging. */
import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import {resolve,parse,join} from 'node:path';
import {createHash} from 'node:crypto';
import {TextDecoder} from 'node:util';
import type {DrawerRef} from '../drawers.js';
import {MemoryCipherError} from './envelope.js';
const MAX_BYTES=512*1024;
type MemoryFileIdentity={fileId:string;path:string;sha256:string;size:number;isCurrent:()=>boolean};
export type MemoryImportFileLease=MemoryFileIdentity&({kind?:'exclusive-path';exclusive:true}|{kind:'native-buffer'});
export type NativeMemoryBufferCapability=Readonly<{ownerId:string;profileId:string;fileId:string;sha256:string;isCurrent:()=>boolean}>;
const nativeBufferToken=Symbol('native-memory-buffer');
const nativeBuffers=new WeakMap<object,{bytes:Buffer;current:()=>boolean;identity:Omit<MemoryFileIdentity,'isCurrent'>}>();
const nativeSnapshot=(lease:MemoryImportFileLease)=>nativeBuffers.get((lease as unknown as Record<symbol,object>)[nativeBufferToken]);
/** Only the actual private native channel may validate its original response-origin handle. */
export function createNativeMemoryBufferIssuer(input:{ownerId:string;profileId:string;validateNativeCapability:(handle:object,expected:{ownerId:string;profileId:string;fileId:string;sha256:string;size:number;path:string})=>NativeMemoryBufferCapability|null}){
 const active=new Set<Buffer>(),timers=new Map<Buffer,ReturnType<typeof setTimeout>>();const release=(bytes:Buffer)=>{bytes.fill(0);active.delete(bytes);const timer=timers.get(bytes);if(timer)clearTimeout(timer);timers.delete(bytes);};let closed=false;const used=new WeakSet<object>();
 return Object.freeze({issue(request:{handle:object;fileId:string;path:string;sha256:string;bytes:Buffer}):MemoryImportFileLease{
  if(closed||active.size>=16||[...active].reduce((n,bytes)=>n+bytes.length,0)+(Buffer.isBuffer(request.bytes)?request.bytes.length:MAX_BYTES)>8*1024*1024||!request.handle||typeof request.handle!=='object'||used.has(request.handle)||typeof request.fileId!=='string'||!/^[a-f0-9]{32}$/.test(request.fileId)||typeof request.path!=='string'||request.path!==resolve(request.path)||!Buffer.isBuffer(request.bytes)||request.bytes.length<1||request.bytes.length>MAX_BYTES||createHash('sha256').update(request.bytes).digest('hex')!==request.sha256)throw new MemoryCipherError();
  const expected={ownerId:input.ownerId,profileId:input.profileId,fileId:request.fileId,path:request.path,sha256:request.sha256,size:request.bytes.length},proof=input.validateNativeCapability(request.handle,expected);
  if(!proof||proof.ownerId!==expected.ownerId||proof.profileId!==expected.profileId||proof.fileId!==expected.fileId||proof.sha256!==expected.sha256||typeof proof.isCurrent!=='function'||!proof.isCurrent())throw new MemoryCipherError();used.add(request.handle);const bytes=Buffer.from(request.bytes);active.add(bytes);const expires=Date.now()+10*60_000;const timer=setTimeout(()=>release(bytes),10*60_000);timer.unref?.();timers.set(bytes,timer);const current=()=>{try{if(!closed&&active.has(bytes)&&Date.now()<expires&&proof.isCurrent()===true)return true;}catch{}release(bytes);return false;};
  const token=Object.freeze({}),identity={fileId:request.fileId,path:request.path,sha256:request.sha256,size:bytes.length},lease={kind:'native-buffer' as const,...identity,isCurrent:current};Object.defineProperty(lease,nativeBufferToken,{enumerable:true,value:token});nativeBuffers.set(token,{bytes,current,identity});return Object.freeze(lease);
 },revoke(lease:MemoryImportFileLease){const stored=nativeSnapshot(lease);if(stored){release(stored.bytes);nativeBuffers.delete((lease as unknown as Record<symbol,object>)[nativeBufferToken]);}},close(){closed=true;for(const bytes of [...active])release(bytes);}});
}
/** The host must establish exclusive access independently; an inode/hash alone never proves it. */
export async function consumeAuthorizedMemoryFile<T>(input:{fileId:string;authorize:(fileId:string)=>Promise<MemoryImportFileLease|null>;isCurrent:()=>boolean;consume:(request:{bytes:Buffer;sourceLease:()=>boolean;sourceDigest:string})=>Promise<T>}):Promise<T>{
 let bytes:Buffer|undefined;let file:Awaited<ReturnType<typeof open>>|undefined;
 try{
  const {authorize,consume,isCurrent}=input,fileId=input.fileId;
  if(typeof fileId!=='string'||!fileId||fileId.length>256||typeof authorize!=='function'||typeof consume!=='function'||typeof isCurrent!=='function'||!isCurrent())throw new MemoryCipherError();
  const supplied=await authorize(fileId);if(!supplied)throw new MemoryCipherError();
  const lease={...supplied,isCurrent:supplied.isCurrent.bind(supplied)},current=()=>isCurrent()&&lease.isCurrent();
  if(lease.kind==='native-buffer'){
   const snapshot=nativeSnapshot(supplied);if(!snapshot||!snapshot.current()||!current()||Object.entries(snapshot.identity).some(([field,value])=>(lease as unknown as Record<string,unknown>)[field]!==value)||lease.fileId!==fileId||lease.path!==resolve(lease.path)||!Number.isSafeInteger(lease.size)||lease.size<1||lease.size>MAX_BYTES||snapshot.bytes.length!==lease.size||createHash('sha256').update(snapshot.bytes).digest('hex')!==lease.sha256)throw new MemoryCipherError();
   // This is an explicit content snapshot. Its path is display metadata only;
   // the Node backend never opens or subsequently reindexes that original path.
   bytes=Buffer.from(snapshot.bytes);const result=await consume({bytes,sourceLease:current,sourceDigest:lease.sha256});if(!snapshot.current()||!current())throw new MemoryCipherError();return result;
  }
  if(lease.fileId!==fileId||lease.exclusive!==true||typeof lease.path!=='string'||lease.path!==resolve(lease.path)||!/^[a-f0-9]{64}$/.test(lease.sha256)||!Number.isSafeInteger(lease.size)||lease.size<1||lease.size>MAX_BYTES||!current())throw new MemoryCipherError();
  // Reject linked ancestors as well as the final entry, rather than relying on final-component O_NOFOLLOW.
  const root=parse(lease.path).root;let part=root;
  for(const component of lease.path.slice(root.length).split(/[\\/]/).filter(Boolean)){
   part=join(part,component);const stat=await lstat(part);if(stat.isSymbolicLink()||!current())throw new MemoryCipherError();
   if(part!==lease.path&&!stat.isDirectory())throw new MemoryCipherError();
  }
  if(await realpath(lease.path)!==lease.path||!current()||typeof constants.O_NOFOLLOW!=='number')throw new MemoryCipherError();
  assertNoProtectedDatabaseAlias(lease.path);
  file=await open(lease.path,constants.O_RDONLY|constants.O_NOFOLLOW);assertProtectedMemoryFileDescriptor(file.fd);const before=await file.stat({bigint:true});
  if(!before.isFile()||before.nlink!==1n||before.size!==BigInt(lease.size)||!current())throw new MemoryCipherError();
  bytes=Buffer.alloc(lease.size+1);let offset=0;
  while(offset<bytes.length){if(!current())throw new MemoryCipherError();const read=await file.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)break;offset+=read.bytesRead;}
  const after=await file.stat({bigint:true}),entry=await lstat(lease.path,{bigint:true});
  const same=(a:typeof before,b:typeof before)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&b.nlink===1n;
  if(offset!==lease.size||!same(before,after)||!same(after,entry)||entry.isSymbolicLink()||!current()||createHash('sha256').update(bytes.subarray(0,offset)).digest('hex')!==lease.sha256)throw new MemoryCipherError();
  const consumedFile=file;await closeProtectedMemoryFileDescriptor(consumedFile.fd,()=>consumedFile.close());file=undefined;if(!current())throw new MemoryCipherError();
  // The consumer must recheck the live host proof inside its write transaction.
  const result=await consume({bytes:bytes.subarray(0,offset),sourceLease:current,sourceDigest:lease.sha256});
  if(!current())throw new MemoryCipherError();return result;
 }catch{throw new MemoryCipherError();}finally{bytes?.fill(0);if(file){const held=file;try{await closeProtectedMemoryFileDescriptor(held.fd,()=>held.close());}catch{}}}
}

/** Text import reuses the exact same descriptor/lease boundary as protected document indexing. */
export async function queueEncryptedOwnerFileImport(input:{fileId:string;drawer:DrawerRef;format:'markdown'|'text';authorize:(fileId:string)=>Promise<MemoryImportFileLease|null>;queue:(request:{text:string;format:'markdown'|'text';drawer:DrawerRef;sourceLease:()=>boolean;sourceDigest:string})=>Promise<{proposalId:string;count:number}>;isCurrent:()=>boolean}){
 const fileId=input.fileId,format=input.format,drawer={...input.drawer},queue=input.queue;
 if(!['markdown','text'].includes(format)||typeof queue!=='function')throw new MemoryCipherError();
 return consumeAuthorizedMemoryFile({...input,fileId,consume:async request=>{const text=new TextDecoder('utf-8',{fatal:true}).decode(request.bytes);if(text.includes('\0'))throw new MemoryCipherError();return queue({text,format,drawer,sourceLease:request.sourceLease,sourceDigest:request.sourceDigest});}});
}
