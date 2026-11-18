import test from 'node:test';
import assert from 'node:assert/strict';
import {installEncryptedMemoryConsumerHost,assertNoLegacyMemoryFileAccess,isEncryptedMemoryProfileSelected,withEncryptedMemoryConsumerScope,consumeCurrentEncryptedMemoryScope} from '../src/memory/encryption/consumer-host.ts';

test('selected or pending native profile refuses legacy memory file fallback without opening a profile',async()=>{
 const remove=installEncryptedMemoryConsumerHost({getHost:()=>null,isSelected:()=>true,refreshHostFoundations:async()=>{}});
 try{assert.equal(isEncryptedMemoryProfileSelected(),true);assert.throws(()=>assertNoLegacyMemoryFileAccess());let called=false;await assert.rejects(()=>consumeCurrentEncryptedMemoryScope(async()=>{called=true;}));assert.equal(called,false);}finally{remove();}
 assert.equal(isEncryptedMemoryProfileSelected(),false);assert.doesNotThrow(()=>assertNoLegacyMemoryFileAccess());
});
test('consumer metadata scope cannot widen drawers or change the actual principal',async()=>{
 const remove=installEncryptedMemoryConsumerHost({getHost:()=>null,isSelected:()=>true});try{
 const scope={userId:'synthetic-owner',agentId:'synthetic-agent',runId:'synthetic-run',drawers:[{kind:'owner'}],project:null,delegatedFrom:[],audience:'owner'};
 await withEncryptedMemoryConsumerScope(scope,async()=>{
  await assert.rejects(()=>withEncryptedMemoryConsumerScope({...scope,drawers:[{kind:'project',key:'hidden'}]},async()=>{}));
  await assert.rejects(()=>withEncryptedMemoryConsumerScope({...scope,agentId:'other-agent'},async()=>{}));
 });}finally{remove();}
});

test('legacy empty-owner context remains untouched only while encrypted authority is entirely absent',async()=>{
 const legacy={userId:'',agentId:'legacy-agent',drawers:[],project:null,delegatedFrom:[],audience:'owner'};let calls=0;
 assert.equal(await withEncryptedMemoryConsumerScope(legacy,async()=>{calls++;return 'legacy';}),'legacy');
 const remove=installEncryptedMemoryConsumerHost({getHost:()=>null,isSelected:()=>false});try{await withEncryptedMemoryConsumerScope(legacy,async()=>{calls++;});}finally{remove();}
 const removePending=installEncryptedMemoryConsumerHost({getHost:()=>null,isSelected:()=>true});try{await assert.rejects(()=>withEncryptedMemoryConsumerScope(legacy,async()=>{calls++;}));}finally{removePending();}
 assert.equal(calls,2);
});
