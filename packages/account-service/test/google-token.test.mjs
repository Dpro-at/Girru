// The server finishes desktop Google sign-in so no app needs a Google client file. Google is a fake here.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
process.env.NODE_ENV='test';
const {exchangeGoogleCode,googleClientSecretOf,googleTokenInputOk}=await import('../src/google-token.ts'),{listenAccountService}=await import('../src/server.ts');
const input={code:'4/0AbCdEf-ghIJ_kl',codeVerifier:'v'.repeat(43),redirectUri:'http://127.0.0.1:53111/oauth/device'};
const idToken='aaa.bbb.ccc';
const fakeGoogle=(seen=[])=>async(url,init)=>{seen.push({url,body:new URLSearchParams(init.body)});return {ok:true,status:200,text:async()=>JSON.stringify({id_token:idToken,access_token:'must-not-leave',refresh_token:'must-not-leave'})};};

test('only the ID token comes back; the secret goes only to Google, with the PKCE verifier and loopback redirect',async()=>{
 const seen=[];const r=await exchangeGoogleCode(input,{clientId:'id.apps.googleusercontent.com',clientSecret:'s'.repeat(24),fetcher:fakeGoogle(seen)});
 assert.deepEqual(r,{idToken});
 assert.equal(seen[0].url,'https://oauth2.googleapis.com/token');
 assert.equal(seen[0].body.get('client_secret'),'s'.repeat(24));assert.equal(seen[0].body.get('code_verifier'),input.codeVerifier);assert.equal(seen[0].body.get('redirect_uri'),input.redirectUri);assert.equal(seen[0].body.get('grant_type'),'authorization_code');
});

test('refuses without a configured secret, odd fields, other redirects, and Google errors',async()=>{
 await assert.rejects(()=>exchangeGoogleCode(input,{clientId:'x',clientSecret:null}),/account_google_exchange_unavailable/);
 for(const bad of [{...input,extra:1},{...input,redirectUri:'http://evil.example/oauth/device'},{...input,redirectUri:'http://127.0.0.1:99999/oauth/device'},{...input,codeVerifier:'short'},{code:input.code}])assert.equal(googleTokenInputOk(bad),false);
 await assert.rejects(()=>exchangeGoogleCode({...input,redirectUri:'https://127.0.0.1:1/oauth/device'},{clientId:'x',clientSecret:'s'.repeat(24),fetcher:fakeGoogle()}),/account_input_invalid/);
 await assert.rejects(()=>exchangeGoogleCode(input,{clientId:'x',clientSecret:'s'.repeat(24),fetcher:async()=>({ok:false,status:400,text:async()=>'{"error":"invalid_grant"}'})}),/account_google_exchange_refused/);
 await assert.rejects(()=>exchangeGoogleCode(input,{clientId:'x',clientSecret:'s'.repeat(24),fetcher:async()=>({ok:true,status:200,text:async()=>'{"id_token":"not a jwt"}'})}),/account_google_exchange_refused/);
});

test('the operator file may hold the bare secret or Google’s client JSON for this client only',()=>{
 assert.equal(googleClientSecretOf('  '+'s'.repeat(24)+'\n','id'),'s'.repeat(24));
 assert.equal(googleClientSecretOf(JSON.stringify({installed:{client_id:'id',client_secret:'t'.repeat(30)}}),'id'),'t'.repeat(30));
 assert.throws(()=>googleClientSecretOf(JSON.stringify({installed:{client_id:'other',client_secret:'t'.repeat(30)}}),'id'));
 assert.throws(()=>googleClientSecretOf('no spaces allowed here','id'));
});

test('over HTTP: /google/token answers with the ID token only, and refuses a bearer token',async()=>{
 const r=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dpro-token-')));
 const server=await listenAccountService({databasePath:path.join(r,'db','a.db'),epochRoot:path.join(r,'floor'),port:0,initializeNewStore:true,confirmedIndependentRetention:true,temporaryTestOnly:true,googleClientSecret:'s'.repeat(24),googleTokenFetch:fakeGoogle()});
 try{
  const url=new URL(server.origin+'/google/token'),post=(headers={})=>fetch('http://127.0.0.1:'+url.port+url.pathname,{method:'POST',headers:{'Content-Type':'application/json',Host:url.host,...headers},body:JSON.stringify(input)});
  const ok=await post();assert.equal(ok.status,200);const body=await ok.json();assert.deepEqual(body,{idToken});
  const refused=await post({Authorization:'Bearer '+'a'.repeat(43)});assert.equal(refused.status,403);
 }finally{await server.close();fs.rmSync(r,{recursive:true,force:true});}
});
