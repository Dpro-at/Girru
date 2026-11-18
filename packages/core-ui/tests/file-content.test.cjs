require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { csvRows, pointerChild, fileKind } = require('../src/file-content.ts');
const { allowedConversation, conversationResponse } = require('../src/conversation-contract.js');
const { allowedTerminal } = require('../src/terminal-contract.js');
const { TerminalTabs } = require('../src/terminal.ts');
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
test('CSV keeps quoted delimiters, newlines, quotes, empty cells, formula text and leading zeros', () => {
  assert.deepEqual(csvRows('name,value,last\r\n"a,b","line1\nline2",\r\n"a""b",001,=SUM(A1)\n').rows,
    [['name','value','last'],['a,b','line1\nline2',''],['a"b','001','=SUM(A1)']]);
  assert.ok(csvRows('"unfinished').error);
  assert.ok(csvRows('"end"bad').error);
  assert.equal(csvRows('a\nb\nc',2).truncated,true);
  assert.equal(csvRows('a,b,c',100,2).truncated,true);
});
test('JSON pointer escaping and file kinds do not treat data as executable documents', () => {
  assert.equal(pointerChild('/root','a~/b'),'/root/a~0~1b');
  for (const [p,k] of [['x.SVG','image'],['x.json','json'],['x.csv','csv'],['x.webm','video'],['x.m4a','audio'],['x.txt','text']]) assert.equal(fileKind(p),k);
});
test('media wire route permits reviewed relative reads and bounds MIME/base64 payload', () => {
  const p=`/api/chat/projects/${ID}/media?path=images%2Fart.svg`;
  assert.equal(allowedConversation('GET',p),true);
  assert.equal(allowedConversation('POST',p),false);
  assert.equal(allowedConversation('GET',`/api/chat/projects/${ID}/media?path=..%2Fkey`),false);
  assert.deepEqual(conversationResponse(p,200,{path:'images/art.svg',size:3,mime:'image/svg+xml',base64:'YWJj',secret:'no'}),{path:'images/art.svg',size:3,mime:'image/svg+xml',base64:'YWJj'});
  assert.throws(()=>conversationResponse(p,200,{path:'x',mime:'text/html',base64:'YWJj'}));
});
test('command tabs deduplicate creation, select keeps identity, stop waits for actual exit', async () => {
  const calls=[];let frame;
  const client={request:async r=>{calls.push(r);return {status:r.path.endsWith('/stop')?204:201,body:{id:ID,cwd:'/fictional/project',shell:'sh'}};},terminalStream:async(id,last,fn,signal)=>{frame=fn;await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return {ended:true,last:1};}};
  const tabs=new TerminalTabs(client);
  const first=tabs.command('reply:1','printf hi; exit 7',ID);
  assert.equal(tabs.command('reply:1','printf hi; exit 7',ID),first);
  await new Promise(r=>setImmediate(r));
  assert.equal(calls.length,1);assert.equal(calls[0].body.command,'printf hi; exit 7');
  tabs.select(first.key);assert.equal(tabs.getSnapshot().tabs[0].terminal,first.terminal);
  await first.terminal.stop();assert.equal(first.terminal.getSnapshot().phase,'stopping');
  frame({type:'exit',exitCode:7});assert.equal(first.terminal.getSnapshot().phase,'exited');assert.equal(first.terminal.getSnapshot().exitCode,7);
  assert.equal(calls.filter(x=>x.path==='/api/terminal/sessions').length,1);
  tabs.dispose();
});
test('command and stop contracts reject unsupported executable and malformed inputs', () => {
  assert.equal(allowedTerminal('POST','/api/terminal/sessions',{command:'printf hi',projectId:ID}),true);
  assert.equal(allowedTerminal('POST','/api/terminal/sessions',{command:'x\0y'}),false);
  assert.equal(allowedTerminal('POST','/api/terminal/sessions',{command:'x',shell:'/bad'}),false);
  assert.equal(allowedTerminal('POST',`/api/terminal/sessions/${ID}/stop`),true);
});


test('terminal parser preserves the real signal instead of reporting stopped work as exit zero', () => {
  const {TerminalEventParser}=require('../src/terminal-contract.js');
  assert.deepEqual(new TerminalEventParser().push(Buffer.from('event: exit\ndata: {"exitCode":0,"signal":1}\n\n')),[{type:'exit',exitCode:0,signal:1}]);
});


test('bridge stop acknowledgement cannot overwrite an exit that arrived first', async () => {
  const {TerminalController}=require('../src/terminal.ts');let frame;
  const client={request:async r=>{if(r.path.endsWith('/stop')){frame({type:'exit',exitCode:0,signal:1});return{status:200,body:{ok:true}};}return{status:201,body:{id:ID}};},terminalStream:async(id,last,fn,signal)=>{frame=fn;await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return{last:0,ended:true};}};
  const terminal=new TerminalController(client);await terminal.open(ID,{cols:80,rows:24},'read reply');await terminal.stop();
  assert.equal(terminal.getSnapshot().phase,'exited');assert.equal(terminal.getSnapshot().signal,1);assert.equal(terminal.getSnapshot().message,undefined);terminal.dispose();
});
