/** Explicit-root descriptor-relative cleanup; refuses hosts lacking the existing Python dir_fd capability. */
import {lstat,realpath} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import type {ForgetCleanupPlan} from './forget-cleanup.js';
import {MemoryCipherError} from './envelope.js';
export type ScopedForgetFileOperation=string|{path:string;beforeHash:string;afterBase64:string};
export function createScopedForgetFileRunner(selectedRoot:string,pythonPath='/usr/bin/python3',expectedIdentity?:{root:string;device:string;inode:string}){
 const expected=expectedIdentity?{root:expectedIdentity.root,device:expectedIdentity.device,inode:expectedIdentity.inode}:undefined;
 if(expected&&(expected.root!==resolve(selectedRoot)||typeof expected.device!=='string'||!/^\d{1,30}$/.test(expected.device)||typeof expected.inode!=='string'||!/^\d{1,30}$/.test(expected.inode)))throw new MemoryCipherError();
 const selected=resolve(selectedRoot);let pinned:{root:string;device:string;inode:string}|undefined;
 return async(operations:readonly ScopedForgetFileOperation[])=>{
  if(!isAbsolute(pythonPath)||operations.length>5000)throw new MemoryCipherError();
  const info=await lstat(selected,{bigint:true}),root=await realpath(selected),identity={root,device:String(info.dev),inode:String(info.ino)};
  if(expected&&(expected.root!==identity.root||expected.device!==identity.device||expected.inode!==identity.inode))throw new MemoryCipherError();
  if(!info.isDirectory()||info.isSymbolicLink()||pinned&&JSON.stringify(pinned)!==JSON.stringify(identity))throw new MemoryCipherError();pinned=identity;
  const files=operations.map(operation=>{const file=typeof operation==='string'?operation:operation.path,rel=relative(root,resolve(root,file));if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new MemoryCipherError();return typeof operation==='string'?rel:{...operation,path:rel};});
  const payload=JSON.stringify({...identity,files});if(Buffer.byteLength(payload)>4194304)throw new MemoryCipherError();
  await new Promise<void>((accept,reject)=>{
   const child=spawn(pythonPath,['-I',fileURLToPath(new URL('../../../python-scripts/forget-files-native.py',import.meta.url))],{stdio:['pipe','pipe','pipe'],timeout:30000,env:{PATH:'/usr/bin:/bin',LANG:'C'}});let output='';let refused=false;
   child.on('error',()=>reject(new MemoryCipherError()));child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>4096){refused=true;child.kill();}});child.stderr.resume();child.stdin.on('error',()=>undefined);
   child.on('close',code=>{if(!refused&&code===0&&output==='{"removed":true}')accept();else reject(new MemoryCipherError());});child.stdin.end(payload);
  });return true;
 };
}
export function createEncryptedForgetFileCleaner(selectedRoot:string,exportFiles:readonly string[]=[],pythonPath='/usr/bin/python3'){
 const exports=[...exportFiles],execute=createScopedForgetFileRunner(selectedRoot,pythonPath);
 return async(plan:ForgetCleanupPlan)=>{
  if(!/^(?!\.\.?$)[A-Za-z0-9_.@-]{1,200}$/.test(plan.ownerId)||! /^(?!\.\.?$)[A-Za-z0-9_.@-]{1,200}$/.test(plan.memoryId)||plan.types.some(t=>! /^[a-z][a-z_-]{0,31}$/.test(t)))throw new MemoryCipherError();
  return execute([...plan.types.map(t=>join(plan.ownerId,t+'-'+plan.memoryId+'.md')),...exports]);
 };
}
