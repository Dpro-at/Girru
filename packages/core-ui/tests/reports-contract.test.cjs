require('./load.cjs');const{test}=require('node:test'),assert=require('node:assert/strict');
const{allowedReports,reportsResponse}=require('../src/reports-contract.js'),{allowedRequest}=require('../src/session.ts'),{allowed}=require('../scripts/application-server.cjs');
const base='/api/reports',key='report-fixture',presentation={sections:[{id:'one',title:'Work overview',size:'wide',importance:'high',preferredType:'Text'}]},body={requestId:'request-1',expectedRevision:0,title:'My report',instructions:'Use available authorized sources.',agentId:'agent-1',projectId:null,presentation};
test('reports client and desktop bridge allow explicit owner report operations only',()=>{
 const requests=[['GET',base],['POST',base,body],['GET',base+'/'+key],['GET',base+'/'+key+'?snapshotId=snapshot-1'],['PUT',base+'/'+key,{...body,expectedRevision:1}],['POST',base+'/'+key+'/run',{requestId:'request-2',expectedRevision:1}],['PUT',base+'/'+key+'/schedule',{expectedRevision:1,calendar:{every:'monthly',day:31,at:'09:00',timezone:'Europe/Vienna'},paused:true}]];
 for(const args of requests)for(const check of[allowedReports,allowedRequest,allowed])assert.equal(check(...args),true,args[1]);
 for(const args of [['DELETE',base+'/'+key],['GET',base+'?ownerId=other'],['POST',base,{...body,ownerId:'other'}],['POST',base+'/'+key+'/run',{}],['GET',base+'/'+key+'?snapshotId=a&snapshotId=b'],['POST',base,{...body,presentation:{sections:[...presentation.sections,...presentation.sections]}}]])for(const check of[allowedReports,allowedRequest,allowed])assert.equal(check(...args),false,args[1]);
});
test('saved result projection strips unrelated fields and preserves personalized layout without dispatch',()=>{
 const report={...body,id:key,revision:1,status:'idle',conversationId:'session-1',secret:'omit'};
 const output=reportsResponse(base+'/'+key,200,{report,snapshot:null,history:[],schedule:null,token:'omit'});assert.deepEqual(output.report.presentation,presentation);assert.equal(output.token,undefined);assert.equal(output.report.secret,undefined);
 assert.throws(()=>reportsResponse(base+'/'+key,200,{report:{...report,presentation:{sections:[]}}}));
});

test('project task source requires a project, known views, and keeps task navigation as bounded read metadata',()=>{
 const p={source:'project_tasks',sections:[{...presentation.sections[0],preferredType:'Table',boardView:'tasks'}]},draft={...body,projectId:'project-1',presentation:p};
 for(const gate of[allowedReports,allowedRequest,allowed]){assert.equal(gate('POST',base,draft),true);assert.equal(gate('POST',base,{...draft,projectId:null}),false);assert.equal(gate('POST',base,{...draft,presentation:{...p,sections:[{...p.sections[0],boardView:'execute'}]}}),false);}
 const report={...draft,id:key,revision:1,status:'complete',conversationId:'session-1'},snapshot={id:'snapshot-1',runId:'run-1',revision:1,presentation:p,capturedAt:'2026-11-08T12:00:00Z',sections:[{id:'one',document:{},sourceLabel:'Board',tasks:[{boardId:'board-1',cardId:'card-1',title:'Task',action:'delete'},{boardId:'../bad',cardId:'card-2'}]}]};
 const out=reportsResponse(base+'/'+key,200,{report,snapshot,history:[],schedule:null});assert.deepEqual(out.snapshot.sections[0].tasks,[{boardId:'board-1',cardId:'card-1',title:'Task'}]);
});
