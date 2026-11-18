/** Authenticated disclosure inventory, not evidence that any external copy was removed. */
import {createHash} from 'node:crypto';
import {isTrustedMemoryReadAuditStore,createMemoryReadAuditStore,type MemoryAuditAnchor,type MemoryReadAuditEntry} from './read-audit.js';
import {captureMemoryRestoreAnchor,type MemoryRestoreAnchor} from './restore-package.js';
import {MemoryCipherError} from './envelope.js';
type Store=ReturnType<typeof createMemoryReadAuditStore>;
type Hold=Readonly<{sequence:number;eventId:string;readerKind:MemoryReadAuditEntry['readerKind'];readerId:string;purpose:MemoryReadAuditEntry['purpose'];records:readonly Readonly<MemoryReadAuditEntry['records'][number]>[]}>;
export type VerifiedDisclosureInventory=Readonly<{kind:'complete-disclosure-history-inventory';inventoryComplete:true;profileId:string;ownerId:string;memberId:string;authorityId:string;authority:Readonly<MemoryRestoreAnchor>;auditHead:Readonly<MemoryAuditAnchor>;receiptId:string;unresolvedHolds:number;isCurrent:()=>boolean}>;
const issued=new WeakMap<object,{holds:readonly Hold[];current:()=>boolean}>();
const identity=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value);
function fail():never{throw new MemoryCipherError();}
/** Automated entrances must use agent/coding-app. User views are the explicit owner/human boundary.
 * Unknown system work is conservative; only the fixed migration-verify class is internal.
 * A complete chain proves recorded history, not that an unported caller cannot leak plaintext. */
function potentialDisclosure(entry:MemoryReadAuditEntry){return entry.readerKind==='agent'||entry.readerKind==='coding-app'||entry.purpose==='export'||entry.readerKind==='system'&&entry.purpose!=='migration-verify'&&!(entry.version===2&&entry.purpose==='internal-maintenance'&&(entry.readerId==='trace-auxiliary-maintenance'&&entry.records.every(record=>record.table==='memory_encryption_auxiliary')||entry.readerId==='trace-timing-maintenance'&&entry.records.length===1&&entry.records[0].table==='memory_recall_traces'));}
export async function captureVerifiedDisclosureInventory(input:{auditStore:Store;profileId:string;ownerId:string;memberId:string;expectedAuditHead:MemoryAuditAnchor;authority:MemoryRestoreAnchor;isCurrent:()=>boolean}):Promise<VerifiedDisclosureInventory>{
 if(!isTrustedMemoryReadAuditStore(input.auditStore)||![input.profileId,input.ownerId,input.memberId].every(identity)||typeof input.isCurrent!=='function'||!input.isCurrent())fail();
 const profileId=input.profileId,ownerId=input.ownerId,memberId=input.memberId,current=input.isCurrent.bind(input),authority=captureMemoryRestoreAnchor(input.authority),expected={...input.expectedAuditHead};
 if(authority.ownerId!==ownerId||authority.memberId!==memberId||expected.ownerId!==ownerId)fail();
 const history=await input.auditStore.captureVerifiedHistory(expected);if(!current()||!isTrustedMemoryReadAuditStore(input.auditStore)||JSON.stringify(history.head)!==JSON.stringify(expected))fail();
 const holds=Object.freeze(history.entries.filter(entry=>potentialDisclosure(entry as MemoryReadAuditEntry)).map(entry=>{const records=entry.records.map(record=>Object.freeze({...record}));Object.freeze(records);return Object.freeze({sequence:entry.sequence,eventId:entry.eventId,readerKind:entry.readerKind,readerId:entry.readerId,purpose:entry.purpose,records});}));
 // Internal startup/audit verification appends must not manufacture a changed semantic receipt.
 const receiptId=createHash('sha256').update(JSON.stringify(['memory-disclosure-inventory',1,profileId,ownerId,memberId,authority.authorityId,holds])).digest('hex');
 const isCurrent=()=>{try{return current()===true&&isTrustedMemoryReadAuditStore(input.auditStore);}catch{return false;}};
 const proof:VerifiedDisclosureInventory=Object.freeze({kind:'complete-disclosure-history-inventory',inventoryComplete:true,profileId,ownerId,memberId,authorityId:authority.authorityId,authority:Object.freeze(authority),auditHead:Object.freeze({...history.head}),receiptId,unresolvedHolds:holds.length,isCurrent});issued.set(proof,{holds,current:isCurrent});if(!isCurrent())fail();return proof;
}
export function isTrustedDisclosureInventory(value:unknown):value is VerifiedDisclosureInventory{try{return !!value&&typeof value==='object'&&issued.get(value)?.current()===true;}catch{return false;}}
/** No ACK/dismiss argument exists: legacy history cannot prove artifact removal or provider deletion. */
export function assertNoUnresolvedDisclosureHolds(inventory:VerifiedDisclosureInventory,targetIds?:readonly string[]):void{
 const stored=issued.get(inventory);if(!stored||!isTrustedDisclosureInventory(inventory))fail();
 let targets:Set<string>|undefined;if(targetIds!==undefined){if(!Array.isArray(targetIds)||!targetIds.length||targetIds.length>5000||targetIds.some(id=>!identity(id))||new Set(targetIds).size!==targetIds.length)fail();targets=new Set(targetIds);}
 for(const hold of stored.holds){if(!targets||hold.records.some(record=>record.table!=='memories'||targets!.has(record.id)))fail();}
 if(!stored.current())fail();
}
