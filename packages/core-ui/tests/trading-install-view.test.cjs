require('./load.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('../../backend/node_modules/jsdom');
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true});Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator});
// Only the browser dialog platform primitives are absent from jsdom.
dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
const React=require('../node_modules/react'),{act}=React,{createRoot}=require('../node_modules/react-dom/client'),{SessionClient}=require('../src/session.ts'),{TradingInstallView}=require('../src/TradingInstallView.tsx'),{AppsWorkspace}=require('../src/AppsWorkspace.tsx');
const base='/api/trading-paper/installation',reviewId='00000000-0000-4000-8000-000000000001',installationId='00000000-0000-4000-8000-000000000002';
const text=node=>node.textContent.replace(/\s+/g,' ').trim();
const button=(root,name)=>[...root.querySelectorAll('button')].find(node=>text(node)===name||node.getAttribute('aria-label')===name);
async function flush(){await act(async()=>{await new Promise(resolve=>setImmediate(resolve));});}
async function click(node){assert.ok(node,'Expected rendered control');await act(async()=>{node.click();await new Promise(resolve=>setImmediate(resolve));});await flush();}
async function fill(node,value){assert.ok(node);await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));node.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});}
async function fixture(t,options={}){
 const f={state:'not_provisioned',revision:0,capabilities:[],unavailable:false,lost:false,calls:[],opens:[],...options},user={id:'install-owner',username:'Owner',email:'owner@example.invalid',role:options.role??'owner'};
 const status=()=>({appId:'trading',version:'1.0.0',manifestDigest:'a'.repeat(64),mode:'paper',state:f.state,revision:f.revision,installationId:f.revision?installationId:null,capabilities:f.state==='provisioned'?f.capabilities:[],access:{state:f.state==='provisioned'?'ready':f.state==='disabled'?'disabled':'not_provisioned',readAccounts:['provisioned','disabled'].includes(f.state),readBots:['provisioned','disabled'].includes(f.state)&&f.capabilities.includes('paper.bot.manage'),manageBots:f.state==='provisioned'&&f.capabilities.includes('paper.bot.manage'),executeOrders:false},runtimeConnected:false,createsAccounts:false,retainsData:true});
 const transport=async request=>{
  if(request.path==='/api/auth/login')return {status:200,body:{token:'fixture',deviceToken:'d'.repeat(43),user}};if(request.path==='/api/auth/me')return {status:200,body:{user}};
  f.calls.push({method:request.method,path:request.path,body:request.body});
  if(request.path==='/api/apps')return {status:200,body:{items:[{id:'terminal',name:'Terminal',kind:'builtin',version:null,summary:'Command sessions.',state:'included',sourceId:null,permissions:[],tools:0,removable:false},{id:'app:trading',name:'Trading',kind:'added',origin:'store',version:'1.0.0',summary:'Sample data only.',state:'included',sourceId:'trading',permissions:[],tools:0,removable:true},{id:'genvr',name:'GenVR',kind:'api',version:null,summary:'Virtual worlds.',state:'not_connected',sourceId:'genvr',permissions:[],tools:0,removable:false}]}};
  if(request.path==='/api/mcp/servers')return {status:200,body:{servers:[]}};
  if(request.path===base)return f.unavailable?{status:503,body:{code:'paper_installation_unavailable'}}:{status:200,body:status()};
  if(request.path===base+'/reviews'){f.reviewCount=(f.reviewCount??0)+1;f.review={ok:true,id:reviewId.slice(0,-1)+String(f.reviewCount),expiresAt:Date.now()+300000,appId:'trading',version:'1.0.0',mode:'paper',...request.body,currentState:f.state,schemaDigest:'b'.repeat(64),schemaVersion:1,implementationId:'bundled.trading.paper.v1',dataEffects:{verifiesSchemaTables:15,createsAccounts:false,seedsCash:false,retainsData:true},runtimeConnected:false,createsAccounts:false,retainsData:true};return {status:200,body:f.review};}
  if(request.path.endsWith('/challenge'))return {status:200,body:{challenge:'c'.repeat(43),expiresAt:Date.now()+300000}};
  if(request.path.endsWith('/complete'))return {status:200,body:{receipt:'r'.repeat(43),expiresAt:Date.now()+120000}};
  if(request.path.endsWith('/apply')){if(f.applyWait)await f.applyWait;if(f.lost)throw Error('Fixture lost response');f.state=f.review.action==='install'?'provisioned':f.review.action==='disable'?'disabled':'removed_retained';f.revision++;if(f.review.action==='install')f.capabilities=[...f.review.capabilities];if(f.failReadback)f.unavailable=true;return {status:200,body:{ok:true,reviewId:f.review.id,operationId:reviewId,result:{installationId,revision:f.revision,status:f.state},replayed:false}};}
  throw Error('Unexpected fixture route');
 };
 const client=new SessionClient({live:transport,mock:transport});client.selectMode(options.mode??'live');await client.login(user.email,'Fixture only');
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container),props={client,active:true,onPreview:()=>f.opens.push('trading'),onPermissions:()=>f.opens.push('permissions')};
 const render=async(active=true)=>{await act(async()=>{root.render(React.createElement(React.StrictMode,null,React.createElement(options.apps?AppsWorkspace:TradingInstallView,options.apps?{client,active,onOpen:id=>f.opens.push(id),onConnections:()=>{},onChat:()=>{},onPermissions:props.onPermissions}:{...props,active})));});await flush();};await render();
 t.after(async()=>{await act(async()=>root.unmount());client.cancel();container.remove();});return {f,client,container,root,render};
}
async function verify(f,action='Review paper setup'){
 await click(button(f.container,action));let dialog=f.container.querySelector('dialog');assert.ok(dialog?.open);await click(button(dialog,'Review changes'));assert.ok(button(f.container,'Verify to continue'));assert.match(text(f.container),/Saved history retained/);await click(button(f.container,'Verify to continue'));await fill(f.container.querySelector('input[autocomplete="one-time-code"]'),'123456');await click(button(f.container,'Verify code'));assert.match(text(f.container),/Identity verified/);
}
test('mounted real StrictMode manual setup requires explicit apply and defaults optional management off',async t=>{
 const x=await fixture(t);assert.match(text(x.container),/not prepared/);await verify(x);assert.equal(x.f.calls.filter(r=>r.path.endsWith('/apply')).length,0);assert.deepEqual(x.f.calls.find(r=>r.path===base+'/reviews').body.capabilities,['paper.account.read']);assert.ok(button(x.container,'Apply paper setup'));await click(button(x.container,'Apply paper setup'));assert.equal(x.f.calls.filter(r=>r.path.endsWith('/apply')).length,1);assert.equal(x.container.querySelector('dialog'),null);assert.match(text(x.container),/Paper setup applied/);assert.match(text(x.container),/No bot running/);await click(button(x.container,'Open preview'));assert.deepEqual(x.f.opens,['trading']);
});
test('optional manage consent is staged only when checked and Cancel makes no grant request',async t=>{
 const x=await fixture(t);await click(button(x.container,'Review paper setup'));assert.equal(x.container.querySelector('input[type=checkbox]:not([disabled])').checked,false);await click(button(x.container.querySelector('dialog'),'Cancel'));assert.equal(x.f.calls.filter(r=>r.method==='POST').length,0);await click(button(x.container,'Review paper setup'));await click(x.container.querySelector('input[type=checkbox]:not([disabled])'));await click(button(x.container,'Review changes'));assert.deepEqual(x.f.calls.find(r=>r.path===base+'/reviews').body.capabilities,['paper.account.read','paper.bot.manage']);
});
test('confirmed apply survives failed readback and retry reads status without another apply',async t=>{
 const x=await fixture(t,{failReadback:true});await verify(x);await click(button(x.container,'Apply paper setup'));assert.match(text(x.container),/Applied · current status unavailable/);assert.equal(button(x.container,'Review paper setup'),undefined);x.f.unavailable=false;await click(button(x.container,'Read current status'));assert.match(text(x.container),/Paper setup applied/);assert.equal(x.f.calls.filter(r=>r.path.endsWith('/apply')).length,1);
});
test('unknown outcome blocks new review and blind retry until fresh status and explicit acknowledgment',async t=>{
 const x=await fixture(t,{lost:true});await verify(x);await click(button(x.container,'Apply paper setup'));assert.match(text(x.container),/Setup result not confirmed/);assert.equal(button(x.container,'Review paper setup'),undefined);assert.equal(button(x.container,'I reviewed the current status').disabled,true);await click(button(x.container,'Read current status'));assert.equal(button(x.container,'I reviewed the current status').disabled,false);assert.equal(button(x.container,'Review paper setup'),undefined);await click(button(x.container,'I reviewed the current status'));assert.ok(button(x.container,'Review paper setup'));assert.equal(x.f.calls.filter(r=>r.path.endsWith('/apply')).length,1);
});
test('one-way disable and remove are reviewed separately and preserve preview without resume',async t=>{
 const x=await fixture(t,{state:'provisioned',revision:1,capabilities:['paper.account.read','paper.bot.manage']});await click(x.container.querySelector('summary[aria-label="Paper setup actions"]'));await verify(x,'Disable paper access…');assert.match(text(x.container.querySelector('dialog')),/cannot be undone/);await click(button(x.container,'Disable paper access'));assert.match(text(x.container),/Paper access disabled/);assert.ok(button(x.container,'Open preview'));assert.equal(button(x.container,'Review paper setup'),undefined);await click(x.container.querySelector('summary[aria-label="Paper setup actions"]'));await verify(x,'Remove paper access…');await click(button(x.container,'Remove paper access'));assert.match(text(x.container),/Paper access removed/);assert.equal(button(x.container,'Remove paper access…'),undefined);assert.equal(x.f.calls.filter(r=>r.path.endsWith('/apply')).length,2);
});
test('pending apply cannot be dismissed as cancellation; signout clears review and late response',async t=>{
 let release;const applyWait=new Promise(resolve=>release=resolve),x=await fixture(t,{applyWait});await verify(x);await click(button(x.container,'Apply paper setup'));const dialog=x.container.querySelector('dialog');assert.ok(dialog);assert.equal(button(dialog,'Cancel').disabled,true);assert.equal(button(dialog,'Close paper setup').disabled,true);await act(async()=>dialog.dispatchEvent(new dom.window.Event('cancel',{bubbles:true,cancelable:true})));assert.ok(x.container.querySelector('dialog'));await act(async()=>x.client.cancel());assert.equal(x.container.querySelector('dialog'),null);await act(async()=>{release();await new Promise(resolve=>setImmediate(resolve));});assert.doesNotMatch(text(x.container),/Identity verified|Paper setup applied/);
});
test('local demo never grants setup; unavailable still preserves preview and inactive view clears',async t=>{
 const demo=await fixture(t,{mode:'mock'});assert.equal(demo.f.calls.length,0);assert.equal(button(demo.container,'Review paper setup'),undefined);await click(button(demo.container,'Open preview'));assert.deepEqual(demo.f.opens,['trading']);const x=await fixture(t,{unavailable:true});assert.match(text(x.container),/unavailable/);assert.ok(button(x.container,'Try again'));await click(button(x.container,'Open preview'));assert.equal(x.f.calls.filter(r=>r.method==='POST').length,0);await x.render(false);assert.equal(x.container.textContent,'');
});
test('My apps opens installed Trading without mixing paper verification into its inspector',async t=>{
 const x=await fixture(t,{apps:true});await click(x.container.querySelector('[data-app="app:trading"][role="option"]'));
 assert.ok(button(x.container,'Open Trading'));assert.equal(button(x.container,'Review paper setup'),undefined);
 await click(button(x.container,'Open Trading'));assert.ok(x.f.opens.includes('trading'));
 assert.equal(x.f.calls.some(c=>c.path.startsWith(base)),false);
});
test('installed Trading has the same Open action in its keyboard context menu',async t=>{
 const x=await fixture(t,{apps:true});const tile=x.container.querySelector('[data-app="app:trading"][role="option"]');assert.ok(tile);await act(async()=>tile.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true})));await flush();
 const menu=[...x.container.ownerDocument.querySelectorAll('[role="menu"]')].find(n=>text(n).includes('Open Trading'));assert.ok(menu);assert.match(text(menu),/Open Trading/);assert.doesNotMatch(text(menu),/Review paper setup/);
});
test.after(()=>dom.window.close());
