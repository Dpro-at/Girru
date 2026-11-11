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
 const inner=renderToStaticMarkup(React.createElement(H.GenVRSidebar,{place:'spaces',onPlace(){},counts:{spaces:1,published:0},inside:{id:'a',title:'Lake garden'},section:'basic'}));for(const t of ['Basic info','Pictures','How it is played','Game','Blocks','Avatars','Collaborators','Access and publishing','Where it is available'])assert.match(inner,new RegExp(t));
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
 assert.deepEqual(genvrResponse(GENVR_RUNTIME,200,{state:'installed',version:'0.3.0-preview.17',job:'private',account:'private'}),{state:'installed',version:'0.3.0-preview.17'});
 assert.deepEqual(genvrResponse(GENVR_RUNTIME,200,{state:'missing',version:null}),{state:'missing',version:null});
 assert.throws(()=>genvrResponse(GENVR_RUNTIME,200,{state:'installed',version:'invalid'}));
});
