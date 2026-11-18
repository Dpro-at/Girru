// Deferred source fixtures: execute only with the final whole-task ENC verification round.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {queueEncryptedOwnerFileImport} from '../src/memory/encryption/import-file.ts';
async function fixture(run){
 const root=await realpath(await mkdtemp(join(tmpdir(),'girru-synthetic-import-'))),path=join(root,'source.md'),bytes=Buffer.from('# Synthetic\nTemporary owner import only.');
 try{await writeFile(path,bytes);await run({root,path,bytes,lease:{fileId:'synthetic-file',path,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,exclusive:true,isCurrent:()=>true}});}finally{await rm(root,{recursive:true,force:true});}
}
test('explicit file lease queues owned text and digest without exposing its path to the proposal writer',async()=>fixture(async({lease,bytes})=>{
 let captured;const result=await queueEncryptedOwnerFileImport({fileId:lease.fileId,drawer:{kind:'owner'},format:'markdown',authorize:async()=>lease,isCurrent:()=>true,queue:async input=>{captured=input;assert.equal(input.sourceLease(),true);return{proposalId:'pending',count:1};}});
 assert.equal(result.proposalId,'pending');assert.equal(captured.text,bytes.toString());assert.equal(captured.sourceDigest,lease.sha256);assert.equal(Object.hasOwn(captured,'path'),false);
}));
test('missing exclusivity, wrong hash, revoked lease and linked file refuse before queueing',async()=>fixture(async({lease,root})=>{
 const link=join(root,'linked.md');await symlink(lease.path,link);
 for(const changed of [{exclusive:false},{sha256:'0'.repeat(64)},{isCurrent:()=>false},{path:link}]){
  let queued=false;await assert.rejects(queueEncryptedOwnerFileImport({fileId:lease.fileId,drawer:{kind:'owner'},format:'text',authorize:async()=>({...lease,...changed}),isCurrent:()=>true,queue:async()=>{queued=true;return{proposalId:'unexpected',count:1};}}));assert.equal(queued,false);
 }
}));
test('invalid UTF-8 and NUL bytes cannot enter the encrypted review queue',async()=>fixture(async({lease})=>{
 for(const bytes of [Buffer.from([0xc3,0x28]),Buffer.from('synthetic\0hidden')]){
  await writeFile(lease.path,bytes);let queued=false;
  await assert.rejects(queueEncryptedOwnerFileImport({fileId:lease.fileId,drawer:{kind:'owner'},format:'text',authorize:async()=>({...lease,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}),isCurrent:()=>true,queue:async()=>{queued=true;return{proposalId:'unexpected',count:1};}}));assert.equal(queued,false);
 }
}));
