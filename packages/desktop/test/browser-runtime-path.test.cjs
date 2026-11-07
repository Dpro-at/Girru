'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {resolveBrowserRuntime}=require('../src/browser-runtime-path.cjs');
test('full Browser appears after a reviewed current pointer is installed; links and incomplete versions refuse',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'girru-browser-pointer-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const base=path.join(root,'browser'),version='1.0.0',name=version+'-aabbccdd',runtime=path.join(base,name);
 assert.equal(resolveBrowserRuntime({runtimesDir:root}),null);
 for(const file of ['runtime/scripts/full-start.cjs','runtime/src/full-browser.cjs','runtime/node_modules/ws/package.json','runtime/node_modules/playwright/package.json','extension/manifest.json','native/GirruBrowser.app/Contents/MacOS/GirruBrowser']){const target=path.join(runtime,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'synthetic');}
 fs.writeFileSync(path.join(runtime,'runtime/package.json'),JSON.stringify({name:'@girru/browser'}));fs.writeFileSync(path.join(runtime,'browser-runtime.json'),JSON.stringify({protocolVersion:1,version,platform:'darwin-arm64'}));
 const pointer=path.join(base,'current.json'),value={version,dir:name,sha256:'a'.repeat(64)};fs.writeFileSync(pointer,JSON.stringify(value));
 assert.equal(resolveBrowserRuntime({runtimesDir:root,platform:'darwin-arm64'}).root,runtime);assert.equal(resolveBrowserRuntime({runtimesDir:root,platform:'linux-x64'}),null);
 fs.writeFileSync(pointer,JSON.stringify({...value,dir:'../escape'}));assert.equal(resolveBrowserRuntime({runtimesDir:root,platform:'darwin-arm64'}),null);
 fs.writeFileSync(pointer,JSON.stringify(value));fs.unlinkSync(path.join(runtime,'runtime/scripts/full-start.cjs'));assert.equal(resolveBrowserRuntime({runtimesDir:root,platform:'darwin-arm64'}),null);
 fs.unlinkSync(pointer);fs.symlinkSync(path.join(runtime,'browser-runtime.json'),pointer);assert.equal(resolveBrowserRuntime({runtimesDir:root,platform:'darwin-arm64'}),null);
});
