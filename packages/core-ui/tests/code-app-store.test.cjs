require('./load.cjs');const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {workspaceAppsResponse}=require('../src/apps-contract.js');const {builtinApps,tileActions}=require('../src/WorkspaceApplications.tsx');
const code={id:'code',name:'Code',kind:'builtin',version:null,summary:'The project editor beside your chats, in the Girru desktop app.',state:'included',sourceId:null,permissions:['Opens only in the Girru desktop app that has the editor'],tools:0,removable:false};
test('Code comes from the server app list like Terminal, Trading and GenVR',()=>{
 assert.deepEqual(workspaceAppsResponse(200,{items:[code]}).items.map(x=>x.id),['code']);
 assert.throws(()=>workspaceAppsResponse(200,{items:[{...code,kind:'api'}]}));assert.throws(()=>workspaceAppsResponse(200,{items:[{...code,sourceId:'code'}]}));
 const src=fs.readFileSync(path.join(__dirname,'../src/WorkspaceApplications.tsx'),'utf8');assert.doesNotMatch(src,/codeApp/,'no second client-only Code tile');
});
test('Store › Made by Girru lists the apps that come with Girru, Code included',()=>{
 assert.deepEqual(builtinApps.map(x=>x.id).sort(),['code','genvr','terminal','trading']);
 const ws=fs.readFileSync(path.join(__dirname,'../src/AppsWorkspace.tsx'),'utf8');assert.match(fs.readFileSync(path.join(__dirname,'../../backend/src/services/store-catalogue.ts'),'utf8'),/id:'girru:code'/);assert.match(fs.readFileSync(path.join(__dirname,'../src/SignedInShell.tsx'),'utf8'),/onOpenApp=\{id=>\{if\(id==='browser'\)setPage\('browser'\);else if\(id==='code'\)void \(nativeEditor\?openCode\(\):openCodeInStore\(\)\);else if\(id==='terminal'\)openTerminal\(\);else setPage\(id\);\}\}/);
});
test('without the desktop editor, Open Code is shown but disabled',()=>{
 const h={open(){},onAccountConnections(){},onPermissions(){}};
 assert.equal(tileActions(code,{owner:true},{...h,canOpen:false})[0].disabled,true);assert.equal(tileActions(code,{owner:true},{...h,canOpen:true})[0].disabled,false);
});

test('Terminal opens beside the chat in one click from the footer, ⌘K and My apps; its SSH hosts stay in ⌘K', () => {
 const shell=fs.readFileSync(path.join(__dirname,'../src/SignedInShell.tsx'),'utf8');
 assert.match(shell,/terminal:entry\('terminal',owner,openTerminal,undefined,'store'\)/);
 assert.match(shell,/\{id:'terminal',label:'Terminal',icon:<UiIcon name="terminal" size=\{14\}\/>,run:openTerminal\}/);
 assert.match(shell,/label:'Terminal › Saved SSH hosts'[^\n]*?run:\(\)=>setPage\('terminal'\)/);
 assert.doesNotMatch(shell,/terminal:entry\('terminal',owner,go\('terminal'\)/);
});

// CODE-STORE-01: Code is a Store app. While the desktop app has none, the footer, ⌘K, My apps and
// Open in Code all lead to Code's page in the existing Store (Get, then the usual steps); no new screen.
test('a missing Code leads to its Store page from the footer, ⌘K, My apps and Open in Code',()=>{
 const shell=fs.readFileSync(path.join(__dirname,'../src/SignedInShell.tsx'),'utf8');
 assert.match(shell,/code:entry\('code',owner&&\(nativeEditor\|\|codeMissing\),nativeEditor\?openCode:openCodeInStore,undefined,'store'\)/);
 assert.match(shell,/nativeEditor\|\|codeMissing\?\[\{id:'code',label:'Code',icon:<UiIcon name="code" size=\{14\}\/>,run:nativeEditor\?openCode:openCodeInStore\}\]/);
 assert.match(shell,/setStoreRequest\(r=>\(\{updates:false,item:'girru:code',n:\(r\?\.n\?\?0\)\+1\}\)\);setPage\('store'\)/);
 assert.match(shell,/setCodeInstall\(codeOwner&&codeMissing\?\(\)=>openCodeInStore\(\):null\)/);
 const store=fs.readFileSync(path.join(__dirname,'../src/StoreView.tsx'),'utf8');
 assert.match(store,/if\(request\?\.item\)\{[^}]*\}\)\);setQuery\(''\);setPage\(request\.item\);\}/);
 const apps=fs.readFileSync(path.join(__dirname,'../src/WorkspaceApplications.tsx'),'utf8');
 assert.match(apps,/app\.id==='code'&&codeMissing\?'Not installed'/);assert.match(apps,/'Get Code'/);
});

test('Open in Code without Code installed opens its Store page; the bridge state carries where Code comes from',async()=>{
 require('./load.cjs');
 const co=require('../src/code-open.ts'),{validWorkspaceState}=require('../src/workspace-modes.ts');
 const client={request:async()=>({status:200,body:{path:'/p/a.ts',folder:'/p',file:'a.ts',line:3,generated:false}})};
 let opened=0;co.setCodeHost(null,false);co.setCodeInstall(()=>{opened++;});
 assert.equal(co.codeOffered(),true);
 assert.equal(await co.openInCode(client,'/p/a.ts',3),'store');assert.equal(opened,1);
 assert.match(co.codeOpenNotice('store'),/not installed yet/);
 co.setCodeInstall(null);assert.equal(co.codeOffered(),false);
 for(const runtime of [undefined,'bundled','store','missing'])assert.equal(validWorkspaceState({available:false,mode:'chat',busy:false,error:null,...(runtime?{runtime}:{})}),true,String(runtime));
 assert.equal(validWorkspaceState({available:false,mode:'chat',busy:false,error:null,runtime:'web'}),false);
});
