'use strict';
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {pathToFileURL}=require('node:url');const {execFileSync}=require('node:child_process');
/** Follow the editor's token-to-cookie handshake without forwarding credentials off-origin. */
async function fetchCodeEntry(address, request=fetch){
 const origin=new URL(address).origin;let url=address,cookie='';
 for(let hop=0;hop<4;hop++){
  const response=await request(url,{redirect:'manual',headers:cookie?{cookie}:{},signal:AbortSignal.timeout(30000)});
  if(![301,302,303,307,308].includes(response.status))return response;
  const location=response.headers.get('location');const next=location&&new URL(location,url);
  if(!next||next.origin!==origin||next.username||next.password){await response.body?.cancel();throw Error('Code entry redirect escaped its local origin');}
  const cookies=response.headers.getSetCookie().map(value=>value.split(';',1)[0]);
  if(cookies.length)cookie=cookies.join('; ');
  await response.body?.cancel();url=next.href;
 }
 throw Error('Code entry exceeded redirect limit');
}
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
  const result=await host.start();const response=await fetchCodeEntry(result.url);const html=await response.text();
  if(!response.ok||!html.includes('workbench'))throw Error('Bundled Code web entry failed (HTTP '+response.status+')');
  return 'PASS: isolated bundled Code native modules, web entry and Open VSX configuration';
 }finally{await host?.stop();fs.rmSync(cwd,{recursive:true,force:true});}
}
module.exports={verifyCodeRuntime,fetchCodeEntry};
if(require.main===module)verifyCodeRuntime({runtime:path.resolve(process.argv[2]),node:process.execPath}).then(console.log).catch(error=>{console.error('Code verification failed: '+error.message);process.exitCode=1;});
