import test from 'node:test';
import assert from 'node:assert/strict';
import {syncDirectory} from '../src/services/sync-directory.ts';
test('Windows directory flush is unsupported and never opens a directory handle',async()=>{
 await syncDirectory('fixture','win32',async()=>{throw Error('must not open');});
});
test('POSIX directory durability syncs and closes the opened handle',async()=>{
 const events=[];
 await syncDirectory('fixture','linux',async(path,flags)=>{assert.equal(path,'fixture');assert.equal(flags,'r');return {sync:async()=>events.push('sync'),close:async()=>events.push('close')};});
 assert.deepEqual(events,['sync','close']);
});
test('POSIX flush failures propagate after closing the directory',async()=>{
 let closed=false;
 await assert.rejects(syncDirectory('fixture','darwin',async()=>({sync:async()=>{throw Error('disk failure');},close:async()=>{closed=true;}})),/disk failure/);
 assert.equal(closed,true);
});
