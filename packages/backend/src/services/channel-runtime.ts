/** Locate the reviewed optional package without importing a disabled app. */
import type {Database} from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {installedAppDir} from '../config/backend-root.js';
import {readRegularFile} from './read-regular-file.js';
import {registerChannelLibrary} from '../../extensions/shared/channel-library.js';
const override=()=>{const value=(process.env.GIRRU_CHANNELS_RUNTIME_DIR??'').trim();return path.isAbsolute(value)?value:null;};
const root=()=>override()??installedAppDir('agent-connect');
export function reviewedChannelReceipt(value:unknown):boolean{
 try{const data=JSON.parse(typeof value==='string'?value:'null');return !!data&&(data.source===undefined||data.source==='store')&&typeof data.packageSha256==='string'&&/^[a-f0-9]{64}$/.test(data.packageSha256);}catch{return false;}
}
export function channelHostCapabilityAllowed(db:Database,extensionDir:string):boolean{
 const app=root();if(!app)return false;
 if(override())return fs.existsSync(path.join(app,'node_modules/agent-connect-dpro/package.json'));
 if(path.resolve(extensionDir)!==path.resolve(app))return false;
 try{return reviewedChannelReceipt((db.prepare('SELECT value FROM app_settings WHERE key=?').get('store.installed.agent-connect') as {value?:unknown}|undefined)?.value);}catch{return false;}
}
export async function channelRuntimeStatus(){
 const app=root();if(!app)return {installed:false,ready:false};
 let approved=!!override();
 if(!approved){try{const {q}=await import('../repositories/sql-steps.js');approved=reviewedChannelReceipt((await q.one<{value:string}>('SELECT value FROM app_settings WHERE key=?','store.installed.agent-connect'))?.value);}catch{/* A missing receipt never grants access to a private app. */}}
 if(!approved)return {installed:false,ready:false};
 try{
  if(!override()){
   const descriptor=(await readRegularFile(path.join(app,'runtime-packages.npm'),128*1024)).data;
   const {parseRuntimePackages}=await import('./store-package-runtime.js');
   for(const item of parseRuntimePackages(descriptor)){
    const pkg=JSON.parse((await readRegularFile(path.join(app,...item.path.split('/'),'package.json'),65536)).data.toString('utf8'));
    if(pkg.name!==item.name||pkg.version!==item.version)throw Error('Incomplete channel runtime.');
   }
  }
  const pkg=JSON.parse((await readRegularFile(path.join(app,'node_modules/agent-connect-dpro/package.json'),65536)).data.toString('utf8'));
  const entry=path.join(app,'node_modules/agent-connect-dpro/dist/index.js');
  return {installed:true,ready:pkg.name==='agent-connect-dpro'&&pkg.version==='0.2.0'&&pkg.exports?.['.']?.import==='./dist/index.js'&&fs.existsSync(entry)};
 }catch{return {installed:true,ready:false};}
}
/** Only the enabled, reviewed app receives this loader through its host capability. */
export async function loadChannelLibrary(){
 const status=await channelRuntimeStatus(),app=root();if(!status.ready||!app)throw Error('Agent Connect needs to be added from the Store.');
 const entry=path.join(app,'node_modules/agent-connect-dpro/dist/index.js');
 const sdk=await import(pathToFileURL(entry).href);registerChannelLibrary(sdk,()=>fs.existsSync(entry));return sdk;
}
