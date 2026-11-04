require('./load.cjs');const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const src=name=>fs.readFileSync(path.join(__dirname,'..','src',name),'utf8');
const {SkillAppsPlace}=require('../src/SkillsWorkspace.tsx'),{WhereConnectionsComeFrom}=require('../src/McpWorkspace.tsx'),{SkillFoundPlace}=require('../src/SkillFoundPlace.tsx');
test('S-3 coding-apps place keeps the old source filter and sort (filter popover + ⋯ sort)',()=>{
 const html=renderToStaticMarkup(React.createElement(SkillAppsPlace,{client:{request:async()=>{throw Error();}}}));
 assert.match(html,/aria-label="Show: from one app"/);assert.match(html,/aria-label="More: sort, look again, clear filters"/);
 const place=src('SkillsWorkspace.tsx').split('export function SkillAppsPlace')[1];
 for(const words of ['Sort by source','Sort by name','Every app','Clear filters'])assert.ok(place.includes(words),words);
 assert.match(place,/skillSource\(s\.origin\)\.key===source/);
});
test('S-8 "Where connections come from…" is a sheet, not a hidden place with no way back',()=>{
 const html=renderToStaticMarkup(React.createElement(WhereConnectionsComeFrom,{onClose(){}}));
 assert.match(html,/role="dialog"/);assert.match(html,/Where connections come from/);assert.match(html,/Official MCP Registry/);assert.match(html,/Done/);assert.doesNotMatch(html,/Where skills come from/);
 const tools=src('ToolSections.tsx');assert.doesNotMatch(tools,/place==='sources'|PublisherSources kind|setPlace\('sources'\)/);
 assert.match(src('McpWorkspace.tsx'),/Where connections come from…',icon:'globe',run:onShowSources\?\?\(\(\)=>setWhere\(true\)\)/);
});
function controller(state){return {subscribe:()=>()=>{},getSnapshot:()=>state,open:async()=>{},scan:async()=>{},load:async()=>{},setSecret(){},importOpen:async()=>{},ignore:async()=>{},remove:async()=>{}};}
const item=(id,name,kind,state='new')=>({id,kind,name,from:'~/.claude.json',rootId:null,to:'',state,updatedAt:''});
test('M-9 MCP "This computer" is one at a time with J / K and keeps Credentials / Leave it, Add (off), Don’t show again',()=>{
 const s={phase:'ready',view:{roots:[],items:[item('a','calendar','mcp'),item('b','files','mcp'),item('c','writer','skill'),item('d','gone-one','mcp','ignored')]},preview:{id:'a',kind:'mcp',name:'calendar',from:'~/.claude.json',to:'',state:'new',text:'{"command":"npx"}',truncated:false,secrets:['CALENDAR_KEY'],blocked:null,previewHash:'x'},previewLoading:null,secret:'credentials',busy:false,scanning:false,notice:null,result:null};
 const html=renderToStaticMarkup(React.createElement(SkillFoundPlace,{c:controller(s),active:true,kind:'mcp'}));
 assert.match(html,/MCP servers found on this computer/);assert.match(html,/1 of 2 · J \/ K next/);
 for(const words of ['Credentials','Leave it','Add it (off)','Don’t show again','Added connections start off'])assert.ok(html.includes(words),words);
 assert.match(html,/aria-label="Next"/);assert.match(html,/aria-label="Previous"/);assert.match(html,/tabindex="0"/);assert.doesNotMatch(html,/writer|gone-one/);
 const taken=renderToStaticMarkup(React.createElement(SkillFoundPlace,{c:controller({...s,view:{roots:[],items:[item('a','calendar','mcp','imported')]},preview:{...s.preview,state:'imported'}}),active:true,kind:'mcp'}));
 assert.match(taken,/>Take out</);assert.doesNotMatch(taken,/Leave it/);
 const skills=renderToStaticMarkup(React.createElement(SkillFoundPlace,{c:controller({...s,preview:null}),active:false}));assert.match(skills,/Skills found on this computer/);assert.match(skills,/Writer/);assert.doesNotMatch(skills,/Credentials/);
 // MCP-ONE-01: the MCP section's one found place is McpFoundPlace (every app, project and Store app).
 assert.match(src('ToolSections.tsx'),/<McpFoundPlace client=\{client\} found=\{found\}/);
});
test('S-12 agent connection tool chips show the description and "asks first" like built-in chips',()=>{
 const line=src('AgentPermissions.tsx').split('\n').find(l=>l.includes('t.name.slice(prefix.length)}'));
 assert.ok(line);assert.match(line,/title=\{t\.description\}/);assert.match(line,/\{t\.requiresApproval&&<small>asks first<\/small>\}/);
});
