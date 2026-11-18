import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'store-runtime-packages-'));
process.env.HOME=root;process.env.USERPROFILE=root;process.env.AGENT_PLAYER_DATA_DIR=path.join(root,'data');
const {parseRuntimePackages,installRuntimePackages}=await import('../src/services/store-package-runtime.ts');
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const sha=data=>createHash('sha256').update(data).digest('hex');
function tar(files){
 const blocks=[];
 for(const [name,body,type='0',link='']of files){const data=Buffer.from(body),h=Buffer.alloc(512);h.write(name);h.write('0000644\0',100);h.write('0000000\0',108);h.write('0000000\0',116);h.write(data.length.toString(8).padStart(11,'0')+'\0',124);h.write('00000000000\0',136);h.write('        ',148);h.write(type,156);if(link)h.write(link,157);h.write('ustar\0',257);h.write('00',263);h.write([...h].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);blocks.push(h,data,Buffer.alloc((512-data.length%512)%512));}
 return gzipSync(Buffer.concat([...blocks,Buffer.alloc(1024)]));
}
function fixture(id,extra=[],container='package'){
 const bytes=tar([[container+'/package.json',JSON.stringify({name:'fixture-runtime',version:'1.0.0',scripts:{install:'NEVER_EXECUTE'}})],[container+'/index.js','export const ready=true;'],...extra]);
 const descriptor={schema:1,packages:[{name:'fixture-runtime',version:'1.0.0',path:'node_modules/fixture-runtime',url:'https://registry.npmjs.org/fixture-runtime/-/fixture-runtime-1.0.0.tgz',sha256:sha(bytes),size:bytes.length}]};
 const dir=path.join(root,id);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'index.js'),'existing app');
 return {dir,bytes,descriptor,buffer:()=>Buffer.from(JSON.stringify(descriptor)),get:async()=>({ok:true,status:200,body:(async function*(){yield bytes;})()})};
}
test('installs exact pinned archives without invoking package scripts, including historical npm container names',async()=>{
 const f=fixture('valid',[],'fixture-runtime v1');await installRuntimePackages(f.dir,f.buffer(),f.get);
 assert.equal(fs.readFileSync(path.join(f.dir,'index.js'),'utf8'),'existing app');assert.equal(fs.readFileSync(path.join(f.dir,'node_modules/fixture-runtime/index.js'),'utf8'),'export const ready=true;');
 assert.equal(fs.readdirSync(f.dir).some(x=>x.startsWith('.runtime-')),false);
});
test('descriptor refuses alternate registries, mismatched versions, path escapes and duplicates',()=>{
 const f=fixture('descriptor'),item=f.descriptor.packages[0];
 for(const change of [{url:'https://example.invalid/fixture-runtime.tgz'},{url:item.url+'?token=fixture'},{url:item.url.replace('1.0.0.tgz','2.0.0.tgz')},{path:'node_modules/../outside'},{name:'other'},{size:64*1024*1024+1}])assert.throws(()=>parseRuntimePackages(Buffer.from(JSON.stringify({schema:1,packages:[{...item,...change}]}))));
 assert.throws(()=>parseRuntimePackages(Buffer.from(JSON.stringify({schema:1,packages:[item,item]}))));
});
test('size or digest mismatch cannot write a package and always removes temporary archives',async()=>{
 for(const change of [{size:1},{sha256:'0'.repeat(64)}]){const f=fixture('integrity-'+Object.keys(change)[0]);Object.assign(f.descriptor.packages[0],change);await assert.rejects(installRuntimePackages(f.dir,f.buffer(),f.get));assert.equal(fs.existsSync(path.join(f.dir,'node_modules/fixture-runtime')),false);assert.deepEqual(fs.readdirSync(f.dir),['index.js']);}
});
test('links and traversal in otherwise hash-valid archives are refused',async()=>{
 for(const [name,type,link]of [['package/escape','2','../../outside'],['package/escape','1','../../outside'],['package/../../outside','0','']]){const f=fixture('unsafe-'+type+link.length,[[name,'',type,link]]);await assert.rejects(installRuntimePackages(f.dir,f.buffer(),f.get));assert.equal(fs.existsSync(path.join(root,'outside')),false);}
});

test('a linked app staging folder is refused before writes',{skip:process.platform==='win32'},async()=>{const f=fixture('plain-root'),linked=path.join(root,'linked-root');fs.symlinkSync(f.dir,linked);await assert.rejects(installRuntimePackages(linked,f.buffer(),f.get));assert.deepEqual(fs.readdirSync(f.dir),['index.js']);});
