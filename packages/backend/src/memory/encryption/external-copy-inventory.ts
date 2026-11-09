/** Read-only inventory of fixed managed documents and one authorized .girru directory; not ownership proof or complete copy coverage. */
import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {assertAuthorizedExternalRootIdentity,type ExternalRootIdentity} from './external-root-identity.js';
import type {ExternalRootPermissionRequest} from './external-reference-plan.js';
import {MemoryCipherError} from './envelope.js';
export async function inventoryAuthorizedExternalCopies(expected:ExternalRootIdentity,request:ExternalRootPermissionRequest,authorizeRoot:(request:ExternalRootPermissionRequest)=>Promise<boolean>,maxBytes=8388608):Promise<{path:string;bytes:number;sha256:string}[]>{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>8388608)throw new MemoryCipherError();
 const identity=structuredClone(expected),selected=structuredClone(request);
 await assertAuthorizedExternalRootIdentity(identity,selected,authorizeRoot);
 const files=await new Promise<{path:string;bytes:number;sha256:string}[]>((accept,reject)=>{
  const child=spawn('/usr/bin/python3',['-I',fileURLToPath(new URL('../../../python-scripts/external-copy-inventory.py',import.meta.url))],{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C'},timeout:10000});
  let output='',oversized=false;child.on('error',()=>reject(new MemoryCipherError()));child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>131072){oversized=true;child.kill();}});child.stderr.resume();child.stdin.on('error',()=>undefined);
  child.on('close',code=>{try{
   if(code!==0||oversized)throw new MemoryCipherError();const value=JSON.parse(output);
   if(!value||Object.keys(value).join(',')!=='files'||!Array.isArray(value.files)||value.files.length>132)throw new MemoryCipherError();
   let total=0;const seen=new Set<string>();for(const file of value.files){if(!file||Object.keys(file).sort().join(',')!=='bytes,path,sha256'||typeof file.path!=='string'||!(/^\.girru\/[^/\\\0]+$/.test(file.path)||['AGENTS.md','CLAUDE.md','GEMINI.md','DESIGN.md'].includes(file.path))||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>1048576||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256)||seen.has(file.path))throw new MemoryCipherError();seen.add(file.path);total+=file.bytes;}
   if(total>maxBytes)throw new MemoryCipherError();accept(value.files);
  }catch{reject(new MemoryCipherError());}});
  child.stdin.end(JSON.stringify({root:identity.root,device:identity.device,inode:identity.inode,maxBytes}));
 });
 await assertAuthorizedExternalRootIdentity(identity,selected,authorizeRoot);return files;
}
