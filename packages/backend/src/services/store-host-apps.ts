/** Lifecycle metadata for optional reviewed apps; it never grants agent or paper authority. */
import fs from 'node:fs';import path from 'node:path';
import type Database from 'better-sqlite3';
import {dbDriver} from '../db/pg/config.js';
import {installedAppDir} from '../config/backend-root.js';import {getDatabase} from '../db/index.js';
import {reviewedChannelReceipt} from './channel-runtime.js';import {readRegularFile} from './read-regular-file.js';import {parseRuntimePackages} from './store-package-runtime.js';
export const STORE_HOST_APPS=['call-center','trading','browser'] as const;
export type StoreHostApp=typeof STORE_HOST_APPS[number];
const retired=new Set<StoreHostApp>(),started=new Map<StoreHostApp,string>();
export function markStoreHostStarted(id:StoreHostApp){const root=storeHostRoot(id);if(root)started.set(id,root);}
export function storeHostApp(value:string):value is StoreHostApp{return (STORE_HOST_APPS as readonly string[]).includes(value);}
export function storeHostRoot(id:StoreHostApp){const v=(process.env[`GIRRU_${id.replace(/-/g,'_').toUpperCase()}_APP_DIR`]??'').trim();return path.isAbsolute(v)?v:installedAppDir(id);}
const overridden=(id:StoreHostApp)=>path.isAbsolute((process.env[`GIRRU_${id.replace(/-/g,'_').toUpperCase()}_APP_DIR`]??'').trim());
export function retireStoreHostApp(id:StoreHostApp){retired.add(id);}
export function storeHostEnabled(id:StoreHostApp,db?:Database.Database):boolean{
 const root=storeHostRoot(id);if(retired.has(id)||!root||!fs.existsSync(path.join(root,'index.js')))return false;
 if(dbDriver()!=='sqlite')return false;
 if(overridden(id)){try{const row=(db??getDatabase().getDb()).prepare('SELECT enabled FROM extension_configs WHERE extension_id=?').get(id) as {enabled?:number}|undefined;return !row||row.enabled===1;}catch{return false;}}
 const handle=db??getDatabase().getDb();
 try{const receipt=(handle.prepare('SELECT value FROM app_settings WHERE key=?').get('store.installed.'+id) as {value?:unknown}|undefined)?.value;const c=handle.prepare('SELECT enabled FROM extension_configs WHERE extension_id=?').get(id) as {enabled?:number}|undefined;return c?.enabled===1&&reviewedChannelReceipt(receipt);}catch{return false;}
}
export async function storeHostStatus(id:StoreHostApp){
 const root=storeHostRoot(id);if(!root)return {id,installed:false,enabled:false,ready:false,clientHash:null,needsRestart:false};
 if(dbDriver()!=='sqlite')return {id,installed:false,enabled:false,ready:false,clientHash:null,needsRestart:false};
 const db=getDatabase().getDb();let receipt:any=null,enabled=false,reviewed=overridden(id);
 try{const value=overridden(id)?undefined:(db.prepare('SELECT value FROM app_settings WHERE key=?').get('store.installed.'+id) as {value?:string}|undefined)?.value;
  if(!overridden(id)&&!reviewedChannelReceipt(value))return {id,installed:false,enabled:false,ready:false,clientHash:null,needsRestart:false};
  reviewed=true;receipt=value?JSON.parse(value):null;enabled=overridden(id)?storeHostEnabled(id,db):((db.prepare('SELECT enabled FROM extension_configs WHERE extension_id=?').get(id) as {enabled?:number}|undefined)?.enabled===1);
  const bytes=(await readRegularFile(path.join(root,'app-host.npm'),128*1024,{root})).data,descriptor=JSON.parse(bytes.toString('utf8'));
  if(descriptor.schema!==1||descriptor.host!==id||descriptor.protocolVersion!==1)throw Error('Incompatible app host.');
  if(descriptor.packages)for(const p of parseRuntimePackages(bytes)){const meta=JSON.parse((await readRegularFile(path.join(root,...p.path.split('/'),'package.json'),65536,{root})).data.toString('utf8'));if(meta.name!==p.name||meta.version!==p.version)throw Error('Incomplete app runtime.');}
  const marker=overridden(id)&&!fs.existsSync(path.join(root,'.girru-store.json'))?null:JSON.parse((await readRegularFile(path.join(root,'.girru-store.json'),128*1024,{root})).data.toString('utf8'));
  if(!overridden(id)&&(!marker||marker.source!=='store'||marker.id!==id||marker.packageSha256!==receipt.packageSha256))throw Error('App receipt changed.');
  const client=marker?.files?.find((f:any)=>f.path==='client.js');const hash=client&&/^[a-f0-9]{64}$/.test(client.sha256)?client.sha256:null;
  return {id,installed:true,enabled,ready:fs.existsSync(path.join(root,'index.js')),clientHash:hash,needsRestart:enabled&&(retired.has(id)||started.get(id)!==root)};
 }catch{return {id,installed:reviewed,enabled,ready:false,clientHash:null,needsRestart:false};}
}
