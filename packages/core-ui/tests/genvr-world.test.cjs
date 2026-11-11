require('./load.cjs');const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
// GENVR-WORLD-01 P1: the world chat routes pass the browser and bridge boundaries only in their exact shapes.
const {allowedGenVR,genvrResponse,validWorldTurn,changesWorld,worldRoute}=require('../src/genvr-contract.js'),{allowed}=require('../scripts/application-server.cjs'),{allowedRequest}=require('../src/session.ts');
const turn={messages:[{role:'system',content:'Guide'},{role:'user',content:'Put a tree here'},{role:'assistant',content:'',tool_calls:[{function:{name:'place_item',arguments:{itemId:'oak'}}}]},{role:'tool',tool_name:'place_item',content:'Placed.'},{role:'user',content:'Thanks'}],tools:[{type:'function',function:{name:'place_item',description:'Place one item.',parameters:{type:'object'}}}]};
const answerer={id:'main-agent',name:'Sara',detail:'Claude Code',color:'#c2417a'};

test('world routes: exact bodies only, in every boundary',()=>{
 const open='/api/genvr/worlds/rooftop-city/open',agent='/api/genvr/worlds/rooftop-city/agent',run='/api/genvr/worlds/rooftop-city/turn';
 for(const check of [allowedGenVR,allowed,allowedRequest]){
  assert.equal(check('POST',open,{name:'Rooftop city'}),true);assert.equal(check('PUT',agent,{agentId:'main-agent'}),true);assert.equal(check('POST',run,turn),true);
  assert.equal(check('GET',open),false);assert.equal(check('POST',open,{name:'x',folder:'/etc'}),false);assert.equal(check('PUT',agent,{agentId:'../keys'}),false);
  assert.equal(check('POST','/api/genvr/worlds/../keys/open',{name:'x'}),false);assert.equal(check('POST','/api/genvr/worlds/rooftop-city/delete',{}),false);
 }
 assert.equal(worldRoute(run),true);assert.equal(worldRoute('/api/genvr/worlds/a/b'),false);
});

test('a model turn body is checked for roles, tool calls, names and size',()=>{
 assert.equal(validWorldTurn(turn),true);
 const bad=[{...turn,extra:1},{messages:[],tools:[]},{messages:[{role:'boss',content:'x'}],tools:[]},{messages:[{role:'user',content:'x',tool_calls:[]}],tools:[]},
  {messages:[{role:'assistant',content:'',tool_calls:[{function:{name:'Bad Name',arguments:{}}}]}],tools:[]},{messages:[{role:'user',content:'x'}],tools:[{type:'function',function:{name:'x',description:'d'}}]},
  {messages:[{role:'user',content:'x'.repeat(100001)}],tools:[]},{messages:Array.from({length:201},()=>({role:'user',content:'x'})),tools:[]}];
 for(const body of bad)assert.equal(validWorldTurn(body),false,JSON.stringify(body).slice(0,80));
 assert.equal(validWorldTurn({messages:Array.from({length:30},()=>({role:'user',content:'x'.repeat(90000)})),tools:[]}),false);
});

test('responses keep only known fields and reject forged shapes',()=>{
 const open='/api/genvr/worlds/rooftop-city/open',run='/api/genvr/worlds/rooftop-city/turn';
 assert.deepEqual(genvrResponse(open,200,{folder:'~/Girru/genvr_Worlds/Rooftop city',chatProjectId:'0a1b2c3d-1111-2222-3333-444455556666',answerer:{...answerer,systemPrompt:'private'},token:'x'}),{folder:'~/Girru/genvr_Worlds/Rooftop city',chatProjectId:'0a1b2c3d-1111-2222-3333-444455556666',answerer});
 assert.deepEqual(genvrResponse(run,200,{content:'Done',tool_calls:[{function:{name:'place_item',arguments:{itemId:'oak'}}}],answerer,usage:{}}),{content:'Done',tool_calls:[{function:{name:'place_item',arguments:{itemId:'oak'}}}],answerer});
 assert.throws(()=>genvrResponse(run,200,{content:'Done',tool_calls:[{function:{name:'x',arguments:'{}'}}],answerer}));
 assert.throws(()=>genvrResponse(open,200,{folder:'f',chatProjectId:null,answerer:{...answerer,color:'red'}}));
 assert.deepEqual(genvrResponse(run,409,{code:'model_unavailable',message:'Pick another agent.',stack:'x'}),{code:'model_unavailable',message:'Pick another agent.'});
 assert.equal(genvrResponse(run,500,{code:'boom'}),null);
});

test('reading and avatar moves run at once; every other Studio tool asks first',()=>{
 for(const name of ['get_world_summary','search_catalog','present_avatar','ask_user'])assert.equal(changesWorld(name),false);
 for(const name of ['place_item','remove_items','make_world','set_script','world_history','user_avatar_library','share_studio','some_new_tool'])assert.equal(changesWorld(name),true);
});

test('the Studio frame host bridges the chat with checked messages only',()=>{
 const host=fs.readFileSync(path.join(__dirname,'../scripts/genvr-host.js'),'utf8');
 assert.match(host,/data\.chat===true\?hostChat\(\):\{\}/);
 assert.match(host,/'model-result'/);assert.match(host,/event\.source!==parent\|\|event\.origin!==location\.origin/);
 assert.match(host,/\/\^\[a-z_\]\{1,64\}\$\/\.test\(c\.function\.name\)/);assert.match(host,/data\.count<=50/);assert.match(host,/document\.body\.dispatchEvent\(new KeyboardEvent/);
 assert.match(host,/studio\.setChat\(data\.info\)/);
});

test('GenVR page: chat bar, approval card and Undo only for the owner with a world open',()=>{
 const React=require('../node_modules/react'),{renderToStaticMarkup}=require('../node_modules/react-dom/server'),{GenVRPage,callLine}=require('../src/GenVRPage.tsx');
 const html=renderToStaticMarkup(React.createElement(GenVRPage,{client:{getSnapshot:()=>({user:{role:'owner'}})},active:false}));assert.doesNotMatch(html,/Answers here|Changes the world/);
 assert.equal(callLine({function:{name:'place_item',arguments:{itemId:'Oak tree'}}}),'place item · Oak tree');assert.equal(callLine({function:{name:'make_world',arguments:{}}}),'make world');
});
