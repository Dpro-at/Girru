require('./load.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {allowedBrowserApp,browserAppResponse,BROWSER_APP_PATH}=require('../src/browser-app-contract.js');
const {createApplicationServer,allowed}=require('../scripts/application-server.cjs');
test('browser launcher accepts only fixed open action and strips credentials and paths',()=>{
 for(const body of [{action:'open',path:'/private'},{action:'execute'},{action:'open',token:'secret'}])assert.equal(allowedBrowserApp('POST',BROWSER_APP_PATH,body),false);
 assert.equal(allowed('POST',BROWSER_APP_PATH,{action:'open'}),true);
 assert.deepEqual(browserAppResponse(200,{available:true,running:true,token:'secret',path:'/private'}),{available:true,running:true});
});
test('browser launch is owner authenticated at the bridge, never an upstream launch endpoint',async t=>{
 let role='member',opened=0;const calls=[];
 const upstream=http.createServer((req,res)=>{calls.push(req.url);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({user:{id:'owner',role}}));});
 const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));const port=await listen(upstream);
 const app=createApplicationServer({channel:'candidate',upstreamPort:port,browserController:{status:async()=>({available:true,running:false}),open:async()=>{opened++;return {available:true,running:true};}}});const p=await listen(app);
 t.after(()=>{app.closeAllConnections();app.close();upstream.closeAllConnections();upstream.close();});
 const call=auth=>fetch(`http://127.0.0.1:${p}${BROWSER_APP_PATH}`,{method:'POST',mode:'same-origin',headers:{Origin:`http://127.0.0.1:${p}`,'Content-Type':'application/json',...(auth?{Authorization:'Bearer fixture-token'}:{})},body:JSON.stringify({action:'open'})});
 assert.equal((await call(false)).status,401);assert.equal((await call(true)).status,403);assert.equal(opened,0);
 role='owner';const response=await call(true);assert.equal(response.status,200);assert.deepEqual(await response.json(),{available:true,running:true});assert.equal(opened,1);assert.ok(calls.every(x=>x==='/api/auth/me'));
});
test('embedded browser controls reject arbitrary code, identities, files and malformed input',()=>{
 for(const body of [{action:'evaluate',code:'secret'},{action:'new',url:'file:///private'},{action:'navigate',url:'javascript:alert(1)'},{action:'state',token:'secret'},{action:'frame',after:0,agentId:'other'},{action:'input',kind:'text',text:'x',path:'/private'},{action:'input',kind:'mouse',x:99,y:0,event:'down',button:'left',count:1}])assert.equal(allowedBrowserApp('POST',BROWSER_APP_PATH,body),false);
 assert.equal(allowedBrowserApp('POST',BROWSER_APP_PATH,{action:'frame',after:0}),true);
 assert.equal(allowedBrowserApp('POST',BROWSER_APP_PATH,{action:'input',kind:'text',text:'hello'}),true);
 const r=browserAppResponse(200,{active:'tab',tabs:[{id:'tab',agentId:'agent',token:'secret',page:{}}],agents:[{id:'agent',name:'A',token:'secret'}]});assert.doesNotMatch(JSON.stringify(r),/secret|"page"|token/);
});
test('browser address construction keeps local projects local and rejects credentials or script/file schemes',()=>{
 const {browserAddress}=require('../src/browser-app-contract.js');
 assert.equal(browserAddress('localhost:3000/project'),'http://localhost:3000/project');
 assert.equal(browserAddress('example.com'),'https://example.com');
 assert.equal(browserAddress('design ideas'),'https://www.google.com/search?q=design%20ideas');
 for(const input of ['file:///private','javascript:alert(1)','https://name:password@example.com'])assert.equal(browserAddress(input),null);
});
test('delayed browser input and frames can stay bound to their original tab',()=>{
 const id='11111111-1111-4111-8111-111111111111';
 assert.equal(allowedBrowserApp('POST',BROWSER_APP_PATH,{action:'input',id,kind:'text',text:'hello'}),true);
 assert.equal(allowedBrowserApp('POST',BROWSER_APP_PATH,{action:'frame',id,after:0}),true);
 assert.equal(allowedBrowserApp('POST',BROWSER_APP_PATH,{action:'input',id:'../other',kind:'text',text:'hello'}),false);
 const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/BrowserWorkspace.tsx'),'utf8');assert.match(source,/call\(\{action:'input',id,\.\.\.body\}\)/);
});
