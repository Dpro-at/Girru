/** Install reviewed npm archives inside a Store app without invoking npm or package scripts. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { unpackTarGz, type RuntimeFetch } from './code-runtime.js';
import { readRegularFile } from './read-regular-file.js';

type Archive = { name:string; version:string; path:string; url:string; sha256:string; size:number };
const NAME='(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*';
const TARGET=new RegExp(`^node_modules/${NAME}(?:/node_modules/${NAME})*$`);
const MAX_BYTES=64*1024*1024;

/** The descriptor itself is a checksum-verified file of the reviewed Store package. */
export function parseRuntimePackages(bytes:Buffer):Archive[]{
 if(bytes.length>128*1024)throw Error('The app runtime list is too large.');
 const data=JSON.parse(bytes.toString('utf8'));
 if(data?.schema!==1||!Array.isArray(data.packages)||!data.packages.length||data.packages.length>100)throw Error('Invalid app runtime list.');
 const seen=new Set<string>();let total=0;
 return data.packages.map((a:Archive)=>{
  if(!a||typeof a.name!=='string'||!new RegExp(`^${NAME}$`).test(a.name)||typeof a.version!=='string'||!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(a.version)||typeof a.path!=='string'||!TARGET.test(a.path)||a.path.split('/node_modules/').at(-1)!==a.name&&a.path!==`node_modules/${a.name}`||seen.has(a.path)||!Number.isSafeInteger(a.size)||a.size<=0||a.size>MAX_BYTES||typeof a.sha256!=='string'||!/^[a-f0-9]{64}$/.test(a.sha256))throw Error('Invalid app runtime package.');
  const u=new URL(a.url),leaf=a.name.split('/').at(-1);
  if(u.origin!=='https://registry.npmjs.org'||u.username||u.password||u.search||u.hash||u.pathname!==`/${a.name}/-/${leaf}-${a.version}.tgz`)throw Error('The app runtime address is not a pinned npm package.');
  seen.add(a.path);total+=a.size;if(total>MAX_BYTES)throw Error('The app runtime download is too large.');
  return {name:a.name,version:a.version,path:a.path,url:u.href,sha256:a.sha256,size:a.size};
 });
}

export async function installRuntimePackages(incoming:string,bytes:Buffer,get:RuntimeFetch=globalThis.fetch as unknown as RuntimeFetch){
 const stat=fs.lstatSync(incoming);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('The app staging folder must be a plain directory.');
 const archives=parseRuntimePackages(bytes),work=path.join(incoming,`.runtime-${randomBytes(8).toString('hex')}`);
 fs.mkdirSync(work,{mode:0o700});let extractedBytes=0,extractedEntries=0;
 const measure=(folder:string)=>{for(const entry of fs.readdirSync(folder,{withFileTypes:true})){if(++extractedEntries>60000)throw Error('The app runtime has too many files.');const file=path.join(folder,entry.name);if(entry.isDirectory())measure(file);else if(entry.isFile()){extractedBytes+=fs.lstatSync(file).size;if(extractedBytes>512*1024*1024)throw Error('The app runtime expands beyond its size limit.');}else throw Error('Runtime links are not allowed.');}};
 try{
  for(let i=0;i<archives.length;i++){
   const a=archives[i],file=path.join(work,`${i}.tgz`),unpacked=path.join(work,String(i));
   const handle=await fs.promises.open(file,'wx',0o600);let used=0;const hash=createHash('sha256');const control=new AbortController();let timer=setTimeout(()=>control.abort(),60000);
   const progress=()=>{clearTimeout(timer);timer=setTimeout(()=>control.abort(),60000);};
   try{
    const response=await get(a.url,{signal:control.signal,headers:{'User-Agent':'Girru'}});
    if(!response.ok||!response.body)throw Error('The app runtime could not be downloaded.');
    for await(const chunk of response.body as AsyncIterable<Uint8Array>){progress();const data=Buffer.from(chunk);used+=data.length;if(used>a.size)throw Error('The app runtime download is larger than reviewed.');hash.update(data);await handle.writeFile(data);}
    if(used!==a.size||hash.digest('hex')!==a.sha256)throw Error('The app runtime did not pass its integrity check.');
   }finally{clearTimeout(timer);control.abort();await handle.close();}
   fs.mkdirSync(unpacked,{mode:0o700});
   await unpackTarGz(file,unpacked,{bytes:256*1024*1024,entries:30000});
   measure(unpacked);
   const entries=fs.readdirSync(unpacked);if(entries.length!==1)throw Error('Invalid npm archive root for '+a.name+'.');
   const packageRoot=path.join(unpacked,entries[0]);
   const pkg=JSON.parse((await readRegularFile(path.join(packageRoot,'package.json'),65536)).data.toString('utf8'));
   if(pkg.name!==a.name||pkg.version!==a.version)throw Error('The app runtime package identity changed.');
   const target=path.join(incoming,...a.path.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
   if(fs.existsSync(target))throw Error('The app runtime target already exists.');
   fs.renameSync(packageRoot,target);
   fs.rmSync(file,{force:true});
  }
 }finally{fs.rmSync(work,{recursive:true,force:true});}
}
