import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {subscriptionModel,subscriptionArgs,subscriptionAnswer,subscriptionVariants,geminiReplyConfig} from '../src/services/subscription-chat.ts';
import {subscriptionToolLoop} from '../src/services/subscription-tool-loop.ts';
const tool={name:'test_lookup',description:'Synthetic lookup',input_schema:{type:'object',properties:{}}};
test('Gemini ids, output and native-session isolation',async()=>{
 assert.equal(subscriptionModel('subscription:gemini'),true);
 assert.equal(subscriptionModel('subscription:gemini/gemini-3-pro'),true);
 assert.equal(subscriptionModel('subscription:gemini:'+ 'a'.repeat(32)),false);
 assert.equal(subscriptionModel('subscription:gemini/--yolo'),false);
 assert.throws(()=>subscriptionArgs('gemini','native-id'),/session_missing/);
 const args=subscriptionArgs('gemini');assert.ok(args.includes('plan'));assert.ok(args.includes('--sandbox'));assert.ok(args.includes('--disable-slash-commands'));assert.ok(!args.includes('--yolo'));
 const frames=[{event:'init',init:{permission_mode:'request-review'}},{event:'result',result:{status:'SUCCESS',response:'hello'}}];
 assert.equal(subscriptionAnswer('gemini',frames.map(x=>JSON.stringify(x)).join('\n')),'hello');
 assert.throws(()=>subscriptionAnswer('gemini',JSON.stringify({response:'legacy-format'})));
 assert.throws(()=>subscriptionAnswer('gemini',[...frames,{event:'step_update',step_update:{step_type:'tool',tool_name:'run_command'}}].map(x=>JSON.stringify(x)).join('\n')));
 assert.throws(()=>subscriptionAnswer('gemini','{"response":"bad","error":{"code":401}}'));
 // CH3: Gemini Pro / Gemini Flash under the Gemini group; only a listed key reaches agy --model.
 assert.deepEqual(await subscriptionVariants('gemini'),[{id:'gemini-3.1-pro',label:'Gemini Pro',note:'Long documents and research'},{id:'gemini-3.8-flash',label:'Gemini Flash',note:'Quick'}]);
 const pro=subscriptionArgs('gemini',undefined,'gemini-3.1-pro');assert.deepEqual(pro.slice(pro.indexOf('--model'),pro.indexOf('--model')+2),['--model','gemini-3.1-pro']);
 for(const v of ['gemini-9-unknown','--yolo','opus',''])assert.ok(!subscriptionArgs('gemini',undefined,v).includes('--model'),v);
 assert.equal(subscriptionModel('subscription:gemini/gemini-3.8-flash'),true);
});
test('Antigravity uses an empty private workspace and refuses unsafe ambient CLI settings',async()=>{
 const root=await fs.mkdtemp('/tmp/dpro-agy-config-test-');const home=root+'/synthetic-home';await fs.mkdir(home+'/.gemini/antigravity-cli',{recursive:true});
 const file=home+'/.gemini/antigravity-cli/settings.json';await fs.writeFile(file,JSON.stringify({trustedWorkspaces:[]}));
 const config=await geminiReplyConfig(root,home);try{assert.deepEqual(await fs.readdir(config.dir),[]);assert.equal((await fs.stat(config.dir)).mode&0o777,0o700);}finally{await config.cleanup();}await assert.rejects(fs.stat(config.dir));
 for(const body of [{modelProvider:'gemini'},{toolPermission:'always-proceed'},{permissions:{allow:['command(*)']}},{hooks:{start:'unsafe'}}]){await fs.writeFile(file,JSON.stringify(body));await assert.rejects(geminiReplyConfig(root,home),/cli_config_unsafe/);}
});
test('Girru tools are offered and executed through the supplied registry, then the result returns to the model',async()=>{
 let calls=0,executed=0;
 const result=await subscriptionToolLoop({prompt:'Synthetic task',signal:new AbortController().signal,tools:[tool],
 reply:async prompt=>{calls++;if(calls===1){assert.match(prompt,/test_lookup/);return JSON.stringify({type:'tool',name:tool.name,arguments:{}});}assert.match(prompt,/found synthetic item/);return '{"type":"answer","text":"Done"}';},
 execute:async(name)=>{assert.equal(name,tool.name);executed++;return {content:[{type:'text',text:'found synthetic item'}]};}});
 assert.equal(result,'Done');assert.equal(executed,1);
});
test('unknown tool, abort, pending approval and iteration limits fail closed without repeated execution',async()=>{
 const base={prompt:'test',signal:new AbortController().signal,tools:[tool],execute:async()=>{throw Error('must not run');}};
 await assert.rejects(subscriptionToolLoop({...base,reply:async()=>'{"type":"tool","name":"unoffered","arguments":{}}'}),/cli_tool_invalid/);
 const abort=new AbortController();abort.abort();await assert.rejects(subscriptionToolLoop({...base,signal:abort.signal,reply:async()=>{throw Error('must not call');}}),/cancelled/);
 let calls=0;const text=await subscriptionToolLoop({...base,reply:async()=>{calls++;return '{"type":"tool","name":"test_lookup","arguments":{}}';},execute:async()=>({content:[{type:'text',text:'Awaiting approval'}],details:{status:'pending_approval'}})});
 assert.equal(text,'This waits for your approval.');assert.equal(calls,1); // CHAT-LIVE-01: one plain line; the card shows what waits
 let executions=0;await assert.rejects(subscriptionToolLoop({...base,reply:async()=>'{"type":"tool","name":"test_lookup","arguments":{}}',execute:async()=>{executions++;return {content:[]};}}),/cli_tool_limit/);assert.equal(executions,16); // CHAT-CONTENT-01: 16 steps
});
test('reply-only native launches keep Girru execution behind its own tool registry',()=>{
 const claude=subscriptionArgs('claude',undefined,undefined,true);assert.equal(claude[claude.indexOf('--tools')+1],'');
 const codex=subscriptionArgs('codex',undefined,undefined,true);assert.equal(codex[codex.indexOf('--sandbox')+1],'read-only');assert.ok(codex.includes('shell_tool'));assert.ok(codex.includes('unified_exec'));assert.ok(codex.includes('web_search="disabled"'));
});
test('oversized tool catalogues refuse before a model call',async()=>{
 await assert.rejects(subscriptionToolLoop({prompt:'x'.repeat(200000),signal:new AbortController().signal,tools:[tool],reply:async()=>{throw Error('must not call');},execute:async()=>{throw Error('must not run');}}),/cli_input_invalid/);
});
