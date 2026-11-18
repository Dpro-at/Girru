const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto');const {storeAppAsset}=require('../scripts/store-app-assets.cjs');
test('only reviewed public renderer assets are served, with size/hash and symlink checks',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'store-asset-')),app=path.join(root,'apps/trading');fs.mkdirSync(app,{recursive:true});const data=Buffer.from('export const example=true;'),hash=createHash('sha256').update(data).digest('hex');const marker={id:'trading',source:'store',packageSha256:'a'.repeat(64),files:[{path:'client.js',size:data.length,sha256:hash}]};
 try{fs.writeFileSync(path.join(app,'client.js'),data);fs.writeFileSync(path.join(app,'.girru-store.json'),JSON.stringify(marker));const options={dataDir:root};
 assert.equal(storeAppAsset('/store-apps/trading/client.js?v='+hash,options).status,200);assert.deepEqual(storeAppAsset('/store-apps/trading/client.js',options).data,data);assert.equal(storeAppAsset('/store-apps/trading/client.js?v='+'b'.repeat(64),options).status,409);
 assert.equal(storeAppAsset('/store-apps/trading/../../private.json',options),null);assert.equal(storeAppAsset('/store-apps/trading/.girru-store.json',options),null);assert.equal(storeAppAsset('/store-apps/trading/client.js?token=secret',options).status,400);
 fs.writeFileSync(path.join(app,'client.js'),'changed');assert.equal(storeAppAsset('/store-apps/trading/client.js',options).status,404);
 fs.unlinkSync(path.join(app,'client.js'));fs.writeFileSync(path.join(root,'private.js'),data);try{fs.symlinkSync(path.join(root,'private.js'),path.join(app,'client.js'));assert.equal(storeAppAsset('/store-apps/trading/client.js',options).status,404);}catch(e){if(e.code!=='EPERM')throw e;}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
