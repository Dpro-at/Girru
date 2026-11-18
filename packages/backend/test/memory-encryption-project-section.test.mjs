import test from 'node:test';import assert from 'node:assert/strict';
import {prepareManagedProjectForget} from '../src/memory/encryption/project-forget-section.ts';
import {MARK_START,MARK_END,GIRRU_START,GIRRU_END} from '../src/memory/bridge/managed-files.ts';
import {MemoryCipherError} from '../src/memory/encryption/envelope.ts';
test('managed memory sections are removed while outside owner bytes and line endings remain exact',()=>{
 const before='OWNER NOTES\r\nArabic: مرحبا\r\n',after='\r\nKEEP OWNER FOOTER\r\n',input=Buffer.from(before+MARK_START+'\nSYNTHETIC_FORGOTTEN_QUOTE\n'+MARK_END+after),result=prepareManagedProjectForget('AGENTS.md',input);
 assert.equal(result.removed,true);assert.deepEqual(result.after,Buffer.from(before+after));assert.notEqual(result.beforeHash,result.afterHash);assert.ok(!result.after.includes(Buffer.from('SYNTHETIC_FORGOTTEN_QUOTE')));
});
test('current and legacy sections reuse existing markers; files without them are unchanged',()=>{
 const plain=Buffer.from('OWNER ONLY\n');assert.deepEqual(prepareManagedProjectForget('CLAUDE.md',plain).after,plain);assert.equal(prepareManagedProjectForget('GEMINI.md',plain).removed,false);
 const input=Buffer.from('prefix'+GIRRU_START+'\nSECRET\n'+GIRRU_END+'suffix');assert.deepEqual(prepareManagedProjectForget('GEMINI.md',input).after,Buffer.from('prefixsuffix'));
});
test('broken/duplicate markers, invalid UTF-8, unknown document names and oversized data fail closed',()=>{
 for(const bytes of [Buffer.from(MARK_START+'broken'),Buffer.from(MARK_START+MARK_START+MARK_END),Buffer.from([0xff]),Buffer.alloc(1048577)])assert.throws(()=>prepareManagedProjectForget('AGENTS.md',bytes),MemoryCipherError);
 assert.throws(()=>prepareManagedProjectForget('personal-notes.md',Buffer.from('keep')),MemoryCipherError);
});
import {mkdtemp,writeFile,readFile,rm,symlink,mkdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createManagedProjectForgetWriter} from '../src/memory/encryption/project-forget-section.ts';
test('shared document replacement refuses without exclusive writer ownership and preserves owner bytes', {skip:process.platform==='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'girru-project-forget-'));try{
 const input=Buffer.from('OWNER BEFORE\n'+MARK_START+'\nFORGOTTEN_COPY\n'+MARK_END+'\nOWNER AFTER\n');
 await writeFile(join(root,'AGENTS.md'),input);
 await assert.rejects(createManagedProjectForgetWriter(root)('AGENTS.md',input),MemoryCipherError);
 assert.deepEqual(await readFile(join(root,'AGENTS.md')),input);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('descriptor writer refuses symbolic-link documents and leaves outside file intact',{skip:process.platform==='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'girru-project-forget-link-'));try{await mkdir(join(root,'selected'));const input=Buffer.from(MARK_START+'\nKEEP_OUTSIDE\n'+MARK_END);await writeFile(join(root,'outside.md'),input);await symlink(join(root,'outside.md'),join(root,'selected','AGENTS.md'));await assert.rejects(createManagedProjectForgetWriter(join(root,'selected'))('AGENTS.md',input),MemoryCipherError);assert.deepEqual(await readFile(join(root,'outside.md')),input);}finally{await rm(root,{recursive:true,force:true});}
});

import {DESIGN_MARK_START,DESIGN_MARK_END} from '../src/discovery/project-tech.ts';
test('design cleanup removes only design markers and preserves unrelated owner memory sections',()=>{
 const owner=MARK_START+'\nOWNER MEMORY NOTES\n'+MARK_END+'\r\n';
 const bytes=Buffer.from(owner+DESIGN_MARK_START+'\nFORGOTTEN DESIGN\n'+DESIGN_MARK_END+'\r\nOWNER END');
 assert.deepEqual(prepareManagedProjectForget('DESIGN.md',bytes).after,Buffer.from(owner+'\r\nOWNER END'));
 assert.throws(()=>prepareManagedProjectForget('DESIGN.md',Buffer.from(DESIGN_MARK_START+'broken')),MemoryCipherError);
});
