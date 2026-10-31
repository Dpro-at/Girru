/** Opt-in local project import schedule. Enabled schedules save their own redacted extracted facts automatically. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {dataPath} from '../../config/data-root.js';
import {q} from '../../repositories/sql-steps.js';
import {scanProjectDocuments} from './project-documents.js';
import {getJob,importedSessions,latestImportJob,startImport,type ExtractFn} from './local-import.js';
export type AutomaticImportSettings={enabled:boolean;intervalMinutes:15|30|60;nextRun:number;lastRun:number|null;status:'idle'|'scanning'|'importing'|'review'|'error';lastImported:number;lastProposed:number;notice:string};
type Saved=AutomaticImportSettings&{userId:string;cursor?:string;pending?:string[];scanningComplete?:boolean;memoryHomes?:string[]};
const folder=()=>dataPath('automatic-project-import');
const file=(user:string)=>path.join(folder(),createHash('sha256').update(user).digest('hex')+'.json');
const defaults=(userId:string):Saved=>({userId,enabled:false,intervalMinutes:60,nextRun:0,lastRun:null,status:'idle',lastImported:0,lastProposed:0,notice:'Automatic import is off. Manual imports wait for approval. Enabled automatic imports save new memories directly.'});
async function read(user:string):Promise<Saved>{try{return JSON.parse(await fs.readFile(file(user),'utf8'));}catch(e:any){if(e.code==='ENOENT')return defaults(user);throw e;}}
const writes=new Map<string,Promise<Saved>>();
async function patch(user:string,update:(s:Saved)=>Saved):Promise<Saved>{
 const previous=writes.get(user)??Promise.resolve(defaults(user));
 const next=previous.catch(()=>defaults(user)).then(async()=>{const value=update(await read(user));await fs.mkdir(folder(),{recursive:true,mode:0o700});const temp=file(user)+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});await fs.rename(temp,file(user));return value;});
 writes.set(user,next);try{return await next;}finally{if(writes.get(user)===next)writes.delete(user);}
}
const visible=({userId:_,cursor:__,pending:___,scanningComplete:____,memoryHomes:_____,...settings}:Saved):AutomaticImportSettings=>settings;
export async function automaticImportSettings(user:string){return visible(await read(user));}
export async function configureAutomaticImport(user:string,input:unknown,now=Date.now()){
 const b=input as Record<string,unknown>;
 if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['enabled','intervalMinutes'].includes(k))||typeof b.enabled!=='boolean'||![15,30,60].includes(b.intervalMinutes as number))throw Error('Invalid automatic import settings');
 return visible(await patch(user,s=>({...s,enabled:b.enabled as boolean,intervalMinutes:b.intervalMinutes as 15|30|60,nextRun:b.enabled?now:0,...(!b.enabled?{status:'idle' as const,notice:'Automatic import is off. Saved import jobs remain available.'}:{notice:'Automatic import is enabled: new redacted memories are saved without a review prompt.'})})));
}
let timer:ReturnType<typeof setInterval>|undefined,stopped=false;
const active=new Map<string,Promise<void>>();
type ScanPage={documents:{id:string}[];nextCursor?:string|null;allDocumentIds?:string[];memoryHomes?:string[];deniedRoots?:number;unavailableRoots?:number;skippedFiles?:number;scanned?:number};
type Options={now?:number;extract?:ExtractFn;home?:string;scan?:(user:string,cursor?:string)=>Promise<{documents:{id:string}[];nextCursor?:string|null;allDocumentIds?:string[];memoryHomes?:string[];deniedRoots?:number;unavailableRoots?:number;skippedFiles?:number;scanned?:number}>;pollMs?:number};
async function run(user:string,opts:Options){
 const now=opts.now??Date.now();await patch(user,s=>({...s,lastRun:now,nextRun:now+s.intervalMinutes*60000,status:'scanning',lastImported:0,lastProposed:0,notice:'Searching for new or changed project files…'}));
 const allowed=async()=>{if(stopped||!(await read(user)).enabled)return false;const owner=await q.one<{role:string;status:string}>('SELECT role,status FROM users WHERE id=?',user);return owner?.role==='owner'&&owner.status==='active';};
 try{
  const structured = await import('../../discovery/service.js');
  let memoryCount=0,memoryFailed=0,denied=0,unavailable=0,skipped=0;
  const memoryHomes=new Set<string>([opts.home??os.homedir(),...((await read(user)).memoryHomes??[])]);
  const importedHomes=new Set<string>();
  const importMemory=async()=>{for(const home of memoryHomes){if(importedHomes.has(home)||!await allowed())continue;const result=await structured.importAutomaticMemoryFiles(user,home,allowed);memoryCount+=result.imported;memoryFailed+=result.failed;importedHomes.add(home);}};
  await importMemory();
  const previous=await latestImportJob(user);
  if(previous&&previous.done<previous.total){await patch(user,s=>({...s,status:'review',lastImported:memoryCount,lastProposed:memoryCount,notice:`${memoryCount} structured memory files saved. Project notes wait for the current import or local model; saved progress is retained.`}));return;}
  const saved=await read(user),known=await importedSessions(user),ids=new Set<string>((saved.pending??[]).filter(id=>!known.has(id)));let cursor=saved.cursor;
  if(!saved.scanningComplete)do{
   if(!await allowed())return;
   const page:ScanPage=opts.scan?await opts.scan(user,cursor):await scanProjectDocuments(user,{auto:true,purpose:'watch',...(opts.home?{home:opts.home}:{}),...(cursor?{cursor}:{})});
   for(const id of page.allDocumentIds??page.documents.map(doc=>doc.id))if(!known.has(id)&&!ids.has(id)&&await structured.automaticNoteSource(user,id,opts.home??os.homedir()))ids.add(id);
   for(const home of page.memoryHomes??[])memoryHomes.add(home);
   denied=page.deniedRoots??0;unavailable=page.unavailableRoots??0;skipped=page.skippedFiles??0;
   cursor=page.nextCursor??undefined;
   await patch(user,s=>({...s,cursor,pending:[...ids],scanningComplete:!cursor,memoryHomes:[...memoryHomes],lastImported:memoryCount,lastProposed:memoryCount,notice:`Searching accessible files: ${page.scanned??0} entries checked, ${ids.size} new project notes found, ${memoryCount} structured memory files saved.`}));
   await importMemory();
   await new Promise<void>(resolve=>setImmediate(resolve));
  }while(cursor);
  const pending=[] as string[];for(const id of ids)if(await structured.automaticNoteSource(user,id,opts.home??os.homedir()))pending.push(id);let count=memoryCount,proposed=memoryCount;
  for(let offset=0;offset<pending.length;offset+=400){
   if(!await allowed())return;
   await patch(user,s=>({...s,status:'importing',notice:`Importing new project files (${count}/${pending.length})…`}));
   let job=await startImport(user,pending.slice(offset,offset+400),{extract:opts.extract,home:opts.home,automatic:true});
   while(job.status==='running'){if(!await allowed())return;await new Promise<void>(r=>{setTimeout(r,opts.pollMs??1000);});job=(await getJob(user,job.id))!;}
   count+=job.done;proposed+=job.proposed;
   await patch(user,s=>({...s,lastImported:count,lastProposed:proposed}));
   if(job.status!=='done'){await patch(user,s=>({...s,status:'review',notice:'Project notes are waiting for the local model or saved import progress. Structured memory files need no model; check the current import to resume.'}));return;}
   if(await allowed())for(const id of pending.slice(offset,offset+400))await structured.automaticNoteSource(user,id,opts.home??os.homedir(),true);
   await patch(user,s=>({...s,pending:pending.slice(offset+400)}));
  }
  await patch(user,s=>({...s,status:'idle',cursor:undefined,pending:[],scanningComplete:false,memoryHomes:[],lastImported:count,lastProposed:proposed,notice:`Search complete. ${memoryCount} structured memory files saved; ${count-memoryCount} project notes processed by the local model.${denied?` ${denied} folders denied access.`:''}${unavailable?` ${unavailable} folders unavailable.`:''}${skipped||memoryFailed?` ${skipped+memoryFailed} unreadable or changed files skipped.`:''}`}));
 }catch{await patch(user,s=>({...s,status:'error',notice:'Automatic import could not finish. Saved progress is retained; retry or check the current import.'}));}
}
/** Explicit tick is testable with a clock and local fixtures; importing this module starts no work. */
export async function runDueAutomaticImports(opts:Options={}){
 let files:string[];try{files=await fs.readdir(folder());}catch(e:any){if(e.code==='ENOENT')return;throw e;}
 const jobs:Promise<void>[]=[];
 for(const name of files){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;const s=JSON.parse(await fs.readFile(path.join(folder(),name),'utf8')) as Saved;
  if(!s.enabled||(s.nextRun>(opts.now??Date.now())&&!['scanning','importing'].includes(s.status))||active.has(s.userId))continue;
  const promise=(async()=>{const owner=await q.one<{role:string;status:string}>('SELECT role,status FROM users WHERE id=?',s.userId);if(owner?.role==='owner'&&owner.status==='active')await run(s.userId,opts);})().finally(()=>active.delete(s.userId));active.set(s.userId,promise);jobs.push(promise);
 }
 await Promise.allSettled(jobs);
}
export function startAutomaticProjectImports(){if(timer)return;stopped=false;timer=setInterval(()=>{void runDueAutomaticImports().catch(()=>{});},15000);timer.unref();void runDueAutomaticImports().catch(()=>{});}
export async function stopAutomaticProjectImports(){stopped=true;clearInterval(timer);timer=undefined;await Promise.allSettled([...active.values()]);}
