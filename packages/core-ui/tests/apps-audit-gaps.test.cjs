require('./load.cjs');const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const React=require('../node_modules/react');const {renderToStaticMarkup}=require('../node_modules/react-dom/server');
const src=name=>fs.readFileSync(path.join(__dirname,'../src',name),'utf8');
const {PluginsSheet,pluginsLine,matchAddons,addonState}=require('../src/AppsAddons.tsx');const {tileActions,workspaceFooterItem}=require('../src/WorkspaceApplications.tsx');const {sourceFacts}=require('../src/SourceCatalogue.tsx');const {scopeWords}=require('../src/ConnectionsSettings.tsx');const {footerToolItem,AppsWorkspace}=require('../src/AppsWorkspace.tsx');const {usualFooter}=require('../src/footer-prefs.ts');
const plugin=(name,extra={})=>({name,source:'codex',kind:'plugin',enabled:true,installed:true,count:0,...extra});
test('A1: add-ons can be searched from the sidebar by name or label',()=>{
 const items=[plugin('alpha@pub',{label:'Code review'}),plugin('beta@pub'),{...plugin('hooks'),kind:'hook',label:'Session start'}];
 assert.deepEqual(matchAddons(items,'').map(x=>x.name),['alpha@pub','beta@pub','hooks']);assert.deepEqual(matchAddons(items,' REVIEW ').map(x=>x.name),['alpha@pub']);assert.deepEqual(matchAddons(items,'beta').map(x=>x.name),['beta@pub']);assert.deepEqual(matchAddons(items,'session').map(x=>x.name),['hooks']);
 const ws=src('AppsWorkspace.tsx');assert.match(ws,/placeholder="Search  ⌘F"/);assert.doesNotMatch(ws,/AppsAddons|Add-ons in my coding apps/,'board AP1: not in My apps');
 assert.match(src('ReplyAppsSettings.tsx'),/<PluginsSheet app=\{sheet\} items=\{plugins\}/);assert.equal(pluginsLine(items,'codex'),'2 plugins');assert.equal(pluginsLine(items,'claude-code'),'');
 const html=renderToStaticMarkup(React.createElement(PluginsSheet,{app:'codex',items,onClose(){}}));assert.match(html,/Codex plugins/);assert.match(html,/Code review/);assert.match(html,/Session start \(0 rules\)/);assert.match(html,/Read only/);
});
test('A9: a plugin missing from this computer says so instead of On/Off',()=>{
 assert.equal(addonState(plugin('a',{installed:false,enabled:true})),'Not on this computer');assert.equal(addonState(plugin('a',{installed:true,enabled:true})),'On');assert.equal(addonState(plugin('a',{installed:null,enabled:false})),'Off');assert.equal(addonState(plugin('a',{installed:null,enabled:null})),'Unknown');assert.equal(addonState({kind:'hook',installed:false,enabled:null}),'Not run here');
});
test('A3: right-click on a tile offers the inspector actions and keeps owner gates',()=>{
 const calls=[];const h=Object.fromEntries(['open','onAccountConnections','onPermissions'].map(k=>[k,()=>calls.push(k)]));
 const labels=items=>items.filter(x=>x!=='sep').map(x=>x.label);
 assert.deepEqual(labels(tileActions({id:'genvr',kind:'api',name:'GenVR'},{owner:true,busy:false},h)),['Open GenVR','Account connection…','Agent permissions…']);
 assert.deepEqual(labels(tileActions({id:'genvr',kind:'api',name:'GenVR'},{owner:false,busy:false},h)),['Open GenVR']);
 assert.deepEqual(labels(tileActions({id:'terminal',kind:'builtin',name:'Terminal'},{owner:true,busy:false},h)),['Open Terminal','Agent permissions…']);
 // An MCP connection is not an app: it lives in Settings › MCP connections.
 assert.deepEqual(tileActions({id:'mcp:1',kind:'mcp',name:'Sample'},{owner:true,busy:false},h),[]);
 const pin={label:'Show in the footer',checked:true,run(){}};assert.deepEqual(labels(tileActions({id:'terminal',kind:'builtin',name:'Terminal'},{owner:true},{...h,footer:pin})),['Open Terminal','Agent permissions…','Show in the footer']);
 tileActions({id:'genvr',kind:'api',name:'GenVR'},{owner:true},h).find(x=>x.label==='Account connection…').run();assert.deepEqual(calls,['onAccountConnections']);
 const w=src('WorkspaceApplications.tsx');assert.match(w,/onContextMenu=\{e=>contextFor\(e,x\)\}/);assert.match(w,/\.filter\(x=>x\.kind!=='mcp'\)/);assert.doesNotMatch(w,/Connected services|Add connection/);
});
test('A6: the source catalogue uses the board words and letter tiles',()=>{
 assert.deepEqual(sourceFacts({present:true}).map(x=>x[0]),['On this computer','Works in Girru','Asks for']);assert.equal(sourceFacts({present:false})[0][1],'Not found');
 const s=src('SourceCatalogue.tsx');assert.doesNotMatch(s,/Local presence|Compatibility|Activation|Present locally/);assert.match(s,/<Tile name=\{x\.name\}/);assert.match(s,/it may be out of date/);assert.match(s,/Girru does not copy its keys/);
});
test('A8: GenVR access is shown in plain words, unknown codes pass through',()=>{
 assert.equal(scopeWords('worlds:read'),'See your spaces');assert.equal(scopeWords('worlds:write'),'Save worlds as private drafts');assert.equal(scopeWords('worlds:publish'),'Publish only after you agree');assert.equal(scopeWords('worlds:join'),'Join worlds');assert.equal(scopeWords('items:new'),'items:new');
 assert.match(src('ConnectionsSettings.tsx'),/\{scopeWords\(x\)\}/);
});
test('S5: owner app rows including Store Browser can be shown in or hidden from the footer',()=>{
 const prefs=usualFooter(),toggled=[];
 for(const id of ['genvr','terminal','code','browser']){const item=footerToolItem(prefs,id,x=>toggled.push(x));assert.equal(item.label,'Show in the footer');assert.equal(item.checked,!prefs.hidden.includes(id));item.run();}
 assert.deepEqual(toggled,['genvr','terminal','code','browser']);assert.equal(footerToolItem(prefs,'mcp',()=>{}),null);
 assert.equal(footerToolItem({...prefs,hidden:[...prefs.hidden,'genvr']},'genvr',()=>{}).checked,false);assert.equal(footerToolItem({...prefs,hidden:prefs.hidden.filter(x=>x!=='genvr')},'genvr',()=>{}).checked,true);
 assert.match(src('FooterSettings.tsx'),/can be pinned from Apps/);
 const html=renderToStaticMarkup(React.createElement(AppsWorkspace,{client:{getSnapshot:()=>({user:{id:'o',username:'Owner',email:'o@example.test',role:'owner'}})},active:true,onOpen(){},onConnections(){},onPermissions(){}}));
 // Apps is My apps only; the Store is its own footer section. MCP connections, Channels, Accounts and the Tools rows are gone from its sidebar.
 assert.match(html,/>My apps</);assert.doesNotMatch(html.split('</nav>')[0],/>Home<|>Store<|>Updates</);for(const gone of ['MCP connections','Channels','Accounts','Tools','Find more'])assert.doesNotMatch(html.split('</nav>')[0],new RegExp('>'+gone+'<'),gone);
 const resolved=[];const footer=id=>{resolved.push(id);return footerToolItem(prefs,id,x=>toggled.push(x));};
 for(const id of ['genvr','terminal','code','browser','app:browser']){
  const canonical=id==='app:browser'?'browser':id;
  const item=workspaceFooterItem(true,id,footer);assert.equal(item.label,'Show in the footer');
  assert.equal(item.checked,!prefs.hidden.includes(canonical));item.run();assert.equal(toggled.at(-1),canonical);
  assert.equal(footerToolItem({...prefs,hidden:[...prefs.hidden,canonical]},canonical,()=>{}).checked,false);
  assert.equal(footerToolItem({...prefs,hidden:prefs.hidden.filter(x=>x!==canonical)},canonical,()=>{}).checked,true);
 }
 assert.deepEqual(resolved,['genvr','terminal','code','browser','browser']);
 let memberLookups=0;assert.equal(workspaceFooterItem(false,'app:browser',()=>{memberLookups++;throw Error('Owner-only callback');}),null);assert.equal(memberLookups,0);
 const actions=tileActions({id:'app:browser',kind:'added',name:'Browser'},{owner:false},{open(){},onPermissions(){},onAccountConnections(){},footer:footer('browser')});assert.deepEqual(actions.map(x=>x.label),['Open Browser']);
 assert.match(src('WorkspaceApplications.tsx'),/footer:workspaceFooterItem\(owner,x\.id,footerItem\)/);
});
