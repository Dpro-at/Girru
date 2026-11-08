'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('packaged native broker resolves the shared verifier without the repository checkout',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'girru-packaged-identity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const desktop=path.resolve(__dirname,'..'),config=require('../package.json');
 const mapping=config.build.extraResources.find(item=>item.to==='identity/src');
 assert.deepEqual(mapping,{from:'../identity/src',to:'identity/src',filter:['google.cjs']});
 const resources=path.join(root,'Resources'),app=path.join(resources,'app.asar');
 fs.mkdirSync(app,{recursive:true});
 fs.cpSync(path.join(desktop,'src'),path.join(app,'src'),{recursive:true});
 const target=path.join(resources,mapping.to);fs.mkdirSync(target,{recursive:true});
 fs.copyFileSync(path.join(desktop,mapping.from,'google.cjs'),path.join(target,'google.cjs'));
 const verifier=require(path.join(app,'src','device-google.cjs'));
 assert.equal(typeof verifier.verifyGoogleIdToken,'function');
 assert.equal(typeof require(path.join(app,'src','device-broker.cjs')).createDeviceBroker,'function');
 assert.equal(verifier.clientIdOk('281410907967-kaljlvtllp3kleqfp07j1v7ri68hdun6.apps.googleusercontent.com'),true);
});
