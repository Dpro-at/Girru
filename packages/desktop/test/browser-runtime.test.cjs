'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createBrowserRuntime}=require('../src/browser-runtime.cjs');
test('desktop Browser attaches only to an embedded local runtime and never focuses a native Chrome window',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'girru-browser-host-')),profile=path.join(root,'profile'),calls=[];
 await fs.mkdir(path.join(root,'runtime'));await fs.writeFile(path.join(root,'runtime/package.json'),JSON.stringify({name:'@girru/browser'}));await fs.mkdir(path.join(root,'runtime/scripts'),{recursive:true});await fs.writeFile(path.join(root,'runtime/scripts/full-start.cjs'),'');await fs.mkdir(path.join(profile,'connections'),{recursive:true});
 const server=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{assert.equal(req.headers.authorization,'Bearer '+'1'.repeat(64));calls.push(JSON.parse(Buffer.concat(chunks)).action);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({tabs:[{id:'tab'}]}));});});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});});
 await fs.mkdir(path.join(root,'runtime/scripts'),{recursive:true});await fs.writeFile(path.join(root,'runtime/package.json'),JSON.stringify({name:'@girru/browser'}));await fs.writeFile(path.join(root,'runtime/scripts/full-start.cjs'),'');
 const file=path.join(profile,'connections/owner-runtime.json'),value={schema:1,url:`http://127.0.0.1:${server.address().port}`,token:'1'.repeat(64),presentation:'standalone'};
 await fs.writeFile(file,JSON.stringify(value));const browser=createBrowserRuntime({root,node:process.execPath,profile});assert.deepEqual(await browser.status(),{available:true,running:false});assert.equal(calls.length,0);
 await fs.writeFile(file,JSON.stringify({...value,presentation:'embedded'}));assert.deepEqual(await browser.open(),{available:true,running:true});assert.ok(calls.every(x=>x==='state'));assert.doesNotMatch(JSON.stringify(await browser.status()),/token|connections|http/);
});
test('desktop Browser rejects oversized connection files and refuses redirects',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'girru-browser-redirect-')),profile=path.join(root,'profile');await fs.mkdir(path.join(profile,'connections'),{recursive:true});let received=0;
 const destination=http.createServer((_,res)=>{received++;res.end('{}');});await new Promise(r=>destination.listen(0,'127.0.0.1',r));
 const source=http.createServer((_,res)=>{res.writeHead(307,{Location:`http://127.0.0.1:${destination.address().port}/other`});res.end();});await new Promise(r=>source.listen(0,'127.0.0.1',r));
 t.after(async()=>{source.closeAllConnections();destination.closeAllConnections();await Promise.all([new Promise(r=>source.close(r)),new Promise(r=>destination.close(r))]);await fs.rm(root,{recursive:true,force:true});});
 await fs.mkdir(path.join(root,'runtime/scripts'),{recursive:true});await fs.writeFile(path.join(root,'runtime/package.json'),JSON.stringify({name:'@girru/browser'}));await fs.writeFile(path.join(root,'runtime/scripts/full-start.cjs'),'');
 const file=path.join(profile,'connections/owner-runtime.json'),value={url:`http://127.0.0.1:${source.address().port}`,token:'2'.repeat(64),presentation:'embedded'},browser=createBrowserRuntime({root,node:process.execPath,profile});
 await fs.writeFile(file,JSON.stringify({...value,padding:'x'.repeat(4096)}));await assert.rejects(browser.command({action:'state'}),/Invalid browser connection/);
 await fs.writeFile(file,JSON.stringify(value));await assert.rejects(browser.command({action:'state'}));assert.equal(received,0);
 for(const url of ['http://127.0.0.1:0','http://127.0.0.1:99999','https://external.example']){await fs.writeFile(file,JSON.stringify({...value,url}));await assert.rejects(browser.command({action:'state'}),/Invalid browser connection/);}
});

test('closing waits for the owned launcher so reopen cannot attach to its dying connection',{skip:process.platform==='win32'&&'POSIX signals: Windows stops the launcher at once'},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'girru-browser-close-')),profile=path.join(root,'profile');
 await fs.mkdir(path.join(root,'runtime/scripts'),{recursive:true});
 await fs.writeFile(path.join(root,'runtime/package.json'),JSON.stringify({name:'@girru/browser'}));
 await fs.writeFile(path.join(root,'runtime/scripts/full-start.cjs'),`
 const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
 const profile=process.env.GIRRU_BROWSER_PROFILE,dir=path.join(profile,'connections');fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'owner-runtime.json');
 const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>res.end(JSON.stringify({tabs:[]})));});
 server.listen(0,'127.0.0.1',()=>fs.writeFileSync(file,JSON.stringify({presentation:'embedded',url:'http://127.0.0.1:'+server.address().port,token:'3'.repeat(64)})));
 process.on('SIGTERM',()=>setTimeout(()=>{fs.unlinkSync(file);fs.writeFileSync(path.join(profile,'closed'),String(process.pid));server.closeAllConnections();server.close(()=>process.exit(0));},150));
 `);
 const browser=createBrowserRuntime({root,node:process.execPath,profile});
 t.after(async()=>{await browser.close();await fs.rm(root,{recursive:true,force:true});});
 for(let round=0;round<2;round++){
  assert.equal((await browser.open()).running,true);await browser.close();
  await assert.rejects(fs.access(path.join(profile,'connections/owner-runtime.json')));
  const pid=Number(await fs.readFile(path.join(profile,'closed'),'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 }
});
