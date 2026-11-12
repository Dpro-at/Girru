require('./load.cjs');const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {allowedGenVR,genvrResponse}=require('../src/genvr-contract.js'),{allowed}=require('../scripts/application-server.cjs'),{allowedRequest}=require('../src/session.ts'),{createGenVRAssets}=require('../scripts/genvr-assets.cjs');
const project={format:'genvr-studio',version:1,id:'fictional-world',title:'Fictional garden',world:{},play:{}};
test('Studio bridge only accepts bounded private project operations and drops envelope fields',()=>{
 const route='/api/genvr/projects/'+project.id,b={project,revision:0};assert.ok(allowedGenVR('PUT',route,b));assert.ok(allowed('PUT',route,b));assert.ok(allowedRequest('PUT',route,b));
 for(const extra of [{...b,ownerId:'other'},{...b,revision:-1},{...b,project:{...project,id:'other'}}])assert.equal(allowed('PUT',route,extra),false);
 assert.equal(allowed('POST','/api/genvr/publish',{}),false);assert.equal(allowed('GET','/api/genvr/projects/../keys'),false);
 assert.deepEqual(genvrResponse(route,200,{project,revision:1,token:'hidden'}),{project,revision:1,agents:[]});assert.deepEqual(genvrResponse(route,200,{saved:true,revision:2,token:'hidden'}),{saved:true,revision:2});
 assert.throws(()=>genvrResponse(route,200,{project:{...project,id:'other'},revision:1}));
});
test('unprepared SDK returns unavailable without broadening arbitrary static files',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'genvr-assets-'));try{const serve=createGenVRAssets(folder),responses=[];const res={writeHead:status=>responses.push(status),end:()=>{}};assert.equal(serve({method:'GET'},res,'/genvr/studio.html'),true);assert.equal(responses[0],503);assert.equal(serve({method:'GET'},res,'/private/secrets.env'),false);}finally{fs.rmSync(folder,{recursive:true,force:true});}
});
test('GV1: GenVR opens on its places and never opens the Studio by itself',()=>{
 const React=require('../node_modules/react'),{renderToStaticMarkup}=require('../node_modules/react-dom/server'),{GenVRPage}=require('../src/GenVRPage.tsx');
 const html=renderToStaticMarkup(React.createElement(GenVRPage,{client:{},active:false}));assert.match(html,/Loading your spaces/);assert.doesNotMatch(html,/<iframe/);assert.doesNotMatch(html,/Save &amp; close Studio|Local MCP ready/);
 const H=require('../src/GenVRHome.tsx');
 const cards=renderToStaticMarkup(React.createElement(H.SpaceCards,{spaces:[{id:'a',title:'Lake garden',style:'realistic'}],onInside(){},onOpen(){},onNew(){}}));assert.match(cards,/Lake garden/);assert.match(cards,/New space/);assert.match(cards,/style-realistic\.webp/);
 const side=renderToStaticMarkup(React.createElement(H.GenVRSidebar,{place:'spaces',onPlace(){},counts:{spaces:1,published:0}}));for(const t of ['My spaces','On GenVR','Market','Motion lab'])assert.match(side,new RegExp(t));
 const inner=renderToStaticMarkup(React.createElement(H.GenVRSidebar,{place:'spaces',onPlace(){},counts:{spaces:1,published:0},inside:{id:'a',title:'Lake garden',style:'voxel'},section:'basic'}));for(const t of ['Basic info','Pictures','How it is played','Game','Blocks','Avatars','Collaborators','Access and publishing','Where it is available'])assert.match(inner,new RegExp(t));
 const place=renderToStaticMarkup(React.createElement(H.SpaceInside,{space:{id:'a',title:'Lake garden',style:'voxel',sizeTier:'medium'},section:'basic',onOpen(){},onRename:async()=>{}}));assert.match(place,/Open in Studio/);assert.match(place,/Medium · 1 km × 1 km · up to 50 players/);assert.match(place,/Voxel/);
 const create=renderToStaticMarkup(React.createElement(H.CreateSpace,{first:true,onCreate(){}}));for(const t of ['Make your first space','My first space','Realistic','2D side view','TV with a controller','Either way','Biggest','8 km × 8 km · 100 players','Create and open'])assert.match(create,new RegExp(t));
});

