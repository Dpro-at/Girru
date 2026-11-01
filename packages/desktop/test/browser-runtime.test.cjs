'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createBrowserRuntime}=require('../src/browser-runtime.cjs');
test('desktop Browser attaches only to an embedded local runtime and never focuses a native Chrome window',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'girru-browser-host-')),profile=path.join(root,'profile'),calls=[];
 await fs.mkdir(path.join(root,'runtime'));await fs.writeFile(path.join(root,'runtime/package.json'),JSON.stringify({name:'@girru/browser'}));await fs.mkdir(path.join(profile,'connections'),{recursive:true});
 const server=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{assert.equal(req.headers.authorization,'Bearer '+'1'.repeat(64));calls.push(JSON.parse(Buffer.concat(chunks)).action);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({tabs:[{id:'tab'}]}));});});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});});
 const file=path.join(profile,'connections/owner-runtime.json'),value={schema:1,url:`http://127.0.0.1:${server.address().port}`,token:'1'.repeat(64),presentation:'standalone'};
 await fs.writeFile(file,JSON.stringify(value));const browser=createBrowserRuntime({root,node:process.execPath,profile});assert.deepEqual(await browser.status(),{available:true,running:false});assert.equal(calls.length,0);
 await fs.writeFile(file,JSON.stringify({...value,presentation:'embedded'}));assert.deepEqual(await browser.open(),{available:true,running:true});assert.ok(calls.every(x=>x==='state'));assert.doesNotMatch(JSON.stringify(await browser.status()),/token|connections|http/);
});
