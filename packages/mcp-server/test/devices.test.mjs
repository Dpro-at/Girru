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