test('space agent contracts reject duplicates, forged grants and invalid avatars',()=>{
 const route='/api/genvr/projects/'+project.id,b={project,revision:0,agents:[{id:'main-agent',avatar:3}]};
 assert.equal(allowed('GET','/api/genvr/agents'),true);assert.equal(allowedRequest('GET','/api/genvr/agents'),true);assert.equal(allowed('PUT',route,b),true);
 for(const agents of [[...b.agents,...b.agents],[{id:'main-agent',avatar:8}],[{id:'main-agent',avatar:0,permissions:['all']}],[{id:'../keys',avatar:0}]])assert.equal(allowed('PUT',route,{...b,agents}),false);
 assert.deepEqual(genvrResponse('/api/genvr/agents',200,{agents:[{id:'main-agent',name:'Fictional agent',avatar:2,systemPrompt:'private'}]}),{agents:[{id:'main-agent',name:'Fictional agent',avatar:2}]});
});

test('asset replaced by a symlink between path validation and open is never served',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'genvr-assets-race-'));
 const open=fs.openSync;
 try{
  const {VERSION,SHA256}=require('../scripts/prepare-genvr.cjs');
  const file=path.join(folder,'vendor/genvr/package/dist/test.js');fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,'reviewed asset');
  fs.writeFileSync(path.join(folder,'private'),'private fixture');
  fs.writeFileSync(path.join(folder,'vendor/genvr/manifest.json'),JSON.stringify({version:VERSION,archiveSha256:SHA256,files:{'dist/test.js':crypto.createHash('sha256').update('reviewed asset').digest('hex')}}));
  const serve=createGenVRAssets(folder);let status,body;
  fs.openSync=function(target,...args){if(target===file){fs.renameSync(file,file+'.old');fs.symlinkSync(path.join(folder,'private'),file);}return open.call(fs,target,...args);};
  const res={writeHead:x=>status=x,end:x=>body=x,setHeader:()=>{}};
  assert.equal(serve({method:'GET'},res,'/genvr/dist/test.js'),true);
  assert.equal(status,503);assert.ok(!String(body).includes('private fixture'));
 }finally{fs.openSync=open;fs.rmSync(folder,{recursive:true,force:true});}
});

test('local runtime availability has a minimal program-only contract',()=>{
 const {GENVR_RUNTIME}=require('../src/genvr-contract.js');
 assert.equal(GENVR_RUNTIME,'/api/genvr/runtime');
 assert.equal(allowedRequest('GET',GENVR_RUNTIME),true);
 assert.equal(allowedGenVR('POST',GENVR_RUNTIME,{}),false);
 assert.equal(allowedGenVR('GET',GENVR_RUNTIME+'?owner=other'),false);
 assert.deepEqual(genvrResponse(GENVR_RUNTIME,200,{state:'installed',version:'0.3.0-preview.22',job:'private',account:'private'}),{state:'installed',version:'0.3.0-preview.22'});
 assert.deepEqual(genvrResponse(GENVR_RUNTIME,200,{state:'missing',version:null}),{state:'missing',version:null});
 assert.throws(()=>genvrResponse(GENVR_RUNTIME,200,{state:'installed',version:'invalid'}));
});

