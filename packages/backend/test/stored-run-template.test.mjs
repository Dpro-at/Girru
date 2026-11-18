/** Deferred synthetic template fixtures; no model, identity, native store, or original workspace access. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {storedTaskPrompt,captureStoredHeartbeatTemplate} from '../src/agent/execution/stored-run-template.ts';
test('the reviewed task template includes actual pipeline input and does not rebase when input changes',()=>{
 const task={title:'Synthetic task',description:'Review a synthetic input',input:{_upstream:{result:'first'}}};const original=storedTaskPrompt(task,null);assert.match(original,/first/);task.input._upstream.result='second';assert.notEqual(storedTaskPrompt(task,null),original);
});
test('heartbeat source deletion or change revokes the captured template instead of adopting the fallback',()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'girru-template-fixture-')));try{fs.writeFileSync(path.join(root,'HEARTBEAT-test.md'),'# Checklist\nRead synthetic status');fs.writeFileSync(path.join(root,'HEARTBEAT.md'),'Fallback checklist');const first=captureStoredHeartbeatTemplate('test',root);assert.ok(first.isCurrent());assert.match(first.prompt,/Read synthetic status/);fs.writeFileSync(path.join(root,'HEARTBEAT-test.md'),'Different checklist');assert.equal(first.isCurrent(),false);const second=captureStoredHeartbeatTemplate('test',root);fs.unlinkSync(path.join(root,'HEARTBEAT-test.md'));assert.equal(second.isCurrent(),false);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('an agent name cannot turn the fixed heartbeat picker into an arbitrary path reader',()=>{assert.throws(()=>captureStoredHeartbeatTemplate('../private'));assert.throws(()=>captureStoredHeartbeatTemplate('nested\\private'));});
test('a symlink checklist refuses before reading its target',()=>{const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'girru-template-link-')));try{fs.writeFileSync(path.join(root,'synthetic.txt'),'Do not import');fs.symlinkSync(path.join(root,'synthetic.txt'),path.join(root,'HEARTBEAT.md'));assert.throws(()=>captureStoredHeartbeatTemplate('test',root));}finally{fs.rmSync(root,{recursive:true,force:true});}});
