require('./load.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict');
const {allowedRequest,SessionClient}=require('../src/session.ts');
const {marketingResponse}=require('../src/marketing-contract.js');
const path='/api/ext/seo/marketing/';
test('Marketing transport admits only report/account reads and read-only consent',()=>{
 assert.equal(allowedRequest('GET',path+'status'),true);
 assert.equal(allowedRequest('POST',path+'read',{tool:'marketing_social_accounts',arguments:{}}),true);
 assert.equal(allowedRequest('POST',path+'read',{tool:'marketing_site_stats',arguments:{domain:'example.test',days:30}}),true);
 for(const tool of ['marketing_publish_post','marketing_prepare_post','marketing_youtube_start'])assert.equal(allowedRequest('POST',path+'read',{tool,arguments:{}}),false);
 assert.equal(allowedRequest('POST',path+'read',{tool:'marketing_social_accounts',arguments:{workspace_id:9}}),false);
 assert.equal(allowedRequest('POST',path+'authorize',{publishing:true}),false);
 assert.equal(allowedRequest('POST',path+'authorize',{publishing:false}),true);
 for(const p of [path+'status?token=x',path+'../secrets',path+'callback',path+'status/'])assert.equal(allowedRequest('GET',p),false);
});
test('Marketing projections remove credentials from nested MCP JSON and reject unbounded results',()=>{
 const raw={content:[{type:'text',text:JSON.stringify([{id:'a',name:'Existing',credentials:{accessToken:'PRIVATE'},nested:{refresh_token:'PRIVATE',count:0}}])}]};
 const out=marketingResponse(path+'read',200,raw);assert.ok(!JSON.stringify(out).includes('PRIVATE'));assert.equal(JSON.parse(out.content[0].text)[0].nested.count,0);
 assert.deepEqual(marketingResponse(path+'status',200,{connected:true,scopes:['read:social'],accessToken:'PRIVATE'}),{connected:true,scopes:['read:social']});
 assert.deepEqual(marketingResponse(path+'read',503,{error:'PRIVATE'}),{code:'marketing_unavailable'});
 assert.throws(()=>marketingResponse(path+'read',200,{content:[{type:'text',text:'not JSON'}]}));
 assert.throws(()=>marketingResponse(path+'read',200,{content:Array(21).fill({type:'text',text:'[]'})}));
});
test('existing injected session supplies owner auth and blocks member reads before forwarding',async()=>{
 for(const role of ['owner','user']){
  const user={id:'fixture-'+role,email:role+'@example.invalid',username:role,role},calls=[];
  const client=new SessionClient({mock:async r=>{if(r.path==='/api/auth/login')return {status:200,body:{token:'mock-only',deviceToken:'d'.repeat(43),user}};if(r.path==='/api/auth/me')return {status:200,body:{user}};calls.push(r);return {status:200,body:{connected:true,scopes:['read:social']}};}});
  client.selectMode('mock');await client.login(user.email,'fixture');
  if(role==='owner'){const r=await client.request({method:'GET',path:path+'status'});assert.equal(r.body.connected,true);assert.equal(calls[0].headers.Authorization,'Bearer mock-only');}
  else{await assert.rejects(client.request({method:'GET',path:path+'status'}));assert.equal(calls.length,0);}
 }
});
