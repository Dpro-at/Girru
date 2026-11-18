'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {validateInstalledClient,protectedGoogleLogin}=require('../src/google-client-config.cjs');
const clientId='281410907967-kaljlvtllp3kleqfp07j1v7ri68hdun6.apps.googleusercontent.com';
const fixture={installed:{client_id:clientId,client_secret:'synthetic_client_secret_only',auth_uri:'https://accounts.google.com/o/oauth2/auth',token_uri:'https://oauth2.googleapis.com/token'}};
test('installed client is bound to expected public identity and Google endpoints',()=>{
 assert.equal(validateInstalledClient(fixture,clientId).clientId,clientId);
 assert.throws(()=>validateInstalledClient(fixture,'other.apps.googleusercontent.com'));
 assert.throws(()=>validateInstalledClient({installed:{...fixture.installed,token_uri:'https://attacker.invalid'}},clientId));
});
test('host selection persists privately and only native login receives secret',async()=>{
 const state={};let selected=0,called=0;const custody={read:async fn=>fn(state),transact:async fn=>fn(state)};
 const login=protectedGoogleLogin({custody,selectInstalledClient:async()=>{selected++;return validateInstalledClient(fixture,clientId);},login:async options=>{called++;assert.equal(options.clientSecret,fixture.installed.client_secret);return {verified:true};}});
 assert.deepEqual(await login({clientId}),{verified:true});await login({clientId});assert.equal(selected,1);assert.equal(called,2);assert.equal(state.publicConfig,undefined);
});
test('cancelled host selection never opens login or writes config',async()=>{
 const login=protectedGoogleLogin({custody:{read:async()=>null,transact:async()=>assert.fail()},selectInstalledClient:async()=>null,login:async()=>assert.fail()});
 await assert.rejects(login({clientId}),/configuration_cancelled/);
});

test('already cancelled sign-in does not read custody or select a credential',async()=>{
 const controller=new AbortController();controller.abort();
 const login=protectedGoogleLogin({custody:{read:async()=>assert.fail()},login:async()=>assert.fail(),selectInstalledClient:async()=>assert.fail()});
 await assert.rejects(login({clientId,signal:controller.signal}),/login_cancelled/);
});
test('cancellation before protected commit refuses persistence and login',async()=>{
 const controller=new AbortController();let committed=false;
 const login=protectedGoogleLogin({custody:{read:async()=>null,transact:async(fn,beforeCommit)=>{const state={};fn(state);controller.abort();beforeCommit();committed=true;}},selectInstalledClient:async()=>validateInstalledClient(fixture,clientId),login:async()=>assert.fail()});
 await assert.rejects(login({clientId,signal:controller.signal}),/login_cancelled/);assert.equal(committed,false);
});
test('native file import rejects oversized, malformed and symlink credentials',async t=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
 const {readInstalledClient}=require('../src/google-client-config.cjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dpro-google-config-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,'client.json');await fs.writeFile(file,JSON.stringify(fixture));
 assert.equal((await readInstalledClient(file,clientId)).clientId,clientId);
 await fs.symlink(file,path.join(root,'link.json'));await assert.rejects(readInstalledClient(path.join(root,'link.json'),clientId));
 await fs.writeFile(file,'x'.repeat(16385));await assert.rejects(readInstalledClient(file,clientId));
 await fs.writeFile(file,'{}');await assert.rejects(readInstalledClient(file,clientId));
});

const {serverGoogleExchange}=require('../src/google-client-config.cjs');

test('client import checks the opened file before reading and refuses a replaced pathname',async t=>{
 const fs=require('node:fs');
 const {readInstalledClient}=require('../src/google-client-config.cjs');
 const events=[];let replaced=false;
 const stat={ino:1,dev:1,size:JSON.stringify(fixture).length,isFile:()=>true,isSymbolicLink:()=>false};
 t.mock.method(fs.promises,'open',async()=>{events.push('open');return {
   stat:async()=>{events.push('fstat');return stat;},
   read:async(buffer,offset,length,position)=>{events.push('read');const bytes=Buffer.from(JSON.stringify(fixture));const n=Math.min(length,Math.max(0,bytes.length-position));bytes.copy(buffer,offset,position,position+n);return {bytesRead:n};},
   close:async()=>events.push('close'),
 };});
 t.mock.method(fs.promises,'lstat',async()=>{events.push('lstat');return {...stat,ino:replaced?2:1};});
 assert.equal((await readInstalledClient('synthetic.json',clientId)).clientId,clientId);
 assert.deepEqual(events.slice(0,4),['open','fstat','lstat','read']);
 assert.equal(events.at(-1),'close');
 events.length=0;replaced=true;
 await assert.rejects(readInstalledClient('synthetic.json',clientId),/installed_client_invalid/);
 assert.deepEqual(events,['open','fstat','lstat','close']);
});

test('with a configured account service, Google sign-in needs no client file: the service finishes it',async()=>{
 const sent=[];const fetcher=async(url,init)=>{const body=JSON.parse(init.body);sent.push({url,body});if(!Object.keys(body).length)return {status:403,text:async()=>JSON.stringify({code:'account_input_invalid'})};return {status:200,text:async()=>JSON.stringify({idToken:'a.b.c'})};};
 const server=serverGoogleExchange('https://relay.example.test/identity/v1',fetcher);
 let picked=0;const login=protectedGoogleLogin({custody:{read:async()=>null,transact:async()=>assert.fail('nothing is stored')},selectInstalledClient:async()=>{picked++;return null;},server,login:async options=>{assert.equal(options.clientSecret,undefined);assert.equal(await options.exchange({code:'c'.repeat(12),codeVerifier:'v'.repeat(43),redirectUri:'http://127.0.0.1:5/oauth/device'}),'a.b.c');return 'signed-in';}});
 assert.equal(await login({clientId:'123-abc.apps.googleusercontent.com'}),'signed-in');
 assert.equal(picked,0);
 assert.equal(sent[1].url,'https://relay.example.test/identity/v1/google/token');
 assert.deepEqual(Object.keys(sent[1].body).sort(),['code','codeVerifier','redirectUri']);
});
test('a service without the secret (or an older one) falls back to the file, and odd origins are never used',async()=>{
 const off=serverGoogleExchange('https://relay.example.test/identity/v1',async()=>({status:403,text:async()=>JSON.stringify({code:'account_google_exchange_unavailable'})}));
 assert.equal(await off.available(),false);
 const old=serverGoogleExchange('https://relay.example.test/identity/v1',async()=>({status:404,text:async()=>JSON.stringify({code:'account_route_unavailable'})}));
 assert.equal(await old.available(),false);
 for(const bad of ['http://relay.example.test/identity/v1','file:///etc','not a url','https://relay.example.test/identity/v1?x=1'])assert.equal(serverGoogleExchange(bad),null);
 const refused=serverGoogleExchange('https://relay.example.test/identity/v1',async()=>({status:200,text:async()=>JSON.stringify({idToken:'a.b.c',access_token:'x'})}));
 await assert.rejects(()=>refused.exchange({}),/device_google_server_exchange_refused/);
});
