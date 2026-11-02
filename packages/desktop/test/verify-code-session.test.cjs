const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fetchCodeEntry}=require('../scripts/verify-code.cjs');
test('Code verifier carries its local token cookie through the clean-URL redirect',async()=>{
 const calls=[];
 const response=await fetchCodeEntry('http://127.0.0.1:43210/?tkn=synthetic',async(url,options)=>{
  calls.push({url,options});
  return calls.length===1?new Response(null,{status:302,headers:{location:'/', 'set-cookie':'vscode-tkn=synthetic; SameSite=Lax'}}):new Response('workbench');
 });
 assert.equal(await response.text(),'workbench');assert.equal(calls.length,2);
 assert.equal(calls[1].url,'http://127.0.0.1:43210/');assert.equal(calls[1].options.headers.cookie,'vscode-tkn=synthetic');
 assert.equal(calls[0].options.redirect,'manual');
});
test('Code verifier never forwards the session to another origin',async()=>{
 let calls=0;
 await assert.rejects(fetchCodeEntry('http://127.0.0.1:43210/?tkn=synthetic',async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://example.com/', 'set-cookie':'vscode-tkn=synthetic'}});}),/escaped its local origin/);
 assert.equal(calls,1);
});
test('Code verifier bounds redirect loops',async()=>{
 let calls=0;
 await assert.rejects(fetchCodeEntry('http://127.0.0.1:43210/',async()=>{calls++;return new Response(null,{status:302,headers:{location:'/'}});}),/redirect limit/);
 assert.equal(calls,4);
});
