require('./load.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict');
const {updateNoticeText}=require('../src/AppUpdateNotice.tsx');
const base={version:'1.0',checkedAt:null,busy:null,error:null,update:{version:'1.1',publishedAt:null,notes:'New',page:'https://example.test',canInstall:true}};
test('update notice is absent without a release and keeps actionable failures and progress visible',()=>{
 assert.equal(updateNoticeText(null),null);
 assert.equal(updateNoticeText({...base,update:null}),null);
 assert.equal(updateNoticeText(base),'Girru 1.1 is available');
 for(const busy of ['checking','downloading','backing-up','installing'])assert.ok(updateNoticeText({...base,busy}));
 assert.equal(updateNoticeText({...base,error:'failed'}),'Update needs attention');
});

test('the top bar shows an Update button only when a new Girru is ready (Mohamed), not in the status bar',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const React=require('../node_modules/react'),{renderToStaticMarkup}=require('../node_modules/react-dom/server'),{AppUpdateNotice}=require('../src/AppUpdateNotice.tsx');
 // Server rendering shows the first state (nothing yet): the button appears only after the app reports an update.
 assert.equal(renderToStaticMarkup(React.createElement(AppUpdateNotice,{onOpen(){},bridge:{onState(){return()=>{};},state:()=>Promise.resolve(base)}})),'');
 const shell=fs.readFileSync(path.join(__dirname,'../src/SignedInShell.tsx'),'utf8'),notice=fs.readFileSync(path.join(__dirname,'../src/AppUpdateNotice.tsx'),'utf8');
 assert.ok(shell.includes("{owner && mode === 'live' && <AppUpdateNotice onOpen={()=>openSettings('about')}/>}\n      <div className=\"titlebar-tools end\" ref={setTitleSlot}/>"));
 assert.equal(shell.split('<AppUpdateNotice').length,2,'one place only');
 assert.ok(notice.includes("view?.error?'Update needs attention':'Update'"));
 assert.ok(notice.includes("if(view?.update?.canInstall&&!view.busy&&!view.error&&bridge)void bridge.install()"),'Update starts the update at once');
});
