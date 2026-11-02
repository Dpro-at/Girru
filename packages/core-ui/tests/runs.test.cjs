require('./load.cjs');
// RUNS-01: the Runs section — the wire contract (only its routes, only known fields) and the page.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {allowedRuns,runsResponse,runsRoute}=require('../src/runs-contract.js');
const {allowedRequest}=require('../src/session.ts');
const {allowed}=require('../scripts/application-server.cjs');
test('only the Runs routes pass, on both sides of the bridge',()=>{
 for(const p of ['/api/runs','/api/runs?place=failed','/api/runs?place=waiting&kind=chat&agent=a-1&project=p-1&q=mail&before=123&limit=50','/api/runs/item/chat%3Arun-1','/api/runs/schedules','/api/runs/schedules/job%3Ajob-1/runs']){assert.ok(allowedRequest('GET',p),p);assert.ok(allowed('GET',p),p);}
 for(const p of ['/api/runs/item/task%3At-1/stop','/api/runs/item/chat%3Ar-1/retry']){assert.ok(allowedRequest('POST',p,{}),p);assert.ok(allowed('POST',p,{}),p);assert.equal(allowedRequest('POST',p,{force:true}),false);assert.equal(allowedRequest('POST',p),false);}
 for(const p of ['/api/runs?place=everything','/api/runs?kind=x','/api/runs?place=failed&place=done','/api/runs?extra=1','/api/runs?before=-1','/api/runs/item/../x','/api/runs/item/chat:r-1','/api/runs/item/nope%3Ax','/api/runs/schedules/chat%3Ax/runs','/api/runs/item/chat%3Ar/delete','/api/runs/schedules?x=1'])assert.equal(allowedRuns('GET',p),false,p);
 assert.equal(allowedRequest('DELETE','/api/runs/item/chat%3Ar-1'),false);assert.equal(allowedRequest('POST','/api/runs',{}),false);assert.equal(allowedRequest('GET','/api/runs/item/chat%3Ar-1/stop'),false);
});
const run={id:'chat:r-1',kind:'chat',title:'Plan the post',state:'failed',reason:{code:'offline',title:'The app was offline',text:'The model was not available. Not a bug in Girru.',bug:false,extra:'x'},agentId:'a-1',agentName:'Nora',app:'Claude Code',model:'subscription:claude-code',projectId:'p-1',projectName:'Girru',startedBy:'schedule',startedAt:'2026-11-02T10:00:00.000Z',endedAt:'2026-11-02T10:01:00.000Z',needsYou:false,link:{sessionId:'s-1',secret:'hidden'},userId:'hidden',raw:'private'};
test('only known fields come back; the projection is stable on both sides',()=>{
 const p='/api/runs?place=failed',first=runsResponse(p,200,{runs:[run],next:5,counts:{running:1,waiting:2},debug:'private'});
 assert.deepEqual(runsResponse(p,200,first),first);assert.doesNotMatch(JSON.stringify(first),/private|hidden|extra/);
 assert.equal(first.runs[0].reason.title,'The app was offline');assert.deepEqual(first.counts,{running:1,waiting:2});
 const d='/api/runs/item/chat%3Ar-1',detail=runsResponse(d,200,{run,steps:[{title:'memory search',meta:'tool',state:'done'}],log:[{at:'10:00:00',text:'run started'}],result:{text:'ok',tokensIn:10,tokensOut:5,costCents:null},copy:'Run: Plan the post'});
 assert.deepEqual(runsResponse(d,200,detail),detail);assert.equal(detail.copy,'Run: Plan the post');
 assert.throws(()=>runsResponse('/api/runs/item/chat%3Aother',200,{run,steps:[],log:[],result:{},copy:''}),'a different run is refused');
 assert.throws(()=>runsResponse(p,200,{runs:[{...run,state:'exploded'}]}));
 const sch=runsResponse('/api/runs/schedules',200,{schedules:[{id:'job:j-1',kind:'job',title:'Weekly memory summary',when:'Every Sunday at 22:00',enabled:true,nextRun:null,lastRun:null,lastResult:'failed',lastReason:null,agentId:null,agentName:null,link:{jobId:'j-1',runId:'job:1',bad:'x'}}]});
 assert.deepEqual(sch.schedules[0].link,{jobId:'j-1',runId:'job:1'});
 assert.deepEqual(runsResponse(d,404,{error:'Run not found'}),{code:'not_found'});
 assert.equal(runsRoute('/api/runs/item/chat%3Ar-1/retry').kind,'retry');
});
test('Runs is a footer section after Board; the page renders its places with no automatic request',()=>{
 const React=require('../node_modules/react'),{renderToStaticMarkup}=require('../node_modules/react-dom/server'),{RunsDestination,RUN_PLACES}=require('../src/RunsDestination.tsx');
 const {FOOTER_SECTIONS,DEFAULT_FOOTER}=require('../src/footer-contract.js');
 assert.equal(FOOTER_SECTIONS[FOOTER_SECTIONS.indexOf('board')+1],'runs');assert.ok(!DEFAULT_FOOTER.hidden.includes('runs'));
 assert.deepEqual(RUN_PLACES.map(p=>p.label),['Running now','Waiting','Scheduled','Finished','Failed or stopped']);
 let calls=0;const client={subscribe:()=>()=>{},getSnapshot:()=>({phase:'authenticated',epoch:1,user:{role:'owner'}}),request:()=>{calls++;return new Promise(()=>{});}};
 const html=renderToStaticMarkup(React.createElement(RunsDestination,{client,active:true,onOpenChat(){},onOpenCard(){},onOpenAgent(){},onOpenApprovals(){}}));
 for(const s of ['Running now','Waiting','Scheduled','Finished','Failed or stopped','Search runs','Show or hide the details'.slice(0,0)||'the details (⌥⌘I)'])assert.ok(html.includes(s),s);
 assert.match(html,/aria-label="Runs places"/);assert.equal(calls,0);
 const shell=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/SignedInShell.tsx'),'utf8');
 assert.match(shell,/runs:entry\('runs',user\.role!=='guest'\)/);assert.match(shell,/<RunsDestination /);
 const settings=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/AppSettings.tsx'),'utf8');
 assert.doesNotMatch(settings,/ScheduledTasks|'schedules'/,'the old Settings page is gone');
});
test('Schedule a task (board RN6): only instructions and when pass; the old send-a-message editor is not opened from Runs',()=>{
 const p='/api/runs/schedules';
 assert.ok(allowedRequest('POST',p,{instructions:'Sum up the mails',every:'daily',at:'08:30'}));assert.ok(allowed('POST',p,{instructions:'Sum up the mails',every:'weekly',at:'08:30',weekday:1,agentId:'a-1',notify:'all',newChat:false,thinking:'deep',projectId:'p-1',model:'subscription:codex'}));
 for(const b of [{},{instructions:'',every:'daily',at:'08:30'},{instructions:'x',every:'monthly',at:'08:30'},{instructions:'x',every:'daily',at:'8:30'},{instructions:'x',every:'daily',at:'08:30',actionType:'api-call'},{instructions:'x',every:'daily',at:'08:30',notify:'loud'}])assert.equal(allowedRequest('POST',p,b),false,JSON.stringify(b));
 assert.deepEqual(runsResponse(p,201,{id:'cardsch:c-1',boardId:'b-1',cardId:'c-1',extra:'x'}),{id:'cardsch:c-1',boardId:'b-1',cardId:'c-1'});
 const {suggestAgent}=require('../src/ScheduleTaskSheet.tsx');
 const agents=[{id:'a-main',name:'Sami',primary:true},{id:'a-mk',name:'Nora',department:'Marketing'},{id:'a-fin',name:'Lina',department:'Finance'}];
 assert.equal(suggestAgent('Ask Nora to post',agents),'a-mk');assert.equal(suggestAgent('Write the marketing report',agents),'a-mk');assert.equal(suggestAgent('Check the finance numbers',agents),'a-fin');assert.equal(suggestAgent('Say hello',agents),'a-main');
 const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/RunsDestination.tsx'),'utf8');
 assert.match(src,/<ScheduleTaskSheet /);assert.doesNotMatch(src,/NewScheduleSheet|creating/);
});
test('sub-tasks come through the contract and nest under their main task',()=>{
 const d='/api/runs/item/chat%3Ar-1',base={id:'chat:r-1',kind:'chat',title:'Plan',state:'working',reason:null,agentId:null,agentName:null,app:null,model:null,projectId:null,projectName:null,startedBy:'you',startedAt:'2026-11-02T10:00:00.000Z',endedAt:null,needsYou:false,parentId:null,link:{}};
 const child={...base,id:'handoff:h-1',kind:'handoff',title:'Sami · a part',state:'failed',parentId:'chat:r-1'};
 const x=runsResponse(d,200,{run:base,subtasks:[child],subNotice:{code:'subtask_stopped',title:'A sub-task stopped: did not finish',text:'…',bug:false},steps:[],log:[],result:{},copy:''});
 assert.equal(x.subtasks[0].parentId,'chat:r-1');assert.equal(x.subNotice.code,'subtask_stopped');assert.deepEqual(runsResponse(d,200,x),x);
 assert.ok(allowedRequest('GET','/api/runs/item/handoff%3Ah-1'));assert.ok(allowedRequest('GET','/api/runs?place=running&kind=handoff'));
});
