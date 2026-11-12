import test from 'node:test';
import assert from 'node:assert/strict';
import {callTool,TOOL_DEFINITIONS} from '../src/tools.ts';
import {BackendError} from '../src/backend.ts';

const project=()=>({id:'space-1',format:'genvr-studio',version:1,title:'Park',world:{style:{base:'blocky'},sizeTier:'small'},play:{view:'free',orientation:'landscape',devices:['phone','computer','vr']}});
function fake(){
 const state={doc:{project:project(),revision:3,agents:[]},calls:[]};
 const items=[{manifest:{id:'oak',name:'Old oak',category:'nature',styles:['voxel'],price:{type:'free'},author:{name:'Lina'}},caption:'Tree',tags:['park']},{manifest:{id:'car',name:'Red car',category:'vehicle',styles:[],price:{type:'paid',coins:40}},caption:null,tags:[]}];
 const backend={async request(method,path,body){state.calls.push({method,path,body});
  if(path==='/api/genvr/projects')return {projects:[{id:'space-1',title:'Park',style:'blocky',sizeTier:'small',view:'free',devices:['phone'],agentCount:0,lab:false},{id:'lab-1',title:'Lab',lab:true}]};
  if(path==='/api/genvr/agents')return {agents:[{id:'sara',name:'Sara',avatar:2},{id:'omar',name:'Omar',avatar:null}]};
  if(path.startsWith('/api/genvr/market'))return {items,next:null};
  if(path==='/api/genvr/projects/space-1'&&method==='GET')return JSON.parse(JSON.stringify(state.doc));
  if(path==='/api/genvr/projects/space-1'&&method==='PUT'){if(body.revision!==state.doc.revision)throw new BackendError('conflict',409);state.doc={project:body.project,revision:body.revision+1,agents:body.agents??state.doc.agents};return {saved:true,revision:state.doc.revision};}
  throw new BackendError('not found',404);}};
 return {state,deps:{backend}};
}
const data=out=>JSON.parse(out.content.at(-1).text.startsWith('{')?out.content.at(-1).text:'{}');
const run=(deps,args)=>callTool('genvr_spaces',args,deps);

test('genvr_spaces is listed and reads spaces, agents and the market',async()=>{
 assert.ok(TOOL_DEFINITIONS.some(t=>t.name==='genvr_spaces'));
 const {deps}=fake();
 const list=await run(deps,{operation:'list'});assert.notEqual(list.isError,true);assert.equal(list.structuredContent.spaces.length,1);assert.equal(list.structuredContent.spaces[0].view,'3d');
 const got=await run(deps,{operation:'get',space_id:'space-1'});assert.equal(got.structuredContent.title,'Park');assert.deepEqual(got.structuredContent.game,{on:false});
 const free=await run(deps,{operation:'market',price:'free',query:'park'});assert.deepEqual(free.structuredContent.items.map(i=>i.item_id),['oak']);
 const paid=await run(deps,{operation:'market',item_id:'car'});assert.equal(paid.structuredContent.items[0].price,'40 coins');
 assert.equal((await run(deps,{operation:'market',item_id:'car',query:'x'})).isError,true);
});

test('set_play, set_game and set_agents keep the page limits and save with the revision',async()=>{
 const {state,deps}=fake();
 assert.equal((await run(deps,{operation:'set_play',space_id:'space-1',moves:['dash']})).isError,true,'moves need 2d');
 let out=await run(deps,{operation:'set_play',space_id:'space-1',view:'2d',moves:['dash','double-jump'],devices:['tv','phone']});
 assert.notEqual(out.isError,true);assert.equal(state.doc.project.play.view,'side');assert.deepEqual(state.doc.project.play.moves,['double-jump','dash']);
 assert.deepEqual(state.doc.project.play.devices,['phone','tv','vr'],'a VR choice made elsewhere is kept');assert.equal(state.doc.revision,4);
 assert.equal((await run(deps,{operation:'set_play',space_id:'space-1',devices:[]})).isError,true);
 assert.equal((await run(deps,{operation:'set_game',space_id:'space-1',health:50})).isError,true,'game is off');
 out=await run(deps,{operation:'set_game',space_id:'space-1',on:true,match_minutes:2.5,score_to_win:20});
 assert.notEqual(out.isError,true);assert.equal(state.doc.project.world.game.match.durationSec,150);assert.equal(state.doc.project.world.game.score.goal,20);assert.equal(state.doc.project.world.game.win.by,'highest_score');
 for(const bad of [{health:0},{health:1001},{players_to_start:51},{back_in_seconds:61},{match_minutes:31},{friendly_fire:true}])assert.equal((await run(deps,{operation:'set_game',space_id:'space-1',...bad})).isError,true,JSON.stringify(bad));
 out=await run(deps,{operation:'set_game',space_id:'space-1',teams:'two',friendly_fire:true,score_to_win:null});
 assert.deepEqual(state.doc.project.world.game.teams,{mode:'two',friendlyFire:true});assert.equal(state.doc.project.world.game.score.goal,undefined);
 assert.equal((await run(deps,{operation:'set_game',space_id:'space-1',on:false,health:5})).isError,true);
 out=await run(deps,{operation:'set_game',space_id:'space-1',on:false});assert.equal(state.doc.project.world.game,undefined);
 out=await run(deps,{operation:'set_agents',space_id:'space-1',add:['sara','omar']});assert.deepEqual(state.doc.agents,[{id:'sara',avatar:2},{id:'omar',avatar:0}]);
 assert.equal((await run(deps,{operation:'set_agents',space_id:'space-1',add:['ghost']})).isError,true);
 out=await run(deps,{operation:'set_agents',space_id:'space-1',remove:['sara']});assert.deepEqual(out.structuredContent.agents,[{id:'omar',name:'Omar'}]);
 out=await run(deps,{operation:'rename',space_id:'space-1',title:'  Big park '});assert.equal(state.doc.project.title,'Big park');
});

test('genvr_spaces refuses unknown fields, bad ids and reports a newer copy',async()=>{
 const {state,deps}=fake();
 for(const args of [{operation:'publish'},{operation:'get',space_id:'../x'},{operation:'get',space_id:'space-1',title:'x'},{operation:'list',space_id:'space-1'},{operation:'rename',space_id:'space-1',title:''}])assert.equal((await run(deps,args)).isError,true,JSON.stringify(args));
 const original=deps.backend.request;deps.backend.request=async(m,p,b)=>{if(m==='PUT'){state.doc.revision+=1;}return original(m,p,b);};
 const out=await run(deps,{operation:'rename',space_id:'space-1',title:'Again'});assert.equal(out.isError,true);assert.match(out.content[0].text,/changed elsewhere/);
 assert.equal(state.calls.filter(c=>c.method!=='GET'&&c.method!=='PUT').length,0,'only reads and the place save');
});
