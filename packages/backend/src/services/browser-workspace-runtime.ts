/** Full owner Browser workspace, separate from the optional agent automation host. */
import fs from 'node:fs';import path from 'node:path';import {createHash,randomBytes} from 'node:crypto';
import {runtimesRoot,runtimePlatform,downloadTo,enoughSpace,unpackTarGz,type RuntimeFetch} from './code-runtime.js';
import {runtimeUrlAllowed,type StoreRuntime,type RuntimePlatform} from './store-repo.js';import type {AddJob} from './store-install.js';
export const BROWSER_ITEM='girru:browser';
const VERSION=/^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;
const DIR=/^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?-[a-f0-9]{8}$/;
const executable:Record<RuntimePlatform,string>={'darwin-arm64':'native/GirruBrowser.app/Contents/MacOS/GirruBrowser','darwin-x64':'native/GirruBrowser.app/Contents/MacOS/GirruBrowser','linux-x64':'native/girru-browser','win32-x64':'native/GirruBrowser.exe'};
const root=()=>path.join(runtimesRoot(),'browser');
function regular(base:string,name:string,max?:number){let at=base;for(const part of name.split('/')){at=path.join(at,part);if(fs.lstatSync(at).isSymbolicLink())throw Error('Browser runtime contains a link');}const stat=fs.statSync(at);if(!stat.isFile()||max!==undefined&&stat.size>max)throw Error('Incomplete Browser runtime');return at;}
export function browserWorkspaceComplete(base:string,platform:RuntimePlatform|null=runtimePlatform(),version?:string){try{
 if(!platform||fs.lstatSync(base).isSymbolicLink())return false;
 const descriptor=JSON.parse(fs.readFileSync(regular(base,'browser-runtime.json',4096),'utf8'));
 if(descriptor.protocolVersion!==1||descriptor.platform!==platform||!VERSION.test(descriptor.version)||version!==undefined&&descriptor.version!==version)return false;
 const pkg=JSON.parse(fs.readFileSync(regular(base,'runtime/package.json',65536),'utf8'));if(pkg.name!=='@girru/browser')return false;
 for(const file of ['runtime/scripts/full-start.cjs','runtime/src/full-browser.cjs','runtime/node_modules/ws/package.json','runtime/node_modules/playwright/package.json','extension/manifest.json',executable[platform]])regular(base,file);
 return true;
}catch{return false;}}
export function installedBrowserWorkspace(base=root(),platform:RuntimePlatform|null=runtimePlatform()){
 try{
  for(const at of [path.dirname(base),base])if(!fs.lstatSync(at).isDirectory()||fs.lstatSync(at).isSymbolicLink())return null;
  const file=regular(base,'current.json',4096),fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));let c;
  try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>4096)return null;c=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
  if(!c||!VERSION.test(c.version)||!DIR.test(c.dir)||!c.dir.startsWith(c.version+'-')||!/^[a-f0-9]{64}$/.test(c.sha256))return null;
  const dir=path.join(base,c.dir);return browserWorkspaceComplete(dir,platform,c.version)?{version:c.version,dir,sha256:c.sha256}:null;
 }catch{return null;}
}
export const browserWorkspaceStoreActive=()=>!!process.env.GIRRU_APP_RUNTIMES_DIR?.trim();
/** The displayed review binds the exact platform archives, including same-version replacement. */
export const browserWorkspaceReviewHash=(item:{id:string;version:string|null;permissions:string[]},runtime:StoreRuntime|null)=>createHash('sha256').update(JSON.stringify([item.id,item.version,item.permissions,runtime])).digest('hex');
export async function installBrowserWorkspace(job:AddJob,runtime:StoreRuntime,get?:RuntimeFetch){
 const platform=runtimePlatform(),archive=platform&&runtime.archives[platform];if(!platform||!archive||!VERSION.test(runtime.version)||!runtimeUrlAllowed(archive.url))throw Error('No reviewed full Browser runtime for this computer');
 const base=root();fs.mkdirSync(base,{recursive:true,mode:0o700});for(const at of [path.dirname(base),base])if(fs.lstatSync(at).isSymbolicLink())throw Error('Browser app folder is a link');
 await enoughSpace(base,archive.size,'Browser');const tag=randomBytes(4).toString('hex'),download=path.join(base,`.download-${tag}.tar.gz`),incoming=path.join(base,`.incoming-${tag}`),pointer=path.join(base,`.current-${tag}.json`);let promoted:string|null=null;
 try{
  job.step='getting';job.received=0;job.total=archive.size;const hash=await downloadTo(archive,download,get??globalThis.fetch as unknown as RuntimeFetch,n=>{job.received=n;});job.step='checking';if(hash!==archive.sha256)throw Error('Browser download checksum differs from the reviewed Store archive');
  job.step='setting-up';fs.mkdirSync(incoming,{mode:0o700});await unpackTarGz(download,incoming);if(!browserWorkspaceComplete(incoming,platform,runtime.version))throw Error('The archive is not a complete full Browser workspace');
  job.step='adding';const name=runtime.version+'-'+tag;promoted=path.join(base,name);fs.renameSync(incoming,promoted);fs.writeFileSync(pointer,JSON.stringify({version:runtime.version,dir:name,sha256:hash,installedAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});fs.renameSync(pointer,path.join(base,'current.json'));promoted=null;
  // Retain earlier versions: a running native process may still own their files.
 }finally{fs.rmSync(download,{force:true});fs.rmSync(incoming,{recursive:true,force:true});fs.rmSync(pointer,{force:true});if(promoted)fs.rmSync(promoted,{recursive:true,force:true});}
}
export function removeBrowserWorkspace(){const base=root();if(!fs.existsSync(base))return;for(const at of [path.dirname(base),base])if(fs.lstatSync(at).isSymbolicLink())throw Error('Browser app folder is a link');fs.rmSync(path.join(base,'current.json'),{force:true});/* Running native versions are retained until explicit idle cleanup. */}
