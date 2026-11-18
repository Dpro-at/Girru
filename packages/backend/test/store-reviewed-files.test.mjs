import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {captureReviewedStorePackage, downloadReviewedStoreFile, verifiedStoreFileBytes, writeVerifiedStoreFile} from '../src/services/store-package-files.ts';
const sha = x => createHash('sha256').update(x).digest('hex');
function review(text='synthetic package',name='index.js') {
 const bytes=Buffer.from(text),files=[{path:'agentplayer.plugin.json',sha256:sha('{}'),size:2},{path:name,sha256:sha(bytes),size:bytes.length}];
 const source={files,sha256:sha(JSON.stringify(files))};
 const plan=captureReviewedStorePackage(source);
 return {source,plan,expected:plan.files[1],bytes};
}
const response=bytes=>({ok:true,status:200,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length)});
const stage=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'store-reviewed-'));fs.chmodSync(p,0o700);t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
test('snapshot freezes validated names/checksums and refuses mutable forged expectations before fetch',async()=>{
 const r=review();r.source.files[1].path='../outside.js';assert.equal(r.expected.path,'index.js');assert.equal(Object.isFrozen(r.expected),true);let calls=0;
 await assert.rejects(downloadReviewedStoreFile({...r.expected},'https://example.test',async()=>{calls++;return response(r.bytes);}));assert.equal(calls,0);
 const bad={files:[{path:'agentplayer.plugin.json',sha256:sha('{}'),size:2}],sha256:'0'.repeat(64)};assert.throws(()=>captureReviewedStorePackage(bad));
});
test('exclusive writes require original verified receipt, immutable byte ownership and error redirects',async t=>{
 const r=review(),dir=stage(t);let options;
 const receipt=await downloadReviewedStoreFile(r.expected,'https://example.test/index.js',async(_url,init)=>{options=init;return response(r.bytes);});
 assert.equal(options.redirect,'error');r.bytes.fill(0);const copy=verifiedStoreFileBytes(receipt);copy.fill(0);
 assert.throws(()=>writeVerifiedStoreFile(dir,{...receipt}));assert.deepEqual(fs.readdirSync(dir),[]);
 writeVerifiedStoreFile(dir,receipt);assert.equal(fs.readFileSync(path.join(dir,'index.js'),'utf8'),'synthetic package');assert.throws(()=>writeVerifiedStoreFile(dir,receipt));
});
test('streamed responses cannot exceed the reviewed size even without Content-Length',async()=>{
 const r=review('abc');let canceled=false,pulls=0;
 const body=new ReadableStream({pull(c){pulls++;c.enqueue(Buffer.from('xxxx'));},cancel(){canceled=true;}});
 await assert.rejects(downloadReviewedStoreFile(r.expected,'https://example.test',async()=>({...response(r.bytes),body})));assert.equal(canceled,true);assert.ok(pulls<=2);
});
test('lying length, short body, altered digest and missing real stream refuse before file writes',async()=>{
 const r=review('abc');
 for(const res of [
  {...response(r.bytes),headers:{get:name=>name.toLowerCase()==='content-length'?String(r.bytes.length+1):null}}, // only the length lies (no compression header)
  {...response(Buffer.from('ab'))},
  {...response(Buffer.from('abd'))},
  {...response(r.bytes),body:null},
 ])await assert.rejects(downloadReviewedStoreFile(r.expected,'https://example.test',async()=>res));
});
test('valid multi-chunk stream produces exactly the checked bytes',async t=>{
 const r=review('abcdefgh'),dir=stage(t),body=new ReadableStream({start(c){c.enqueue(Buffer.from('abc'));c.enqueue(Buffer.from('defgh'));c.close();}});
 const receipt=await downloadReviewedStoreFile(r.expected,'https://example.test',async()=>({...response(r.bytes),body,headers:{get:()=>String(r.bytes.length)}}));writeVerifiedStoreFile(dir,receipt);assert.equal(fs.readFileSync(path.join(dir,'index.js'),'utf8'),'abcdefgh');
});
test('existing leaf or parent symlinks cannot redirect a verified write',async t=>{
 const dir=stage(t),outside=stage(t),r=review('safe','nested/index.js'),receipt=await downloadReviewedStoreFile(r.expected,'https://example.test',async()=>response(r.bytes));
 fs.writeFileSync(path.join(outside,'index.js'),'unrelated synthetic marker');
 try{fs.symlinkSync(outside,path.join(dir,'nested'),'dir');}catch(e){if(process.platform==='win32'&&['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('Windows symlink privilege unavailable');return;}throw e;}
 assert.throws(()=>writeVerifiedStoreFile(dir,receipt));assert.equal(fs.readFileSync(path.join(outside,'index.js'),'utf8'),'unrelated synthetic marker');
});

test('decoded compressed responses use the streamed manifest bound rather than wire length',async t=>{
 const r=review('abcdefgh'),dir=stage(t),body=new ReadableStream({start(c){c.enqueue(r.bytes);c.close();}});
 const receipt=await downloadReviewedStoreFile(r.expected,'https://example.test',async()=>({...response(r.bytes),body,headers:{get:name=>name==='content-encoding'?'gzip':name==='content-length'?'20':null}}));
 writeVerifiedStoreFile(dir,receipt);assert.equal(fs.readFileSync(path.join(dir,'index.js'),'utf8'),'abcdefgh');
});
