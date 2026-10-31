import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DiscoveryFileSystem } from '../src/services/discovery-fs.ts';
test('blocked child leaves parent filesystem responsive and requires explicit retry', async () => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'discovery-worker-test-')), worker=path.join(dir,'fixture.cjs');
 await fs.writeFile(worker,`process.on('message',m=>{if(require('node:path').basename(m.file)==='blocked')return;process.send({id:m.id,value:process.env.DISCOVERY_TEST_SECRET?'leaked':'clean'})});process.on('disconnect',()=>process.exit());`);
 const client=new DiscoveryFileSystem({worker,timeoutMs:500});process.env.DISCOVERY_TEST_SECRET='private';
 try {let finished=false;const blocked=client.realpath(path.join(dir,'blocked')).finally(()=>{finished=true});const rejected=assert.rejects(blocked,{code:'EACCES'});
 await fs.writeFile(path.join(dir,'api.txt'),'responsive');assert.equal(await fs.readFile(path.join(dir,'api.txt'),'utf8'),'responsive');assert.equal(finished,false);await rejected;
 assert.equal(client.diagnostics().pending,1);await assert.rejects(client.realpath(path.join(dir,'normal')),{code:'EACCES'});client.retry();assert.equal(await client.realpath(path.join(dir,'normal')),'clean');
 }finally{delete process.env.DISCOVERY_TEST_SECRET;client.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('worker rejects private bytes, symlinks and invalid SQLite copies',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'discovery-worker-test-')),target=await fs.mkdtemp(path.join(os.tmpdir(),'dpro-read-')),client=new DiscoveryFileSystem();
 try{await fs.writeFile(path.join(dir,'note.md'),'memory');await fs.writeFile(path.join(dir,'id_ed25519'),'private');let linked=true;try{await fs.symlink(path.join(dir,'note.md'),path.join(dir,'linked.md'));}catch(error){if(process.platform!=='win32'||error.code!=='EPERM')throw error;linked=false;}
 assert.equal((await client.readRegularFile(path.join(dir,'note.md'),100)).data.toString(),'memory');assert.equal((await client.lstat(path.join(dir,'id_ed25519'))).isFile(),true);
 await assert.rejects(client.readRegularFile(path.join(dir,'id_ed25519'),100),{code:'EACCES'});if(linked)await assert.rejects(client.readRegularFile(path.join(dir,'linked.md'),100));await assert.rejects(client.readRegularFile(path.join(dir,'note.md'),2),{code:'EFBIG'});
 await fs.writeFile(path.join(dir,'source.db'),Buffer.concat([Buffer.from('SQLite format 3\0'),Buffer.alloc(100)]));await client.copyToTemp(path.join(dir,'source.db'),path.join(target,'copy.db'));assert.deepEqual(await fs.readFile(path.join(target,'copy.db')),await fs.readFile(path.join(dir,'source.db')));
 await assert.rejects(client.copyToTemp(path.join(dir,'source.db'),path.join(target,'copy.db')));await fs.writeFile(path.join(dir,'fake.db'),'not a database at all');await assert.rejects(client.copyToTemp(path.join(dir,'fake.db'),path.join(target,'copy.sqlite')),{code:'EINVAL'});
 }finally{client.close();await fs.rm(dir,{recursive:true,force:true});await fs.rm(target,{recursive:true,force:true});}
});
