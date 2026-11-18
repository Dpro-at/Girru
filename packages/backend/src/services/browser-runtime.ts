/** The optional Store engine runs only after owner activation; core keeps URL and tool policy. */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {dataPath} from '../config/data-root.js';
import {storeHostEnabled,storeHostStatus,storeHostRoot,markStoreHostStarted,retireStoreHostApp} from './store-host-apps.js';
import {safeConsole} from './safe-error-log.js';
import {checkBrowserUrl,guardPage} from '../browser/url-guard.js';
import type {BrowserController} from '../browser/controller-contract.js';
let controller:BrowserController|null=null,view:BrowserController|null=null,loading:Promise<BrowserController|null>|null=null,retired=false;
export function browserRuntimeReady(){return !!view&&browserRuntimeAllowed();}
export function browserRuntimeAllowed(){return !retired&&storeHostEnabled('browser');}
function check(){if(!browserRuntimeAllowed())throw Object.assign(Error('Add and enable Browser from the Store, then restart Girru.'),{statusCode:503,code:'app_not_enabled'});}
export function getBrowserController():BrowserController{check();if(!view)throw Object.assign(Error('Browser needs a restart.'),{statusCode:503,code:'app_not_enabled'});return view;}
export async function loadBrowserRuntime():Promise<BrowserController|null>{
 if(!browserRuntimeAllowed()||process.env.EXTENSIONS_DISABLED==='true')return null;
 if(view)return view;if(loading)return loading;
 loading=(async()=>{
  const root=storeHostRoot('browser'),status=await storeHostStatus('browser');if(!root||!status.ready||!browserRuntimeAllowed())return null;
  const host=Object.freeze({safeConsole:Object.freeze({...safeConsole}),checkBrowserUrl:(url:string)=>browserRuntimeAllowed()?checkBrowserUrl(url):Promise.resolve({ok:false as const,reason:'app_not_enabled'}),guardPage:(page:unknown,onBlocked?:(url:string,reason:string)=>void)=>guardPage(page,onBlocked,browserRuntimeAllowed),
   dataPathOr:(_fallback:string,namespace:string,kind:string)=>{check();if(namespace!=='browser'||!['screenshots','downloads'].includes(kind))throw Error('Browser storage is outside its scope.');return dataPath('browser',kind);},
   indexScreenshot:async(value:{filepath?:unknown;mimeType?:unknown;description?:unknown;tags?:unknown})=>{
    check();if(typeof value?.filepath!=='string')throw Error('Invalid screenshot.');const base=fs.realpathSync(dataPath('browser','screenshots')),file=fs.realpathSync(value.filepath),relative=path.relative(base,file);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!fs.statSync(file).isFile())throw Error('Screenshot is outside browser storage.');
    const {getStorageManager}=await import('./storage-manager.js');check();return getStorageManager().indexExistingFile({zone:'cache',category:'screenshots',filepath:file,filename:path.basename(file),mimeType:value.mimeType==='image/jpeg'?'image/jpeg':'image/png',description:typeof value.description==='string'?value.description.slice(0,1000):'Browser screenshot',tags:['screenshot','browser'],ttl:'session',createdBy:'agent'});
   },
   executablePath:()=>{check();const value=process.env.GIRRU_BROWSER_EXECUTABLE??'';if(!path.isAbsolute(value))throw Error('The browser executable must be an absolute operator-configured path.');const stat=fs.statSync(value);if(!stat.isFile())throw Error('The browser executable is unavailable.');return value;},
  });
  const module=await import(pathToFileURL(path.join(root,'index.js')).href);if(typeof module.loadBrowser!=='function')throw Error('Incompatible Browser app.');controller=await module.loadBrowser(host);
  if(!controller)throw Error('Browser engine is incomplete.');
  const target=controller;
  view=new Proxy(target,{get(object,key){const value=Reflect.get(object,key);if(typeof value!=='function')return value;return (...args:unknown[])=>{check();const result=Reflect.apply(value,object,args);if(result&&typeof (result as {then?:unknown}).then==='function')return Promise.resolve(result).then(async output=>{if(!browserRuntimeAllowed()){await target.cleanup();check();}return output;});return result;};}});
  check();markStoreHostStarted('browser');return view;
 })().catch(async()=>{loading=null;view=null;const failed=controller;controller=null;if(failed)try{await failed.cleanup();}catch{}safeConsole.warn('[Browser] Optional engine is unavailable. Add it again or restart after enabling.');return null;});return loading;
}
export async function stopBrowserRuntime(){retired=true;retireStoreHostApp('browser');const pending=loading;if(pending)await pending.catch(()=>null);const current=controller;view=null;if(current)try{await current.cleanup();}catch{safeConsole.warn('[Browser] Engine cleanup failed after retirement.');}}
