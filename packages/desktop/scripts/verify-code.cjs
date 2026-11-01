'use strict';
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {pathToFileURL}=require('node:url');const {execFileSync}=require('node:child_process');
/** Exercise the exact staged editor with bundled Node, outside either source checkout. */
async function verifyCodeRuntime({runtime,node}){
 const root=fs.realpathSync(runtime);
 for(const name of ['nabu/runtime.json','nabu/dpro/editor-runtime.mjs','editor/out/server-main.js','editor/out/vs/workbench/browser/girruStatusbar.js','editor/LICENSE.txt','editor/ThirdPartyNotices.txt'])if(!fs.statSync(path.join(root,name)).isFile())throw Error('Code runtime is incomplete: '+name);
 const product=JSON.parse(fs.readFileSync(path.join(root,'editor/product.json'),'utf8'));if(product.extensionsGallery?.serviceUrl!=='https://open-vsx.org/vscode/gallery')throw Error('Code extension gallery missing');
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'girru-code-package-'));let host;
 try{
  const env={PATH:process.env.PATH,HOME:cwd,USERPROFILE:cwd,SystemRoot:process.env.SystemRoot,TMPDIR:cwd,TEMP:cwd,TMP:cwd};
  execFileSync(node,['-e',`const r=require('node:module').createRequire(process.argv[1]);for(const name of ['@parcel/watcher','@vscode/spdlog','@vscode/sqlite3','node-pty'])r(name);console.log('Native Code modules loaded');`,path.join(root,'editor/remote/package.json')],{cwd,env,encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']});
  const factory=await import(pathToFileURL(path.join(root,'nabu/dpro/editor-runtime.mjs')).href);
  host=factory.createEditorHost({node,dataDir:path.join(cwd,'profile'),runtimeRoot:root});
  const result=await host.start();const response=await fetch(result.url,{signal:AbortSignal.timeout(30000)});const html=await response.text();
  if(!response.ok||!html.includes('workbench'))throw Error('Bundled Code web entry failed');
  return 'PASS: isolated bundled Code native modules, web entry and Open VSX configuration';
 }finally{await host?.stop();fs.rmSync(cwd,{recursive:true,force:true});}
}
module.exports={verifyCodeRuntime};
if(require.main===module)verifyCodeRuntime({runtime:path.resolve(process.argv[2]),node:process.execPath}).then(console.log).catch(error=>{console.error('Code verification failed: '+error.message);process.exitCode=1;});
