require('./load.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');
const {primaryReplyModels,savePrimaryReply}=require('../src/primary-reply.ts');
const {whoAnswers}=require('../src/ChatView.tsx');
const models=[{id:'subscription:claude',provider:'subscription'},{id:'subscription:codex',provider:'subscription'},{id:'subscription:gemini',provider:'subscription'},{id:'installed-chat:latest',provider:'local'},{id:'api-cloud',provider:'openai'},{id:'subscription:unknown',provider:'subscription'}];
test('primary source lists official CLI sources and detected Ollama models only',()=>{assert.deepEqual(primaryReplyModels(models).map(m=>m.id),models.slice(0,4).map(m=>m.id));assert.equal(whoAnswers('subscription:gemini',[]).app.label,'Google Gemini');});
test('saving preserves agent identity and submits only a versioned model/provider update',async()=>{
 const agent={id:'primary',name:'Current agent',version:4,model:'old',provider:'old',isPrimary:true};const calls=[];
 const client={request:async r=>{calls.push(r);return {status:200,body:{agent:{...agent,...r.body,version:5}}};}};
 const result=await savePrimaryReply(client,agent,models,'subscription:gemini');assert.equal(result.name,agent.name);
 assert.deepEqual(calls[0],{method:'PUT',path:'/api/agents/primary',body:{expectedVersion:4,modelSelection:'subscription:gemini'}});
 await savePrimaryReply(client,agent,models,'installed-chat:latest');assert.equal(calls[1].body.modelSelection,'installed-chat:latest');assert.equal(calls[1].body.provider,undefined);
 await assert.rejects(savePrimaryReply(client,agent,models,'not-installed'));assert.equal(calls.length,2);
 await assert.rejects(savePrimaryReply({request:async()=>({status:409})},agent,models,'subscription:codex'),/source_not_saved/);
});

test('browser and local bridge accept the exact subscription update and retain Gemini/Ollama in projected catalogue',()=>{
 const {allowedRequest}=require('../src/session.ts');const {allowed}=require('../scripts/application-server.cjs');const {agentCardResponse}=require('../src/agent-card-contract.js');
 for(const permit of [allowedRequest,allowed]){const body={expectedVersion:4,provider:'subscription',model:'subscription:gemini'};assert.equal(permit('PUT','/api/agents/primary',body),true);assert.equal(permit('PUT','/api/agents/primary',{...body,api_key:'forbidden'}),false);assert.equal(permit('PUT','/api/agents/primary',{...body,model:'subscription:unknown'}),false);}
 const projected=agentCardResponse('/api/models',200,{models:models.slice(0,4)});assert.equal(primaryReplyModels(projected.models).length,4);assert.deepEqual(agentCardResponse('/api/models',200,projected),projected);
});
