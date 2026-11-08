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
