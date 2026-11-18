/** Deferred source fixtures. Every authority/provider here is synthetic and grants no production capability. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {installEncryptedRunAdmissionProvider} from '../src/memory/encryption/run-admission.ts';
import {withRunAdmission,beforeAdmittedModel,observeAdmittedContext,executeAdmittedTool,admitToolBatch,admittedModelStep} from '../src/agent/execution/run-admission-entry.ts';
import {runOllamaAgentLoop} from '../src/agent/providers/ollama-agent-loop.ts';
import {runLmStudioAgentLoop} from '../src/agent/providers/lmstudio-agent-loop.ts';
const entry={kind:'chat',runId:'synthetic-run',ownerId:'synthetic-owner',agentId:'synthetic-agent',sessionId:'synthetic-session',inputDigest:'0'.repeat(64),unknownSources:[]};
function syntheticProvider(){
 let generation=1,expired=false;const records=[];
 return {records,expire:()=>{expired=true;},revoke:()=>{generation++;},provider:{async admitRun(input){const origin=generation,record={input,taints:[...input.unknownSources],sources:[]};records.push(record);let active=true;return {isCurrent:()=>active&&!expired&&generation===origin,run:async operation=>{try{return await operation();}finally{active=false;}},taint:reason=>record.taints.push(reason),observeContext:items=>record.sources.push(...items),beforeModel:async()=>{if(!active||generation!==origin)throw new Error('synthetic-head-changed');expired=false;}};}}};
}
test('actual entry holds one original admission through context and tools; unknown parallel batch taints before either tool starts',async()=>{
 const state=syntheticProvider(),remove=installEncryptedRunAdmissionProvider(state.provider);
 try{await withRunAdmission(entry,async()=>{observeAdmittedContext([{kind:'memory',id:'memory-before-llm'},{kind:'document',id:'document-before-llm'}]);admitToolBatch(['memory_save','browser_fetch']);await Promise.all(['memory_save','browser_fetch'].map(name=>executeAdmittedTool({execute:async()=>{assert.ok(state.records[0].taints.includes('unverified-tool-source:browser_fetch'));return {content:[]};}},name,{})));});assert.equal(state.records.length,1);assert.deepEqual(state.records[0].sources,[{kind:'memory',id:'memory-before-llm'},{kind:'document',id:'document-before-llm'}]);}finally{remove();}
});
test('expired proof renews only under the unchanged original head, not a tool-call fresh head',async()=>{
 const state=syntheticProvider(),remove=installEncryptedRunAdmissionProvider(state.provider);
 try{await withRunAdmission(entry,async()=>{state.expire();await beforeAdmittedModel();state.revoke();await assert.rejects(beforeAdmittedModel());});assert.fail('revoked run must not complete');}catch(error){assert.match(String(error),/synthetic-head-changed/);}finally{remove();}
});
test('old chat history remains tainted across renewal; unknown context does not become a source ID',async()=>{
 const state=syntheticProvider(),remove=installEncryptedRunAdmissionProvider(state.provider);
 try{await withRunAdmission({...entry,unknownSources:['unverified-chat-history']},async()=>{state.expire();await beforeAdmittedModel();observeAdmittedContext([{kind:'fact',id:'unversioned-scope-text'}]);});assert.ok(state.records[0].taints.includes('unverified-chat-history'));assert.ok(state.records[0].taints.includes('unversioned-context-source'));assert.deepEqual(state.records[0].sources,[]);}finally{remove();}
});
test('a standalone provider/tool cannot invent an admission after the actual run has ended',async()=>{
 const state=syntheticProvider(),remove=installEncryptedRunAdmissionProvider(state.provider);
 try{await assert.rejects(beforeAdmittedModel());await assert.rejects(executeAdmittedTool({execute:async()=>{assert.fail('unadmitted tool executed');}},'memory_save',{}));}finally{remove();}
});
for(const [name,loop] of [['ollama',runOllamaAgentLoop],['lmstudio',runLmStudioAgentLoop]]){
 test(name+' awaits a rejecting lineage boundary before touching the synthetic model',async()=>{let contacted=false,released=false;const gate=new Promise(resolve=>{released=resolve;});const running=loop({url:'http://synthetic.invalid',model:'synthetic',messages:[{role:'user',content:'hello'}],tools:[],execute:async()=>({content:[]}),signal:new AbortController().signal,write:()=>{},beforeStep:async()=>{await gate;throw new Error('synthetic-revoked-lineage');},fetchImpl:async()=>{contacted=true;throw new Error('model must not be contacted');}});await Promise.resolve();assert.equal(contacted,false);released();await assert.rejects(running,/synthetic-revoked-lineage/);assert.equal(contacted,false);});
}
test('composed local budgeting runs only after the awaited original-head validation',async()=>{
 const state=syntheticProvider(),remove=installEncryptedRunAdmissionProvider(state.provider);let budgeted=false;
 try{await withRunAdmission(entry,async()=>{const hook=admittedModelStep(()=>{budgeted=true;});await hook([]);assert.equal(budgeted,true);budgeted=false;state.revoke();await assert.rejects(hook([]));assert.equal(budgeted,false);});assert.fail('revoked run completed');}catch(error){assert.match(String(error),/synthetic-head-changed/);}finally{remove();}
});
