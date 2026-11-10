const test=require('node:test');const assert=require('node:assert/strict');
test('computer boundary permits only explicit bounded requests and projects known state',async()=>{const C=await import('../src/computer-contract.js');const task={taskId:'task',attemptId:'attempt',projectBinding:'project',agentBinding:'agent',modelBinding:'model',text:'Synthetic task'};assert.equal(C.allowedComputer('POST','/api/computers/tasks',{target:'computer',task}),true);assert.equal(C.allowedComputer('POST','/api/computers/tasks',{target:'computer',task:{...task,token:'x'}}),false);assert.equal(C.allowedComputer('GET','/api/computers',{}),false);assert.throws(()=>C.computerResponse('/api/computers',200,{testOnly:true,productionEnrollment:{enabled:true},devices:[],attempts:[]}));assert.equal(C.computerResponse('/api/computers',200,{testOnly:false,productionEnrollment:{enabled:false},self:null,devices:[],attempts:[]}).testOnly,false);});
test('computer linking, selected review and recovery retain explicit UI request boundaries',async()=>{
 const C=await import('../src/computer-contract.js');assert.equal(C.allowedComputer('POST','/api/computers/listen',{host:'127.0.0.1',port:0}),true);assert.equal(C.allowedComputer('POST','/api/computers/listen',{host:'127.0.0.1',port:0,discover:true}),false);assert.equal(C.allowedComputer('POST','/api/computers/pairing/id/approve',{checkCode:'123456',join:true}),true);assert.equal(C.allowedComputer('POST','/api/computers/sync/id/review',{agentId:'local_agent',expectedRevision:0,resolveConflict:true}),true);assert.equal(C.allowedComputer('POST','/api/computers/sync/id/review',{agentId:'local_agent',expectedRevision:0,grantTools:true}),false);assert.equal(C.allowedComputer('POST','/api/computers/recovery/complete',{reviewId:'review',fingerprint:'bound',ownerProof:{response:'local-only'}}),true);assert.equal(C.allowedComputer('POST','/api/computers/recovery/complete',{reviewId:'review',fingerprint:'bound',ownerProof:{},token:'transport-secret'}),false);assert.equal(C.allowedComputer('POST','/api/computers/configure',{provider:'untrusted'}),false);
});
test('the project sheet may save a chosen folder and how work comes back, nothing else',async()=>{
 const C=await import('../src/computer-contract.js');
 assert.equal(C.allowedComputer('POST','/api/computers/works-on/folder',{folder:'/Users/me/website',confirmed:true}),true);
 assert.equal(C.allowedComputer('POST','/api/computers/works-on/folder',{folder:'/Users/me/website'}),false);
 assert.equal(C.allowedComputer('POST','/api/computers/works-on/folder',{folder:'',confirmed:true}),false);
 assert.equal(C.allowedComputer('POST','/api/computers/works-on/folder',{folder:'/x',confirmed:true,url:'https://x'}),false);
 assert.equal(C.allowedComputer('POST','/api/computers/task-rules',{back:{id:'p1',via:'direct'}}),true);
});
test('CP14: a task to another computer may carry the Board fields (title, priority), nothing else', async () => {
 const C = await import('../src/computer-contract.js');
 const base = {taskId: 't1', attemptId: 'a1', projectBinding: 'p1', agentBinding: 'g1', modelBinding: 'm1', text: 'git pull origin main'};
 assert.equal(C.allowedComputer('POST', '/api/computers/tasks', {target: 'd1', task: {...base, title: 'Pull main', priority: 'normal'}}), true);
 assert.equal(C.allowedComputer('POST', '/api/computers/tasks', {target: 'd1', task: {...base, priority: 'huge'}}), false);
 assert.equal(C.allowedComputer('POST', '/api/computers/tasks', {target: 'd1', task: {...base, title: 'x\u0000'}}), false);
 assert.equal(C.allowedComputer('POST', '/api/computers/tasks', {target: 'd1', task: {...base, folder: '/etc'}}), false);
});
