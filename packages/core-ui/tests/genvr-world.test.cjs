require('./load.cjs');const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
// GENVR-WORLD-01 P1: the world chat routes pass the browser and bridge boundaries only in their exact shapes.
const {allowedGenVR,genvrResponse,worldRoute}=require('../src/genvr-contract.js'),{allowed}=require('../scripts/application-server.cjs'),{allowedRequest}=require('../src/session.ts');
const answerer={id:'main-agent',name:'Sara',detail:'Claude Code',color:'#c2417a'};

test('world routes: exact bodies only, in every boundary; the old model turn is gone',()=>{
 const open='/api/genvr/worlds/rooftop-city/open',agent='/api/genvr/worlds/rooftop-city/agent',history='/api/genvr/worlds/rooftop-city/history',old='/api/genvr/worlds/rooftop-city/turn';
 for(const check of [allowedGenVR,allowed,allowedRequest]){
  assert.equal(check('POST',open,{name:'Rooftop city'}),true);assert.equal(check('PUT',agent,{agentId:'main-agent'}),true);assert.equal(check('GET',history),true);
  assert.equal(check('POST',old,{messages:[{role:'user',content:'x'}],tools:[]}),false);assert.equal(check('POST',history,{}),false);
  assert.equal(check('GET',open),false);assert.equal(check('POST',open,{name:'x',folder:'/etc'}),false);assert.equal(check('PUT',agent,{agentId:'../keys'}),false);
  assert.equal(check('POST','/api/genvr/worlds/../keys/open',{name:'x'}),false);assert.equal(check('POST','/api/genvr/worlds/rooftop-city/delete',{}),false);
 }
 assert.equal(worldRoute(history),true);assert.equal(worldRoute(old),false);assert.equal(worldRoute('/api/genvr/worlds/a/b'),false);
});

test('responses keep only known fields and reject forged shapes',()=>{
 const open='/api/genvr/worlds/rooftop-city/open';
 assert.deepEqual(genvrResponse(open,200,{folder:'~/Girru/genvr_Worlds/Rooftop city',chatProjectId:'0a1b2c3d-1111-2222-3333-444455556666',answerer:{...answerer,systemPrompt:'private'},token:'x'}),{folder:'~/Girru/genvr_Worlds/Rooftop city',chatProjectId:'0a1b2c3d-1111-2222-3333-444455556666',answerer});
 assert.throws(()=>genvrResponse(open,200,{folder:'f',chatProjectId:null,answerer:{...answerer,color:'red'}}));
});

test('the Studio frame host bridges the real chat with checked messages only',()=>{
 const host=fs.readFileSync(path.join(__dirname,'../scripts/genvr-host.js'),'utf8');
 assert.match(host,/data\.chat===true\?hostChat\(\):\{\}/);assert.match(host,/event\.source!==parent\|\|event\.origin!==location\.origin/);
 assert.ok(host.includes("operation:'chat-send'"));assert.ok(host.includes("data.operation==='chat-delta'"));assert.match(host,/studio\.setChat\(data\.info\)/);
 assert.ok(!host.includes('model-result')&&!host.includes('model-delta'));
});

test('coming back to Chat from GenVR reloads the chat projects and list (a renamed place shows its new name)',()=>{
 const shell=fs.readFileSync(path.join(__dirname,'../src/SignedInShell.tsx'),'utf8');
 assert.ok(shell.includes("if (page === 'chat' && from === 'genvr' && chat) void (async () => { await chat.loadProjects(); await chat.refreshList(); })()"));
});
