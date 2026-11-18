const {test}=require('node:test');const assert=require('node:assert/strict');
test('optional app activation is exact and projects no local paths or credentials',async()=>{
 const {allowedHostApp,hostAppResponse}=await import('../src/store-host-app-contract.js');
 for(const id of ['call-center','trading','browser']){
  const status=`/api/store/apps/${id}/status`,activate=`/api/store/apps/${id}/activation`;
  assert.equal(allowedHostApp('GET',status),true);assert.equal(allowedHostApp('POST',activate,{enabled:true}),true);
  for(const bad of [{enabled:1},{enabled:true,owner:'other'},[],null])assert.equal(allowedHostApp('POST',activate,bad),false);
  assert.equal(allowedHostApp('GET',status+'?path=secret'),false);assert.equal(allowedHostApp('POST',status,{}),false);
  assert.deepEqual(hostAppResponse(status,200,{id,installed:true,enabled:false,ready:true,needsRestart:false,clientHash:null,root:'/private',token:'hidden'}),{id,installed:true,enabled:false,ready:true,needsRestart:false,clientHash:null});
  assert.throws(()=>hostAppResponse(status,200,{id,installed:true}));assert.deepEqual(hostAppResponse(activate,200,{ok:true,enabled:true,restart:'manual',root:'/private'}),{ok:true,enabled:true,restart:'manual'});
 }
 assert.equal(allowedHostApp('POST','/api/store/apps/other/activation',{enabled:true}),false);
});