test('GV1b/GV1c: section pages save a local space and the market shows items with Add to a place',async()=>{
 const React=require('../node_modules/react'),{renderToStaticMarkup}=require('../node_modules/react-dom/server');
 const S=require('../src/GenVRSections.tsx'),H=require('../src/GenVRHome.tsx');
 assert.deepEqual(S.newGame().match,{minPlayers:2,durationSec:300,countdownSec:5,resultsSec:10});assert.equal(S.newGame().win.by,'highest_score');
 // Blocks shows only for Voxel places, as in the package.
 const voxel=renderToStaticMarkup(React.createElement(H.GenVRSidebar,{place:'spaces',onPlace(){},counts:{spaces:1,published:0},inside:{id:'a',title:'Cube island',style:'voxel'},section:'basic'}));assert.match(voxel,/Blocks/);
 const real=renderToStaticMarkup(React.createElement(H.GenVRSidebar,{place:'spaces',onPlace(){},counts:{spaces:1,published:0},inside:{id:'a',title:'Lake garden',style:'realistic'},section:'basic'}));assert.doesNotMatch(real,/>Blocks</);
 const store={load:async()=>({project:{},revision:1,agents:[]}),save:async()=>2,roster:async()=>[]};
 assert.match(renderToStaticMarkup(React.createElement(S.PlaceSection,{section:'play',store,published:false,onChanged(){}})),/Loading/);
 const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/GenVRSections.tsx'),'utf8');
 for(const t of ['Players see it','Extra moves','Friendly fire','Match length','Players to start','Health','Back in','Score to win','Agents in this place','Allow remixing','Web browser','Replace thumbnail','Who may build','Body type'])assert.ok(src.includes(t),t);
 assert.doesNotMatch(src,/mixamo/i);
});
test('GV1: the shell shows the GenVR places sidebar (the page owns its sidebar)',()=>{
 const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/SignedInShell.tsx'),'utf8');
 const own=/const OWN_SIDEBAR[^=]*=\s*\[([^\]]*)\]/.exec(src);assert.ok(own);assert.match(own[1],/'genvr'/);
});
test('GV1 PC fixes: a space opens empty, the Studio never waits on an unanswered request, and it can always be left',()=>{
 const read=f=>require('node:fs').readFileSync(require('node:path').join(__dirname,f),'utf8');
 const host=read('../scripts/genvr-host.js'),page=read('../src/GenVRPage.tsx');
 assert.ok(host.includes("filmExample:typeof projectId==='string'||data.lab===true?false:"));
 assert.match(page,/operation==='agents'&&!genvrId\(data\.value\)\)\{send\(\{id:data\.id,response:true,ok:true,value:\[\]\}\)/);
 assert.match(page,/if\(!request\)\{send\(\{id:data\.id,response:true,ok:false\}\);return;\}/);
 assert.doesNotMatch(host,/openExisting|STUDIO_HOST_VERSION/);assert.doesNotMatch(page,/open-failed/);
 assert.match(page,/<iframe key=\{channel\}/);assert.match(page,/if\(phase!=='ready'\)\{drop\(\);return;\}/);
 assert.match(page,/Close without saving/);assert.match(page,/current==='loading'\?'slow'/);assert.doesNotMatch(page,/current==='loading'\?'unavailable'/);
 assert.match(page,/if\(channel&&p!=='lab'\)\{leaveTo\.current=p;close\(\);return;\}/);
});
test('GV1: renaming saves once when Enter and leaving the field both fire',()=>{
 const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/GenVRHome.tsx'),'utf8');
 assert.match(src,/next === sending\.current\) return; sending\.current = next;/);
});
test('GV1: the Studio hands My projects back to Girru and Motion lab opens the lab itself',()=>{
 const read=f=>require('node:fs').readFileSync(require('node:path').join(__dirname,f),'utf8');
 const host=read('../scripts/genvr-host.js'),page=read('../src/GenVRPage.tsx');
 assert.match(host,/onHome:\(\)=>send\(\{operation:'home'\}\)/);assert.ok(host.includes('desktopLayout:true'),'the full editor also in a narrow Girru window');assert.match(host,/data\.lab===true&&typeof projectId!=='string'\?\{openLab:true\}/);
 assert.match(page,/if\(data\.operation==='home'\)\{/);assert.match(page,/if\(p==='lab'\)open\(lab\?\.id,undefined,true\);/);
});
test('Store: the "add it in the coding app" line is only for coding-app items, not for GenVR waiting on a version',()=>{
 const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/StoreView.tsx'),'utf8');
 assert.match(src,/item\.state==='elsewhere'&&\(item\.source==='codex'\|\|item\.source==='claude-code'\?/);
 assert.match(src,/The Store has no version of it for this Girru yet\./);
});
test('GV1d/GV1e/GV1c v2: the open place in the sidebar, one Girru chat, the market from the Studio Items',()=>{
 const read=f=>require('node:fs').readFileSync(require('node:path').join(__dirname,f),'utf8');
 const page=read('../src/GenVRPage.tsx'),host=read('../scripts/genvr-host.js'),market=read('../scripts/genvr-market-host.js'),assets=read('../scripts/genvr-assets.cjs'),view=read('../src/ChatView.tsx'),shell=read('../src/SignedInShell.tsx'),css=read('../src/styles.css');
 // GV1d (Mohamed): no bar under the Studio and no extra left sidebar; the Studio chat header holds
 // who answers (picker shown over the Studio), the agents in this place, Open in Chat and the folder button.
 assert.doesNotMatch(page,/genvr-chatbar|studioNav|genvr-side-group/);assert.doesNotMatch(css,/\.genvr-chatbar|\.genvr-side-group/);
 assert.match(page,/inside=\{channel\?null:inside\}/);assert.match(page,/\{picking&&who\?<div className="genvr-who"/);
 assert.match(page,/\.\.\.\(next\.team\?\.length\?\{team:next\.team\}:\{\}\)/);
 assert.match(page,/if\(data\.operation==='open-folder'\)\{if\(folderPathRef\.current&&canRevealFolder\(\)\)revealFolder\(folderPathRef\.current\);return;\}/);
 assert.match(host,/openFolder:\(\)=>send\(\{operation:'open-folder'\}\)/);
 // GV1e: the Studio chat gets the place's earlier lines and Open in Chat; Chat shows the place with Open in Studio.
 assert.match(page,/\/api\/genvr\/worlds\/\$\{world\.projectId\}\/history/);assert.match(host,/openChat:\(\)=>send\(\{operation:'open-chat'\}\)/);
 assert.match(view,/<GenVRChatPlace key=\{project\.id\} client=\{client\} chatProjectId=\{project\.id\}\/>/);
 assert.match(shell,/window\.addEventListener\(OPEN_GENVR_EVENT,on\)/);assert.match(shell,/onOpenChat=\{id=>\{void \(async\(\)=>\{await chat\?\.loadProjects\(\);await chat\?\.refreshList\(\);await chat\?\.open\(id\);\}\)\(\);setPage\('chat'\);\}\}/);
 // GV1c v2: the market is the SDK's mountMarket in its own frame; Add opens the place with the item ready.
 assert.match(market,/sdk\.mountMarket\(/);assert.match(assets,/\/genvr\/market\.html/);assert.match(page,/open\(sp\.id,undefined,false,item\)/);
 assert.match(host,/placeItem:data\.placeItem/);assert.ok(!require('node:fs').existsSync(require('node:path').join(__dirname,'../src/GenVRMarket.tsx')));
});
test('GV1e contract: history and the place behind a chat pass the app server with exact fields',()=>{
 const {allowedGenVR,genvrResponse}=require('../src/genvr-contract.js');
 assert.ok(allowedGenVR('GET','/api/genvr/worlds/lake-1/history',undefined));assert.ok(!allowedGenVR('POST','/api/genvr/worlds/lake-1/history',{}));
 assert.ok(allowedGenVR('GET','/api/genvr/worlds/of-chat-project/proj_1',undefined));assert.ok(!allowedGenVR('GET','/api/genvr/worlds/of-chat-project/../x',undefined));
 assert.deepEqual(genvrResponse('/api/genvr/worlds/lake-1/history',200,{conversationId:'c1',messages:[{role:'user',text:'hi',extra:1}]}),{conversationId:'c1',messages:[{role:'user',text:'hi'}]});
 assert.throws(()=>genvrResponse('/api/genvr/worlds/lake-1/history',200,{conversationId:'c1',messages:[{role:'system',text:'x'}]}));
 const opened=genvrResponse('/api/genvr/worlds/lake-1/open',200,{folder:'~/Girru/genvr_Worlds/Lake',path:'/Users/x/Girru/genvr_Worlds/Lake',chatProjectId:'p1',conversationId:'c1',answerer:null,secret:'no'});
 assert.deepEqual(opened,{folder:'~/Girru/genvr_Worlds/Lake',chatProjectId:'p1',answerer:null,path:'/Users/x/Girru/genvr_Worlds/Lake',conversationId:'c1'});
 assert.deepEqual(genvrResponse('/api/genvr/worlds/of-chat-project/p1',200,{projectId:'lake-1',title:'Lake',folder:'~/L',path:'/L',answerer:null,x:1}),{projectId:'lake-1',title:'Lake',folder:'~/L',path:'/L',answerer:null});
});
test('menus near the top open downward (the who-answers picker over the Studio)',()=>{
 const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/ChatComposerControls.tsx'),'utf8');
 assert.match(src,/above < 240 && below > above\s*\? \{ position: 'absolute', left, top: r\.bottom - h\.top \+ 6/);
});
test('GV1e real chat: the Studio chat sends to the place chat run and streams back; Details shows the place as one row',()=>{
 const read=f=>require('node:fs').readFileSync(require('node:path').join(__dirname,f),'utf8');
 const page=read('../src/GenVRPage.tsx'),host=read('../scripts/genvr-host.js'),place=read('../src/GenVRChatPlace.tsx');
 assert.match(host,/send:sendToGirru,/);assert.doesNotMatch(host,/  model:\(messages,onDelta,signal/);
 assert.match(page,/path:`\/api\/chat\/conversations\/\$\{conversation\}\/runs`/);assert.match(page,/client\.runEvents\(runId,after,/);
 assert.match(page,/chatInfo\.current=\{\.\.\.chatInfo\.current,/);assert.match(page,/const syncing=setInterval\(/);
 assert.match(place,/className="details-row"/);assert.doesNotMatch(place,/No agents in this place yet/);
});
