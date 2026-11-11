/** Same-process filesystem exclusion for actual native-owned memory/control trees. SQL copies use separate authenticated APIs. */
import fs from 'node:fs';
import path from 'node:path';
import {MemoryCipherError} from './envelope.js';
type Registration={purpose:'native-owned-control'|'native-owned-profile';roots:readonly string[];isCurrent:()=>boolean};
const registrations:Readonly<Registration>[]=[];
function deny():never{throw new MemoryCipherError();}
function normalized(value:string){if(typeof value!=='string'||!path.isAbsolute(value)||value.includes('\0'))deny();return path.resolve(value);}
function existingAncestor(value:string){let current=normalized(value),rest:string[]=[];for(let depth=0;depth<256;depth++){try{const real=fs.realpathSync.native(current);return path.resolve(real,...rest);}catch(error:any){if(error?.code!=='ENOENT')deny();const parent=path.dirname(current);if(parent===current)deny();rest.unshift(path.basename(current));current=parent;}}deny();}
const fold=(value:string)=>process.platform==='darwin'||process.platform==='win32'?value.toLowerCase():value;
function within(root:string,target:string){const relative=path.relative(fold(root),fold(target));return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);}
/** Called only by the private native control/profile constructors with their actual immutable physical lease. */
export function registerProtectedMemoryFilesystem(input:Registration){if(!input||!['native-owned-control','native-owned-profile'].includes(input.purpose)||typeof input.isCurrent!=='function'||input.isCurrent()!==true||!Array.isArray(input.roots)||!input.roots.length||input.roots.length>64||registrations.length>=128)deny();const roots=Object.freeze([...new Set(input.roots.map(root=>{const absolute=normalized(root),actual=existingAncestor(absolute);if(actual!==absolute)deny();return absolute;}))]);const record=Object.freeze({purpose:input.purpose,roots,isCurrent:input.isCurrent.bind(input)});registrations.push(record);return record;}
/** Metadata only. Retained exclusions never disappear merely because a lease was revoked. */
export function protectedMemoryFilesystemRoots():readonly string[]{return Object.freeze([...new Set(registrations.flatMap(record=>record.roots))]);}
export function hasProtectedMemoryFilesystem(){return registrations.length!==0;}
/** MUST precede any fs.open/read/write/copy/archive on caller-selected paths. No DB fd is opened to inspect identity. */
export function assertMemoryFilesystemAccess(value:string,recursive=false):void{
 if(!registrations.length&&!databaseInodes.size)return;assertNoProtectedDatabaseAlias(value);const lexical=normalized(value),real=existingAncestor(lexical);
 for(const record of registrations)for(const root of record.roots)if(within(root,lexical)||within(root,real)||recursive&&(within(lexical,root)||within(real,root)))deny();
 // A hardlink outside a protected tree must never open/close a live SQLite inode.
 for(const target of [...new Set([lexical,real])])try{const stat=fs.lstatSync(target,{bigint:true});if(stat.isFile()&&stat.nlink!==1n)deny();}catch(error:any){if(error instanceof MemoryCipherError)throw error;if(error?.code!=='ENOENT')deny();}
}
/** Legacy raw whole-profile backup/restore cannot prove current encrypted copy custody. */
export function assertNoRawProtectedMemoryCopy(){if(registrations.length)deny();}
const databaseInodes=new Set<string>();
/** Native-created SAME-process SQLite leaf only; metadata stat never opens/closes the protected DB. */
export function registerProtectedMemoryDatabaseFile(input:{file:string;isCurrent:()=>boolean}){if(!input||typeof input.isCurrent!=='function'||input.isCurrent()!==true||databaseInodes.size>=512)deny();const named=normalized(input.file),stat=fs.lstatSync(named,{bigint:true});if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1n||fs.realpathSync.native(named)!==named)deny();databaseInodes.add(String(stat.dev)+':'+String(stat.ino));}
/** Dedicated fixed-format backend readers may read non-DB configuration, but NEVER a protected DB alias. */
export function assertNoProtectedDatabaseAlias(file:string){if(!registrations.length&&!databaseInodes.size)return;const candidate=existingAncestor(normalized(file));try{const stat=fs.lstatSync(candidate,{bigint:true});if(stat.isFile()&&(stat.nlink!==1n||databaseInodes.has(String(stat.dev)+':'+String(stat.ino))))deny();}catch(error:any){if(error instanceof MemoryCipherError)throw error;if(error?.code!=='ENOENT')deny();}}
type DatabaseCloser={file:string;isCurrent:()=>boolean;revokeAndClose:()=>void;isClosed:()=>boolean};
type HeldDescriptor={key:string;close:(()=>unknown)|null;closed:boolean;result:unknown;done:Promise<void>;resolve:()=>void;reject:(error:unknown)=>void};
const databaseClosers=new Map<string,DatabaseCloser>(),quarantined=new Map<number,HeldDescriptor>();
const identityTeardowns=new Map<string,Set<Promise<void>>>();
let descriptorPoison:{isCurrent:()=>boolean;poison:()=>void}|null=null;
export function installProtectedMemoryDescriptorPoison(input:{isCurrent:()=>boolean;poison:()=>void}){if(!input||typeof input.isCurrent!=='function'||typeof input.poison!=='function'||!input.isCurrent()||descriptorPoison?.isCurrent())deny();descriptorPoison=input;}
/** Bind the actual native connection closer, not a claimed boolean from a file request. */
export function bindProtectedMemoryDatabaseCloser(input:DatabaseCloser){if(!input||typeof input.revokeAndClose!=='function'||typeof input.isClosed!=='function'||typeof input.isCurrent!=='function'||!input.isCurrent())deny();const stat=fs.lstatSync(input.file,{bigint:true}),key=String(stat.dev)+':'+String(stat.ino);if(!databaseInodes.has(key))deny();databaseClosers.set(key,input);}
function descriptorDatabase(fd:number){const stat=fs.fstatSync(fd,{bigint:true}),key=String(stat.dev)+':'+String(stat.ino);return databaseInodes.has(key)?key:null;}
function stopDatabase(key:string){try{descriptorPoison?.poison();}catch{}const actual=databaseClosers.get(key);try{actual?.revokeAndClose();}catch{}return actual?.isClosed()===true;}
function heldDescriptor(fd:number,key:string){let held=quarantined.get(fd);if(held){if(held.key!==key)deny();return held;}let resolve!:()=>void,reject!:(error:unknown)=>void;const done=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});done.catch(()=>{});held={key,close:null,closed:false,result:undefined,done,resolve,reject};quarantined.set(fd,held);return held;}
function closeHeld(fd:number,held:HeldDescriptor){if(held.closed||!held.close||databaseClosers.get(held.key)?.isClosed()!==true)return held.result;held.closed=true;try{held.result=held.close();Promise.resolve(held.result).then(()=>{held.resolve();if(quarantined.get(fd)===held)quarantined.delete(fd);},error=>{held.reject(error);try{descriptorPoison?.poison();}catch{}});return held.result;}catch(error){held.reject(error);try{descriptorPoison?.poison();}catch{}throw error;}}
/** Record the unexpected fd BEFORE invoking the real closer. Identity-fd teardown waits for its finally callback. */
export function assertProtectedMemoryFileDescriptor(fd:number){if(!databaseInodes.size)return;if(quarantined.get(fd)?.closed)quarantined.delete(fd);const key=descriptorDatabase(fd);if(!key)return;heldDescriptor(fd,key);stopDatabase(key);deny();}
/** A failed SQLite close retains the unexpected fd and its strong FileHandle callback until real teardown. */
export function closeProtectedMemoryFileDescriptor<T>(fd:number,close:()=>T):T|undefined{if(!databaseInodes.size)return close();const existing=quarantined.get(fd),key=existing?.key??descriptorDatabase(fd);if(!key)return close();const held=existing??heldDescriptor(fd,key);if(held.closed)return held.result as T;held.close=close;if(databaseClosers.get(key)?.isClosed()!==true)stopDatabase(key);if(held.closed)return held.result as T;if(databaseClosers.get(key)?.isClosed()!==true)return undefined;return closeHeld(fd,held) as T|undefined;}
/** Resolves only AFTER every unexpected descriptor has actually closed; no claim that a pending async close finished. */
export function releaseQuarantinedMemoryDescriptors(file:string):Promise<void>|undefined{const keys=new Set([...databaseClosers].filter(([,record])=>record.file===file).map(([key])=>key)),waiting:Promise<void>[]=[];for(const [fd,held]of quarantined){if(!keys.has(held.key))continue;if(databaseClosers.get(held.key)?.isClosed()===true)closeHeld(fd,held);waiting.push(held.done);}return waiting.length?Promise.all(waiting).then(()=>{}):undefined;}
/** Synchronous leaf close can retain its identity fd until asynchronous FileHandle closes finish. */
export function afterQuarantinedMemoryDescriptors(file:string,closeIdentity:()=>void):Promise<void>|undefined{const done=releaseQuarantinedMemoryDescriptors(file);if(!done){closeIdentity();return undefined;}const pending=done.then(()=>{try{closeIdentity();const remaining=identityTeardowns.get(file);remaining?.delete(pending);if(remaining?.size===0)identityTeardowns.delete(file);}catch(error){try{descriptorPoison?.poison();}catch{}throw error;}},error=>{try{descriptorPoison?.poison();}catch{}throw error;});const waiting=identityTeardowns.get(file)??new Set<Promise<void>>();waiting.add(pending);identityTeardowns.set(file,waiting);pending.catch(()=>{});return pending;}
/** A new SQLite connection must not open while an older identity-fd close could cancel its locks. */
export function assertNoPendingMemoryDatabaseDescriptors(file:string){if(identityTeardowns.has(file))deny();}

