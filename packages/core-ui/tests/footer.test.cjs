require('./load.cjs');const {test}=require('node:test'),assert=require('node:assert/strict');
const {allowedFooter,footerPrefs,footerResponse,DEFAULT_FOOTER}=require('../src/footer-contract.js');
const {allowed}=require('../scripts/application-server.cjs'),{allowedRequest}=require('../src/session.ts');
test('footer route: only known sections pass, Settings can never be hidden',()=>{
 for(const gate of [allowedFooter.bind(null),(m,p,b)=>allowedRequest(m,p,b),(m,p,b)=>allowed(m,p,b)]){
  assert.ok(gate('GET','/api/me/footer',undefined));assert.ok(gate('PUT','/api/me/footer',{hidden:['board']}));
  for(const bad of [{hidden:['settings']},{order:['chat','chat']},{},{iconsOnly:1},{other:true}])assert.equal(!!gate('PUT','/api/me/footer',bad),false,JSON.stringify(bad));
 }
 assert.deepEqual(footerPrefs({order:['apps','nope']}).order.slice(0,2),['store','chat'],'SA6: an older Apps place becomes the Store');assert.ok(!footerPrefs({order:['apps','store']}).order.includes('apps'));assert.equal(footerPrefs({order:['apps','store']}).order.filter(x=>x==='store').length,1);assert.equal(!!allowedFooter('PUT','/api/me/footer',{order:['apps']}),false,'Apps is no footer section any more');
 assert.deepEqual(footerPrefs(null).hidden,DEFAULT_FOOTER.hidden);
 assert.equal(!!allowedFooter('PUT','/api/me/footer',{hidden:['mcp']}),false);assert.ok(!DEFAULT_FOOTER.hidden.includes('library'));
 // An older saved footer: Library comes in after Agents, shown; MCP connections (now in Settings) drop out.
 const older=footerPrefs({order:['board','chat','agents','mcp'],hidden:['mcp']});assert.deepEqual(older.order.slice(0,4),['board','chat','agents','library']);assert.deepEqual(older.hidden,[]);
 assert.deepEqual(Object.keys(footerResponse(200,{footer:{hidden:[]},secret:'x'})),['footer']);
});
test('footer shows the usual eight sections (Library and Store included), keeps the current one and Settings',()=>{const React=require('../node_modules/react'),{renderToStaticMarkup}=require('../node_modules/react-dom/server'),{ShellFooter}=require('../src/ShellFooter.tsx'),{FooterController}=require('../src/footer-prefs.ts');
 const c=new FooterController({request:async()=>({status:200,body:{footer:footerPrefs(null)}})}),e=(current=false,badge)=>({available:true,current,run(){},badge});
 const entries={chat:e(),agents:e(),library:e(),board:e(),memory:e(),approvals:e(false,'3'),store:e(),genvr:e(),terminal:e(),code:e(),browser:{available:false,current:false,run(){}},skills:e(true),personalities:e(),specialties:e()};
 const html=renderToStaticMarkup(React.createElement(ShellFooter,{controller:c,entries,status:null,settingsCurrent:false,onSettings(){},onCustomize(){}}));
 for(const s of ['Chat','Agents','Library','Board','Memory','Approvals','Store','Skills','Settings'])assert.match(html,new RegExp('>'+s+'<'));
 for(const s of ['Apps','GenVR','Terminal','Personalities','MCP connections'])assert.doesNotMatch(html,new RegExp('>'+s+'<'));
 assert.match(html,/Choose what the footer shows/);
});
test('a hidden place lights its section instead of joining the footer',()=>{const React=require('../node_modules/react'),{renderToStaticMarkup}=require('../node_modules/react-dom/server'),{ShellFooter}=require('../src/ShellFooter.tsx'),{FooterController}=require('../src/footer-prefs.ts');
 const c=new FooterController({request:async()=>({status:200,body:{footer:footerPrefs(null)}})}),e=(current=false,parent)=>({available:true,current,run(){},parent});
 const entries={chat:e(),agents:e(),library:e(),board:e(),memory:e(),approvals:e(),store:e(),genvr:e(false,'store'),terminal:e(false,'store'),code:e(false,'store'),browser:{available:false,current:false,run(){}},skills:e(false,'library'),personalities:e(true,'library'),specialties:e(false,'library')};
 const html=renderToStaticMarkup(React.createElement(ShellFooter,{controller:c,entries,status:null,settingsCurrent:false,onSettings(){},onCustomize(){}}));
 assert.doesNotMatch(html,/>Personalities</);assert.match(html,/aria-current="page"[^>]*>(?:<svg[\s\S]*?<\/svg>)?<span>Library</);assert.doesNotMatch(html,/aria-current="page"[^>]*>(?:<svg[\s\S]*?<\/svg>)?<span>Agents</);
});
test('hiding a section never shifts the others’ ⌘ numbers (board SH3)',async()=>{const React=require('../node_modules/react'),{renderToStaticMarkup}=require('../node_modules/react-dom/server'),{ShellFooter}=require('../src/ShellFooter.tsx'),{FooterController}=require('../src/footer-prefs.ts');
 const c=new FooterController({request:async()=>({status:200,body:{footer:footerPrefs({hidden:[...DEFAULT_FOOTER.hidden,'board']})}})});await c.load();
 const e=()=>({available:true,current:false,run(){}}),entries=Object.fromEntries(DEFAULT_FOOTER.order.map(id=>[id,e()]));
 const html=renderToStaticMarkup(React.createElement(ShellFooter,{controller:c,entries,status:null,settingsCurrent:false,onSettings(){},onCustomize(){}}));
 assert.doesNotMatch(html,/>Board</);assert.match(html,new RegExp(`title="Memory \\(⌘${DEFAULT_FOOTER.order.indexOf('memory')+1}\\)"[^>]*>(?:<svg[\\s\\S]*?</svg>)?<span>Memory<`));
});
