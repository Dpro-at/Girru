/** Strict RAM-only historical plan parser. Neither authentication nor authorization nor an effect capability. */
import path from 'node:path';
import {MAX_MEMORY_PLAINTEXT_BYTES,MemoryCipherError} from './envelope.js';
import {validateReferences} from './external-copy-manifest.js';
import type {AuthorizedExternalReference} from './external-reference-plan.js';
import type {ExternalRootIdentity} from './external-root-identity.js';
import type {ExternalCopyClass} from './external-copy-classification.js';
type File={path:string;bytes:number;sha256:string;classification?:ExternalCopyClass};
export type ExternalPlanSnapshot={v:1|2|3|4;ownerId:string;snapshotId:string;plan:AuthorizedExternalReference[];identities?:ExternalRootIdentity[];inventories?:Array<{ownerId:string;scope:string;root:string;files:File[]}>};
const exact=(value:unknown,keys:string)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys;
const rootKey=(scope:string,root:string)=>JSON.stringify([scope,root]);
export function parseExternalPlanSnapshot(plaintext:string,ownerId:string,snapshotId:string):ExternalPlanSnapshot{
 try{
  if(typeof plaintext!=='string'||Buffer.byteLength(plaintext)>MAX_MEMORY_PLAINTEXT_BYTES||!ownerId||!snapshotId)throw new MemoryCipherError();
  const value=JSON.parse(plaintext);
  if(![1,2,3,4].includes(value?.v)||value.ownerId!==ownerId||value.snapshotId!==snapshotId||!exact(value,value.v===1?'ownerId,plan,snapshotId,v':value.v===2?'identities,ownerId,plan,snapshotId,v':'identities,inventories,ownerId,plan,snapshotId,v')||!Array.isArray(value.plan)||value.plan.length>3000)throw new MemoryCipherError();
  const roots=new Set<string>(),holds=new Map<string,string>();
  for(const item of value.plan){
   if(!exact(item,'hold,reference,root,scope')||typeof item.scope!=='string'||!item.scope.startsWith('project:')||Buffer.byteLength(item.scope)>512||typeof item.root!=='string'||Buffer.byteLength(item.root)>16384||item.root.includes('\0')||!path.isAbsolute(item.root)||path.resolve(item.root)!==item.root||item.root===path.parse(item.root).root)throw new MemoryCipherError();
   const [reference]=validateReferences([item.reference]);
   if((reference!.kind==='projection-file'&&reference!.scope!==item.scope)||reference!.path!==(reference!.kind==='projection-file'?path.join(item.root,'.girru','brief.md'):item.root)||!exact(item.hold,'generation,id,scope')||item.hold.scope!==item.scope||typeof item.hold.id!=='string'||!item.hold.id||Buffer.byteLength(item.hold.id)>256||!Number.isSafeInteger(item.hold.generation)||item.hold.generation<1)throw new MemoryCipherError();
   const hold=JSON.stringify([item.hold.id,item.hold.generation]);if(holds.has(item.scope)&&holds.get(item.scope)!==hold)throw new MemoryCipherError();holds.set(item.scope,hold);roots.add(rootKey(item.scope,item.root));
  }
  if(value.v>=2){
   if(roots.size>32||!Array.isArray(value.identities)||value.identities.length!==roots.size)throw new MemoryCipherError();const seen=new Set<string>();
   for(const identity of value.identities){if(!exact(identity,'device,inode,ownerId,root,scope')||identity.ownerId!==ownerId||typeof identity.scope!=='string'||typeof identity.root!=='string'||typeof identity.device!=='string'||!/^\d{1,30}$/.test(identity.device)||typeof identity.inode!=='string'||!/^\d{1,30}$/.test(identity.inode))throw new MemoryCipherError();const key=rootKey(identity.scope,identity.root);if(!roots.has(key)||seen.has(key))throw new MemoryCipherError();seen.add(key);}
  }
  if(value.v>=3){
   if(!Array.isArray(value.inventories)||value.inventories.length!==roots.size)throw new MemoryCipherError();let total=0;const seen=new Set<string>();
   for(const inventory of value.inventories){
    if(!exact(inventory,'files,ownerId,root,scope')||inventory.ownerId!==ownerId||typeof inventory.scope!=='string'||typeof inventory.root!=='string'||!Array.isArray(inventory.files)||inventory.files.length>132)throw new MemoryCipherError();const key=rootKey(inventory.scope,inventory.root);if(!roots.has(key)||seen.has(key))throw new MemoryCipherError();seen.add(key);const names=new Set<string>();
    for(const file of inventory.files){if(!exact(file,value.v===4?'bytes,classification,path,sha256':'bytes,path,sha256')||typeof file.path!=='string'||!(/^\.girru\/(?!\.{1,2}$)[^/\\\0]+$/.test(file.path)||['AGENTS.md','CLAUDE.md','GEMINI.md','DESIGN.md'].includes(file.path))||names.has(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>1048576||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256))throw new MemoryCipherError();names.add(file.path);total+=file.bytes;if(value.v===4&&!['shared-document','registered-projection-match','registered-projection-changed','historical-copy-unverified','staged-copy-unverified','unclassified'].includes(file.classification))throw new MemoryCipherError();}
   }if(total>8388608)throw new MemoryCipherError();
  }
  return value as ExternalPlanSnapshot;
 }catch{throw new MemoryCipherError();}
}