export function readNonDatabaseFileSync(file:string):Buffer;
export function readNonDatabaseFileSync(file:string,encoding:BufferEncoding):string;
export function readNonDatabaseFileSync(file:string,encoding?:BufferEncoding):Buffer|string{assertNoProtectedDatabaseAlias(file);const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0));try{assertProtectedMemoryFileDescriptor(fd);const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>128*1024*1024)deny();return encoding?fs.readFileSync(fd,encoding):fs.readFileSync(fd);}finally{closeProtectedMemoryFileDescriptor(fd,()=>fs.closeSync(fd));}}
export function readUnprotectedFileSync(file:string):Buffer;
export function readUnprotectedFileSync(file:string,encoding:BufferEncoding):string;
export function readUnprotectedFileSync(file:string,encoding?:BufferEncoding):Buffer|string{assertMemoryFilesystemAccess(file);return encoding?readNonDatabaseFileSync(file,encoding):readNonDatabaseFileSync(file);}
export function createUnprotectedReadStream(file:string){assertMemoryFilesystemAccess(file);const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0));let transferred=false;try{assertProtectedMemoryFileDescriptor(fd);if(!fs.fstatSync(fd).isFile())deny();const stream=fs.createReadStream(file,{fd,autoClose:false});let released=false;const release=()=>{if(released)return;released=true;closeProtectedMemoryFileDescriptor(fd,()=>fs.closeSync(fd));};stream.once('close',release);stream.once('end',release);stream.once('error',release);transferred=true;return stream;}finally{if(!transferred)closeProtectedMemoryFileDescriptor(fd,()=>fs.closeSync(fd));}}
