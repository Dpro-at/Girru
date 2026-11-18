/** Explicit authorized directory metadata only. No leaf reads, writes or cleanup capability. */
import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';
import type {ExternalRootPermissionRequest} from './external-reference-plan.js';
import {MemoryCipherError} from './envelope.js';
export type ExternalRootIdentity={ownerId:string;scope:string;root:string;device:string;inode:string};
export async function pinAuthorizedExternalRoot(request:ExternalRootPermissionRequest,authorizeRoot:(request:ExternalRootPermissionRequest)=>Promise<boolean>):Promise<ExternalRootIdentity>{
 const selected=structuredClone(request);
 if(typeof selected.ownerId!=='string'||!selected.ownerId||Buffer.byteLength(selected.ownerId)>256||typeof selected.scope!=='string'||!selected.scope.startsWith('project:')||Buffer.byteLength(selected.scope)>512)throw new MemoryCipherError();
 if(selected.purpose!=='encrypted-forget-plan'||typeof selected.root!=='string'||Buffer.byteLength(selected.root)>16384||selected.root.includes('\0')||!path.isAbsolute(selected.root)||path.resolve(selected.root)!==selected.root||selected.root===path.parse(selected.root).root||typeof authorizeRoot!=='function')throw new MemoryCipherError();
 const check=async()=>{if(await authorizeRoot(structuredClone(selected))!==true)throw new MemoryCipherError();};
 await check();
 const identity=await new Promise<{device:string;inode:string}>((accept,reject)=>{
  const child=spawn('/usr/bin/python3',['-I',fileURLToPath(new URL('../../../python-scripts/external-root-identity.py',import.meta.url))],{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C'},timeout:10000});
  let output='',oversized=false;child.on('error',()=>reject(new MemoryCipherError()));child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>512){oversized=true;child.kill();}});child.stderr.resume();child.stdin.on('error',()=>undefined);
  child.on('close',code=>{try{if(code!==0||oversized)throw new MemoryCipherError();const value=JSON.parse(output);if(!value||Object.keys(value).sort().join(',')!=='device,inode'||typeof value.device!=='string'||!/^\d{1,30}$/.test(value.device)||typeof value.inode!=='string'||!/^\d{1,30}$/.test(value.inode))throw new MemoryCipherError();accept(value);}catch{reject(new MemoryCipherError());}});
  child.stdin.end(JSON.stringify({root:selected.root}));
 });
 await check();return{ownerId:selected.ownerId,scope:selected.scope,root:selected.root,...identity};
}

/** Reopen/check immediately at a future effect boundary; still not a retained-descriptor capability. */
export async function assertAuthorizedExternalRootIdentity(expected:ExternalRootIdentity,request:ExternalRootPermissionRequest,authorizeRoot:(request:ExternalRootPermissionRequest)=>Promise<boolean>):Promise<void>{
 if(!expected||Object.keys(expected).sort().join(',')!=='device,inode,ownerId,root,scope'||expected.ownerId!==request.ownerId||expected.scope!==request.scope||expected.root!==request.root||typeof expected.device!=='string'||!/^\d{1,30}$/.test(expected.device)||typeof expected.inode!=='string'||!/^\d{1,30}$/.test(expected.inode))throw new MemoryCipherError();
 const snapshot={...expected},current=await pinAuthorizedExternalRoot(request,authorizeRoot);
 if(current.device!==snapshot.device||current.inode!==snapshot.inode||current.root!==snapshot.root||current.scope!==snapshot.scope||current.ownerId!==snapshot.ownerId)throw new MemoryCipherError();
}
