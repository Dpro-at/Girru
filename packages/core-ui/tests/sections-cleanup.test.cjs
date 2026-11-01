require('./load.cjs');
// Sections cleanup: Apps = apps only, Agents = the team only, Departments only in Settings,
// a Library footer section, and coming-soon specialties the owner can fill.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const src=name=>fs.readFileSync(path.join(__dirname,'../src',name),'utf8');
const owner={getSnapshot:()=>({phase:'authenticated',mode:'live',user:{id:'o',role:'owner',email:'o@example.invalid',username:'Owner'}}),subscribe:()=>()=>{},request:()=>new Promise(()=>{})};

test('Library: its own sidebar and page with Personalities, Specialties and Skills; each opens its page',()=>{
 const {LibrarySection}=require('../src/LibrarySection.tsx');const opened=[];
 const html=renderToStaticMarkup(React.createElement(LibrarySection,{active:true,onOpen:p=>opened.push(p)}));
 for(const s of ['Personalities','Specialties','Skills'])assert.match(html,new RegExp('>'+s+'<'));
 assert.match(html,/aria-label="Library places"/);
 const shell=src('SignedInShell.tsx');
 assert.match(shell,/<LibrarySection canManageRules=\{owner\} active=\{page==='library'\} sidebarSlot=\{slot\} onOpen=\{place=>setPage\(place\)\}\/>/);
 assert.match(shell,/library:\{\.\.\.entry\('library',owner\)/);
 for(const id of ['skills','personalities','specialties'])assert.match(shell,new RegExp(`${id}:entry\\('${id}',owner,go\\('${id}'\\),undefined,'library'\\)`));
 assert.doesNotMatch(shell,/mcp:entry\(/);
 const {footerSections}=require('../src/footer-prefs.ts');assert.deepEqual(footerSections.library,{label:'Library',icon:'book'});assert.equal(footerSections.mcp,undefined);
});

test('Agents sidebar is the team only: All staff and Main agent; no Departments or Build agents',()=>{
 const page=src('AgentsDestination.tsx'),side=page.slice(page.indexOf('function AgentsSidebar'),page.indexOf('function HireSheet'));
 assert.doesNotMatch(side,/Build agents|>Departments<|No department|DepartmentTile/);assert.doesNotMatch(page,/build=\{owner/);
 assert.match(page,/All staff/);assert.match(page,/Main agent/);
 // The agent page keeps its links to each Library place.
 assert.match(page,/library=\{\{onPersonalities,onSpecialties,onSkills\}\}/);
 const {CardView}=require('../src/AgentCard.tsx');assert.ok(CardView);
 assert.match(src('AgentCard.tsx'),/title=\{`Open \$\{label\} in Library`\}/);
 // The department still shows as a chip on each staff row.
 assert.match(src('StaffDirectory.tsx'),/className="ag-row-dept">\{a\.department&&<><DepartmentTile department=\{a\.department\}\/>/);
});

test('Settings has Accounts, Channels, MCP connections and Departments; Library and My apps stay jump rows',()=>{
 const {AppSettings}=require('../src/AppSettings.tsx');
 const page=(tab,extra={})=>renderToStaticMarkup(React.createElement(AppSettings,{signedIn:true,preference:'system',onTheme(){},onAccount(){},client:owner,initialTab:tab,onOpenApps(){},onOpenTool(){},...extra}));
 const html=page('general');
 for(const s of ['Accounts','Channels','MCP connections','Departments','Library','My apps'])assert.match(html,new RegExp('dk-place-name">'+s+'<'),s);
 assert.doesNotMatch(html,/dk-place-name">Connections</);for(const s of ['Skills','Specialties','Personalities'])assert.doesNotMatch(html,new RegExp('dk-place-name">'+s+'<'),s);
 // The old name still opens Accounts; Departments opens its own page.
 assert.match(page('connections'),/<h2 class="settings-page-title">Accounts<\/h2>/);
 assert.match(page('departments'),/Reading departments/);
 const member={...owner,getSnapshot:()=>({phase:'authenticated',mode:'live',user:{id:'m',role:'user',email:'m@example.invalid',username:'M'}})};
 const m=renderToStaticMarkup(React.createElement(AppSettings,{signedIn:true,preference:'system',onTheme(){},onAccount(){},client:member,initialTab:'departments',onOpenApps(){},onOpenTool(){}}));
 assert.doesNotMatch(m,/dk-place-name">Departments</);assert.doesNotMatch(m,/Reading departments/);
});

test('Departments: grouped from the agents, renamed and moved through exact routes in both gates',()=>{
 const {groupDepartments,cleanDepartment}=require('../src/DepartmentsSettings.tsx');
 const g=groupDepartments([{id:'a',version:1,name:'A',department:'sales'},{id:'b',version:1,name:'B',department:'research'},{id:'c',version:1,name:'C'},{id:'d',version:2,name:'D',department:'sales'}]);
 assert.deepEqual(g.departments.map(d=>[d.name,d.agents.map(a=>a.id)]),[['research',['b']],['sales',['a','d']]]);assert.deepEqual(g.none.map(a=>a.id),['c']);
 assert.equal(cleanDepartment('  Field   Ops '),'field ops');
 const {allowedRequest}=require('../src/session.ts'),{allowed}=require('../scripts/application-server.cjs'),{departmentsResponse}=require('../src/departments-contract.js');
 for(const gate of [allowedRequest,allowed]){
  assert.equal(!!gate('POST','/api/agents/departments/rename',{from:'sales',to:'field ops'}),true);
  for(const bad of [{from:'sales'},{from:'sales',to:'Sales'},{from:'sales',to:'x'.repeat(65)},{from:'sales',to:'a',extra:1},{from:'',to:'a'}])assert.equal(!!gate('POST','/api/agents/departments/rename',bad),false,JSON.stringify(bad));
  assert.equal(!!gate('GET','/api/agents/departments/rename',undefined),false);
  // Moving one agent is the agent page's own PUT with its version.
  assert.equal(!!gate('PUT','/api/agents/agent-1',{expectedVersion:3,department:'sales'}),true);
 }
 assert.deepEqual(departmentsResponse(200,{from:'a',to:'b',moved:2,secret:'x'}),{from:'a',to:'b',moved:2});assert.deepEqual(departmentsResponse(404,{error:'x'}),{code:'not_found'});
 assert.throws(()=>departmentsResponse(200,{from:'a'}));
 // No department list anywhere else on the main screens.
 for(const f of ['AgentsDestination.tsx','AppsWorkspace.tsx','SignedInShell.tsx'])assert.doesNotMatch(src(f),/groupDepartments|DepartmentsSettings/,f);
});

test('a coming-soon specialty can be written or described; hire mode stays read-only',()=>{
 const s=src('SpecialtyLibrary.tsx');
 assert.match(s,/readOnly=hire;/);assert.doesNotMatch(s,/readOnly=hire\|\|!!draft\?\.planned/);
 assert.match(s,/const describePlanned=async\(\)=>\{if\(!draft\?\.planned\|\|hire/);
 assert.match(s,/Write instructions<\/button>/);assert.match(s,/'Describe it'/);
 assert.match(s,/draft\.planned&&hire&&part!=='overview'/);
 assert.match(s,/disabled=\{locked\|\|blank\|\|/);
});

test('CSS for this work lives in its own file, imported once at the top of styles.css',()=>{
 const styles=src('styles.css');assert.ok(styles.startsWith("@import './sections-cleanup.css';"));assert.equal(styles.split('sections-cleanup.css').length,2);
 for(const f of ['LibrarySection.tsx','DepartmentsSettings.tsx'])assert.doesNotMatch(src(f),/import\s+['"][^'"]+\.css['"]/);
});
