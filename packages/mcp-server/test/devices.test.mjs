import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceDevicesDefinition,workspaceDevicesTool} from '../src/domains/devices.ts';
const fixture=()=>{const calls=[];return {calls,backend:{request:async(method,path,body)=>{calls.push({method,path,body});return path==='/api/auth/me'?{user:{role:'owner',status:'active'}}:{devices:[],attempts:[]};}}};};
test('device MCP offers bounded owner requests without enrollment or approvals',async()=>{
 const {calls,backend}=fixture();await workspaceDevicesTool({operation:'status'},backend);assert.equal(calls.at(-1).path,'/api/computers');
 await assert.rejects(()=>workspaceDevicesTool({operation:'request_task',target:'peer',task:{}},backend));
 await assert.rejects(()=>workspaceDevicesTool({operation:'pair',confirmed:true},backend));
 await assert.rejects(()=>workspaceDevicesTool({operation:'status',approvalTicket:'secret'},backend));
 await workspaceDevicesTool({operation:'request_task',target:'peer',task:{taskId:'selected_task'},confirmed:true},backend);assert.deepEqual(calls.at(-1),{method:'POST',path:'/api/computers/tasks',body:{target:'peer',task:{taskId:'selected_task'}}});
 await workspaceDevicesTool({operation:'select_sync',target:'peer',selection:{category:'preferences'},confirmed:true},backend);assert.equal(calls.at(-1).path,'/api/computers/sync/select');assert.ok(!calls.some(c=>/approve|pair|recover/.test(c.path)));
 assert.equal(workspaceDevicesDefinition.inputSchema.additionalProperties,false);
});
test('device MCP refuses nonowner identity before backend effect requests',async()=>{const calls=[];await assert.rejects(()=>workspaceDevicesTool({operation:'cancel_task',taskId:'task',confirmed:true},{request:async(...args)=>{calls.push(args);return {user:{role:'member',status:'active'}};}}));assert.equal(calls.length,1);});
test('agents can read new computers waiting to join, never answer for the owner',async()=>{
 const calls=[],backend={request:async(method,path)=>{calls.push({method,path});if(path==='/api/auth/me')return {user:{role:'owner',status:'active'}};return {pairing:{self:null,requests:[{deviceId:'d1',label:'Office PC',osFamily:'windows',code:'0123456789ab',publicKey:'k',elsewhere:false}],addedWithCode:[{deviceId:'d2',label:'Laptop',osFamily:'macos',publicKey:'k2'}]}};}};
 const r=await workspaceDevicesTool({operation:'join_requests'},backend);
 assert.equal(calls.at(-1).path,'/api/computers/account');
 assert.deepEqual(r.data,{waiting:[{label:'Office PC',osFamily:'windows',picturesReady:true,answeredElsewhere:false}],joinedWithCode:[{label:'Laptop',osFamily:'macos'}],thisComputerWaiting:false});
 assert.ok(!JSON.stringify(r).includes('0123456789ab')&&!JSON.stringify(r).includes('"k"'),'no codes or keys reach agents');
 for(const op of ['approve_join','answer_join','keep_added','twofactor'])await assert.rejects(()=>workspaceDevicesTool({operation:op,confirmed:true},backend));
 assert.ok(workspaceDevicesDefinition.description.includes('owner’s decision'));
});
test('agents read task rules, may only make them stricter, and see the free computer first (CP6, CP4)',async()=>{
 const calls=[];const backend={request:async(method,path,body)=>{calls.push({method,path,body});if(path==='/api/auth/me')return {user:{role:'owner',status:'active'}};if(path==='/api/computers')return {devices:[{id:'off',name:'Air',state:'offline',dispatchOptions:[]},{id:'pc',name:'Office PC',state:'available',capacity:{limit:3,active:0},dispatchOptions:[{id:'p',label:'Girru app',agentBinding:'a',modelBinding:'m'}]}]};return {rule:'ask',projects:{},always:[]};}};
 const s=await workspaceDevicesTool({operation:'suggest_target'},backend);assert.equal(s.data.computers[0].id,'pc');assert.equal(s.data.computers[0].projects[0].label,'Girru app');
 await workspaceDevicesTool({operation:'task_rules'},backend);assert.equal(calls.at(-1).path,'/api/computers/task-rules');
 await workspaceDevicesTool({operation:'set_task_rules',change:{rule:'refuse'},confirmed:true},backend);assert.deepEqual(calls.at(-1),{method:'POST',path:'/api/computers/task-rules/tighten',body:{rule:'refuse'}});
 await assert.rejects(()=>workspaceDevicesTool({operation:'rename_computer',deviceId:'pc',name:'Mac',confirmed:true},backend));
 await assert.rejects(()=>workspaceDevicesTool({operation:'set_task_rules',change:{rule:'auto'},confirmed:true},backend),/owner/);
 await assert.rejects(()=>workspaceDevicesTool({operation:'set_task_rules',change:{always:{source:'pc',projectId:'p',on:true}},confirmed:true},backend));
 await assert.rejects(()=>workspaceDevicesTool({operation:'set_task_rules',change:{back:{id:'p',via:'github'}},confirmed:true},backend),/owner/);
 await assert.rejects(()=>workspaceDevicesTool({operation:'set_task_rules',change:{rule:'ask'}},backend));
 await workspaceDevicesTool({operation:'rename_computer',deviceId:'pc',icon:'windows-pc',confirmed:true},backend);assert.deepEqual(calls.at(-1),{method:'POST',path:'/api/computers/look',body:{deviceId:'pc',icon:'windows-pc'}});
});
