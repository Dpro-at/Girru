import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,mkdirSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {snapshot,checkpointChanges,checkpointFileDiff} from '../src/services/chat-checkpoints.ts';
test('per-reply files and diffs retain checkpoint counts after later edits; subfolders and deletion are scoped',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'girru-reply-changes-'));try{
  execFileSync('git',['init','-q',dir]);mkdirSync(join(dir,'project'));writeFileSync(join(dir,'project','a.ts'),'old\n');writeFileSync(join(dir,'project','deleted.ts'),'gone\n');writeFileSync(join(dir,'outside.txt'),'outside\n');
  const before=await snapshot(join(dir,'project'));assert.ok(before);
  writeFileSync(join(dir,'project','a.ts'),'new\nextra\n');rmSync(join(dir,'project','deleted.ts'));writeFileSync(join(dir,'project','b.ts'),'added\n');
  const after=await snapshot(join(dir,'project'));assert.ok(after);writeFileSync(join(dir,'project','a.ts'),'later unrelated edit\n');
  const result=await checkpointChanges(before,after);assert.deepEqual(result.changes.find(f=>f.path==='a.ts'),{path:'a.ts',status:'modified',added:2,removed:1});assert.ok(!result.changes.some(f=>f.path.includes('outside')));
  const diff=await checkpointFileDiff(before,after,'a.ts');assert.match(diff.diff,/\+extra/);assert.doesNotMatch(diff.diff,/later unrelated/);
  assert.match((await checkpointFileDiff(before,after,'deleted.ts')).diff,/-gone/);assert.equal(readFileSync(join(dir,'project','a.ts'),'utf8'),'later unrelated edit\n');
  for(const path of ['../outside.txt','/etc/passwd','not-in-reply.ts'])await assert.rejects(checkpointFileDiff(before,after,path));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
