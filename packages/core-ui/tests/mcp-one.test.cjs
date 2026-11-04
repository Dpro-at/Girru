// MCP-ONE-01 + SSH-KEYS-01: the found list, sources on connections, and SSH keys in Settings.
require('./load.cjs');const {test}=require('node:test'),assert=require('node:assert/strict');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {allowedMcpImport,mcpImportResponse}=require('../src/mcp-import-contract.js'),{allowed}=require('../scripts/application-server.cjs'),{allowedRequest}=require('../src/session.ts');
const {allowedSshKeys,sshKeysResponse}=require('../src/ssh-keys-contract.js'),{connectorResponse}=require('../src/connectors-contract.js'),{discoveryResponse}=require('../src/discovery-contract.js');
const key='c'.repeat(64),id='11111111-1111-4111-8111-111111111111';

test('found routes: GET list, add with a key choice, hide; nothing else passes',()=>{
 for(const fn of [allowedMcpImport,allowed,allowedRequest]){
  assert.equal(fn('GET','/api/mcp-import/found'),true);
  assert.equal(fn('POST','/api/mcp-import/found/add',{key,keepSecrets:false}),true);
  assert.equal(fn('POST','/api/mcp-import/found/hide',{key,hidden:true}),true);
  assert.equal(fn('POST','/api/mcp-import/found/add',{key,keepSecrets:false,enabled:true}),false);
  assert.equal(fn('POST','/api/mcp-import/found/add',{key:'../x',keepSecrets:true}),false);
  assert.equal(fn('POST','/api/mcp-import/found',{}),false);
 }
});
test('found response keeps secret names only and drops anything unknown',()=>{
 const body={rows:[{key,name:'files',transport:'stdio',target:'npx files',secretNames:['TOKEN'],sources:[{origin:'Claude',file:'/Users/x/.claude.json',key:'files',env:{TOKEN:'sk-live-x'}}],state:'new',serverId:null,issue:null,env:{TOKEN:'sk-live-x'}}],girru:[{name:'dpro-memory',title:'Girru memory',apps:['Codex']}],skipped:0};
 const r=mcpImportResponse('/api/mcp-import/found',200,body);
 assert.doesNotMatch(JSON.stringify(r),/sk-live/);assert.equal(r.rows[0].sources[0].origin,'Claude');assert.deepEqual(r.girru[0].apps,['Codex']);
 assert.throws(()=>mcpImportResponse('/api/mcp-import/found',200,{rows:'x'}));
});
test('connections carry their sources',()=>{
 const r=connectorResponse('/api/mcp/servers',200,{servers:[{id,name:'files',transport:'stdio',sources:[{origin:'Codex',file:'/Users/x/.codex/config.toml',key:'files',secret:'no'}]}]});
 assert.deepEqual(r.servers[0].sources,[{origin:'Codex',file:'/Users/x/.codex/config.toml',key:'files',project:null,appId:null}]);
});
test('discovery keeps up to 5,000 of each kind, so MCP servers and SSH keys after many notes still show',()=>{
 const notes=Array.from({length:5300},(_,i)=>({id:i.toString(16).padStart(32,'0'),kind:'note',name:'n',from:'',state:'new'}));
 const body={settings:{watch:true,intervalMinutes:30,kinds:{}},roots:[],items:[...notes,{id:'f'.repeat(32),kind:'mcp',name:'files',from:'',state:'decision'},{id:'e'.repeat(32),kind:'ssh',name:'id_ed25519.pub',from:'',state:'new'}]};
 const view=discoveryResponse('/api/memory/import/discovery',200,body);
 assert.ok(view.items.some(x=>x.kind==='mcp'));assert.ok(view.items.some(x=>x.kind==='ssh'));assert.equal(view.items.filter(x=>x.kind==='note').length,5000);
});
test('SSH keys: GET only, public line only, never a private key',()=>{
 for(const fn of [allowedSshKeys,allowed,allowedRequest]){assert.equal(fn('GET','/api/security/ssh-keys'),true);assert.equal(fn('GET',`/api/security/ssh-keys/${'a'.repeat(64)}/public`),true);assert.equal(fn('GET','/api/security/ssh-keys/../../etc/public'),false);assert.equal(fn('POST','/api/security/ssh-keys',{}),false);}
 const list=sshKeysResponse('/api/security/ssh-keys',200,{keys:[{id:'a'.repeat(64),name:'id_ed25519',type:'ssh-ed25519',bits:256,fingerprint:'SHA256:'+'A'.repeat(43),comment:'me',where:'~/.ssh/id_ed25519.pub',folder:'/Users/x/.ssh',hasPublic:true,hasPrivate:true,hosts:[],updatedAt:'',privateKey:'-----BEGIN'}]});
 assert.doesNotMatch(JSON.stringify(list),/BEGIN/);
 assert.throws(()=>sshKeysResponse(`/api/security/ssh-keys/${'a'.repeat(64)}/public`,200,{publicKey:'-----BEGIN OPENSSH PRIVATE KEY-----'}));
 assert.equal(sshKeysResponse(`/api/security/ssh-keys/${'a'.repeat(64)}/public`,200,{publicKey:'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA me'}).publicKey,'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA me');
});
test('Found, not added and SSH keys render their quiet lists',()=>{
 const {McpFoundPlace}=require('../src/McpFound.tsx'),{SshKeysSettings}=require('../src/SshKeysSettings.tsx');
 const list={rows:[{key,name:'files',transport:'stdio',target:'npx files',secretNames:['TOKEN'],sources:[{origin:'Claude',file:'/Users/x/.claude.json',key:'files',project:null,appId:null,appName:null,issue:null},{origin:'Codex',file:'/Users/x/.codex/config.toml',key:'files',project:null,appId:null,appName:null,issue:null}],state:'new',serverId:null,issue:null}],girru:[{name:'dpro-memory',title:'Girru memory',apps:['Claude','Codex']}],skipped:0};
 const html=renderToStaticMarkup(React.createElement(McpFoundPlace,{client:{},found:{list,phase:'ready',reload:async()=>{},fresh:1},onAdded(){},onOpen(){},onAddByHand(){}}));
 for(const words of ['Found, not added','Girru memory','files','Claude','Codex','Not added'])assert.ok(html.includes(words),words);
 const ssh=renderToStaticMarkup(React.createElement(SshKeysSettings,{client:{request:async()=>({status:200,body:{keys:[]}})},active:false}));
 assert.match(ssh,/Keys in ~\/.ssh/);assert.match(ssh,/aria-label="SSH keys"|Selected SSH key/);assert.doesNotMatch(ssh,/textarea/);
});
