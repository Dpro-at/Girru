'use strict';
const fs=require('node:fs'),path=require('node:path');
const DIR=/^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?-[a-f0-9]{8}$/;
function regular(root,rel,max){let at=root;for(const part of rel.split('/')){at=path.join(at,part);if(fs.lstatSync(at).isSymbolicLink())throw Error('Linked Browser file');}const stat=fs.statSync(at);if(!stat.isFile()||max!==undefined&&stat.size>max)throw Error('Incomplete Browser runtime');return at;}
function complete(root,version,platform=process.platform+'-'+process.arch){try{
 if(!root||!path.isAbsolute(root)||!fs.lstatSync(root).isDirectory()||fs.lstatSync(root).isSymbolicLink())return false;
 const d=JSON.parse(fs.readFileSync(regular(root,'browser-runtime.json',4096),'utf8'));
 if(d.protocolVersion!==1||d.version!==version||d.platform!==platform)return false;
 const executable=platform.startsWith('darwin-')?'native/GirruBrowser.app/Contents/MacOS/GirruBrowser':platform==='linux-x64'?'native/girru-browser':platform==='win32-x64'?'native/GirruBrowser.exe':null;if(!executable)return false;
 for(const rel of ['runtime/scripts/full-start.cjs','runtime/src/full-browser.cjs','extension/manifest.json','runtime/node_modules/ws/package.json','runtime/node_modules/playwright/package.json',executable])regular(root,rel);
 return JSON.parse(fs.readFileSync(regular(root,'runtime/package.json',65536),'utf8')).name==='@girru/browser';
 }catch{return false;}}
function development(root){try{return root&&path.isAbsolute(root)&&JSON.parse(fs.readFileSync(regular(root,'runtime/package.json',65536),'utf8')).name==='@girru/browser'&&!!regular(root,'runtime/scripts/full-start.cjs');}catch{return false;}}
function resolveBrowserRuntime({root,bundled,runtimesDir,platform}){
 if(development(root))return{root,source:'development'};
 if(!runtimesDir||!path.isAbsolute(runtimesDir))return development(bundled)?{root:bundled,source:'bundled'}:null;
 try{
  const base=path.join(runtimesDir,'browser');for(const at of [runtimesDir,base])if(!fs.lstatSync(at).isDirectory()||fs.lstatSync(at).isSymbolicLink())return null;
  const file=regular(base,'current.json',4096),fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));let value;
  try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>4096)return null;value=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
  if(typeof value.version!=='string'||typeof value.dir!=='string'||!DIR.test(value.dir)||!value.dir.startsWith(value.version+'-')||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256))return null;
  const found=path.join(base,value.dir);if(complete(found,value.version,platform))return{root:found,source:'store',version:value.version,executable:path.join(found,(platform||process.platform+'-'+process.arch).startsWith('darwin-')?'native/GirruBrowser.app/Contents/MacOS/GirruBrowser':(platform||process.platform+'-'+process.arch)==='win32-x64'?'native/GirruBrowser.exe':'native/girru-browser')};
 }catch{/* Incomplete or removed pointers never make Browser available. */}
 if(development(bundled))return{root:bundled,source:'bundled'};return null;
}
module.exports={resolveBrowserRuntime,complete};
