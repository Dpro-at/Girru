import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,realpath,lstat,symlink,rm,rename,writeFile,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {pinAuthorizedExternalRoot,assertAuthorizedExternalRootIdentity} from '../src/memory/encryption/external-root-identity.ts';
test('explicit permission surrounds descriptor-only root identity; symlink roots and revoked permissions refuse',{skip:process.platform==='win32'},async()=>{
 const temporary=await mkdtemp(join(tmpdir(),'girru-root-identity-')),base=await realpath(temporary),root=join(base,'selected');await mkdir(root);
 const request={purpose:'encrypted-forget-plan',ownerId:'synthetic-owner',scope:'project:synthetic',root,reference:{kind:'project-root',scope:'synthetic',path:root}};
 try{
 const info=await lstat(root,{bigint:true}),identity=await pinAuthorizedExternalRoot(request,async()=>true);assert.equal(identity.device,String(info.dev));assert.equal(identity.inode,String(info.ino));
 await assert.rejects(pinAuthorizedExternalRoot(request,async()=>false));let calls=0;await assert.rejects(pinAuthorizedExternalRoot(request,async()=>++calls===1));assert.equal(calls,2);
 await symlink(root,join(base,'linked'));await assert.rejects(pinAuthorizedExternalRoot({...request,root:join(base,'linked')},async()=>true));
 await mkdir(join(root,'child'));await assert.rejects(pinAuthorizedExternalRoot({...request,root:join(base,'linked','child')},async()=>true));
 await assertAuthorizedExternalRootIdentity(identity,request,async()=>true);await rename(root,join(base,'parked'));await mkdir(root);await assert.rejects(assertAuthorizedExternalRootIdentity(identity,request,async()=>true));await assert.rejects(assertAuthorizedExternalRootIdentity({...identity,scope:'project:other'},request,async()=>true));
 }finally{await rm(temporary,{recursive:true,force:true});}
});

import {createScopedForgetFileRunner} from '../src/memory/encryption/forget-files.ts';
test('descriptor deletion rejects replacing a captured root before its first operation',{skip:process.platform==='win32'},async()=>{
 const temporary=await mkdtemp(join(tmpdir(),'girru-pinned-delete-')),base=await realpath(temporary),root=join(base,'selected');await mkdir(root);await writeFile(join(root,'synthetic.md'),'ORIGINAL');
 const request={purpose:'encrypted-forget-plan',ownerId:'synthetic-owner',scope:'project:synthetic',root,reference:{kind:'project-root',scope:'synthetic',path:root}};
 try{
  const captured=await pinAuthorizedExternalRoot(request,async()=>true),expected={root:captured.root,device:captured.device,inode:captured.inode};
  const execute=createScopedForgetFileRunner(root,'/usr/bin/python3',expected);
  await rename(root,join(base,'parked'));await mkdir(root);await writeFile(join(root,'synthetic.md'),'KEEP_REPLACEMENT');
  await assert.rejects(execute(['synthetic.md']));assert.equal(await readFile(join(root,'synthetic.md'),'utf8'),'KEEP_REPLACEMENT');assert.equal(await readFile(join(base,'parked','synthetic.md'),'utf8'),'ORIGINAL');
  await rm(root,{recursive:true});await rename(join(base,'parked'),root);await execute(['synthetic.md']);await assert.rejects(readFile(join(root,'synthetic.md')));
 }finally{await rm(temporary,{recursive:true,force:true});}
});

import {createHash} from 'node:crypto';import {inventoryAuthorizedExternalCopies} from '../src/memory/encryption/external-copy-inventory.ts';
test('authorized bounded inventory includes current, outside and staged copies without returning content',{skip:process.platform==='win32'},async()=>{
 const temporary=await mkdtemp(join(tmpdir(),'girru-copy-inventory-')),root=await realpath(temporary),dir=join(root,'.girru');await mkdir(dir);
 const request={purpose:'encrypted-forget-plan',ownerId:'synthetic-owner',scope:'project:synthetic',root,reference:{kind:'project-root',scope:'synthetic',path:root}};
 try{
 const content='SYNTHETIC_PRIVATE_QUOTE';for(const name of ['brief.md','brief.outside-3.md','brief.md.0123456789abcdef.tmp'])await writeFile(join(dir,name),content);
 const identity=await pinAuthorizedExternalRoot(request,async()=>true),files=await inventoryAuthorizedExternalCopies(identity,request,async()=>true);assert.equal(files.length,3);assert.ok(files.every(f=>f.sha256===createHash('sha256').update(content).digest('hex')));assert.ok(!JSON.stringify(files).includes(content));await assert.rejects(inventoryAuthorizedExternalCopies(identity,request,async()=>true,Buffer.byteLength(content)*3-1));assert.equal((await inventoryAuthorizedExternalCopies(identity,request,async()=>true,Buffer.byteLength(content)*3)).length,3);
 await writeFile(join(root,'AGENTS.md'),'OWNER_NOTES_AND_PRIVATE_MANAGED_TEXT');const managed=await inventoryAuthorizedExternalCopies(identity,request,async()=>true);assert.equal(managed.length,4);assert.ok(managed.some(f=>f.path==='AGENTS.md'));assert.ok(!JSON.stringify(managed).includes('OWNER_NOTES_AND_PRIVATE_MANAGED_TEXT'));
 await symlink(join(dir,'brief.md'),join(dir,'linked.md'));await assert.rejects(inventoryAuthorizedExternalCopies(identity,request,async()=>true));
 await assert.rejects(inventoryAuthorizedExternalCopies(identity,request,async()=>false));
 }finally{await rm(temporary,{recursive:true,force:true});}
});
