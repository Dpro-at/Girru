import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,symlink,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createEncryptedForgetFileCleaner} from '../src/memory/encryption/forget-files.ts';
const plan={v:1,ownerId:'synthetic-owner',memoryId:'synthetic-memory',types:['fact'],texts:[],drawer:{kind:'owner'},tombstoneId:'synthetic-tombstone'};
test('explicit-root cleanup refuses symbolic-link escapes and traversal without touching outside files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'girru-forget-files-'));try{await mkdir(join(root,'selected'));await mkdir(join(root,'outside'));const outside=join(root,'outside','fact-synthetic-memory.md');await writeFile(outside,'KEEP_OUTSIDE');await symlink(join(root,'outside'),join(root,'selected','synthetic-owner'));
 await assert.rejects(createEncryptedForgetFileCleaner(join(root,'selected'))(plan));assert.equal(await readFile(outside,'utf8'),'KEEP_OUTSIDE');await assert.rejects(createEncryptedForgetFileCleaner(join(root,'selected'),['../../outside'])(plan));assert.equal(await readFile(outside,'utf8'),'KEEP_OUTSIDE');
 }finally{await rm(root,{recursive:true,force:true});}
});
