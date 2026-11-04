// CHAT-GAPS-01: images of a chat reach Claude Code (stream-json image blocks) like Codex (-i); Gemini stays on the notice.
// Run: node --import tsx --test test/subscription-images.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const root=mkdtempSync(join(tmpdir(),'subscription-images-')),home=join(root,'home'),workspace=join(root,'workspace'),dataDir=join(root,'.data');
mkdirSync(join(home,'.local','bin'),{recursive:true});mkdirSync(workspace);
process.env.AGENT_PLAYER_DATA_DIR=dataDir;
const {subscriptionArgs,subscriptionAnswer,claudeStreamMessage,claudeImageBlocks,chatImagesSeenBy,CLAUDE_IMAGE_STDIN_BYTES}=await import('../src/services/subscription-chat.ts');
const {saveChatImage,MAX_IMAGE_BYTES}=await import('../src/services/chat-images.ts');
const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from('synthetic-png-body')]);
const jpg=Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),Buffer.from('synthetic-jpeg')]);
const chat='chat-images-0001';
const fileOf=img=>join(dataDir,'chat-images',chat,`${img.id}.${img.type==='image/png'?'png':'jpg'}`);
const a=saveChatImage(chat,png.toString('base64'),'a.png'),b=saveChatImage(chat,jpg.toString('base64'),'b.jpg');
const files=[fileOf(a),fileOf(b)];
const BASE=['-p','--no-session-persistence','--safe-mode','--restricted','--permission-mode','acceptEdits','--permission-prompts','none','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}'];

test('Claude Code with images: stream-json in and out (+ --verbose), every restriction flag kept; text-only turns unchanged',()=>{
 assert.deepEqual(subscriptionArgs('claude',undefined,undefined,true),['-p','--output-format','json',...BASE.slice(1)],'text-only: the json path as before');
 assert.deepEqual(subscriptionArgs('claude',undefined,undefined,true,false,false,[],files),['-p','--input-format','stream-json','--output-format','stream-json','--verbose',...BASE.slice(1)]);
 const withModel=subscriptionArgs('claude',undefined,'opus',true,false,false,[],files,'deep');assert.deepEqual(withModel.slice(-4),['--model','opus','--effort','high']);
 assert.ok(!withModel.some(x=>files.includes(x)),'no image path on the command line');
 assert.deepEqual(subscriptionArgs('claude',undefined,undefined,true,false,false,[],['/etc/hosts.png']),subscriptionArgs('claude',undefined,undefined,true),'a file outside the images folder does not switch the path');
 const g=subscriptionArgs('gemini',undefined,undefined,true,false,false,[],files);assert.ok(!g.some(x=>files.includes(x)),'Gemini gets no image');
});

test('the stdin message carries the prompt then base64 image blocks, with only the keys Claude Code accepts',async()=>{
 const blocks=await claudeImageBlocks(files);assert.deepEqual(blocks.map(x=>x.file),files);
 const line=claudeStreamMessage('Describe "this"\nplease',blocks);assert.ok(line.endsWith('\n')&&!line.slice(0,-1).includes('\n'),'one NDJSON line');
 assert.deepEqual(JSON.parse(line),{type:'user',parent_tool_use_id:null,message:{role:'user',content:[{type:'text',text:'Describe "this"\nplease'},
  {type:'image',source:{type:'base64',media_type:'image/png',data:png.toString('base64')}},{type:'image',source:{type:'base64',media_type:'image/jpeg',data:jpg.toString('base64')}}]}});
 assert.ok(CLAUDE_IMAGE_STDIN_BYTES>=200000+4*Math.ceil(MAX_IMAGE_BYTES/3)*4,'the stdin budget counts base64');
});

test('stream-json output parses to the same final answer as the json path, and fails closed',()=>{
 const lines=rows=>rows.map(x=>JSON.stringify(x)).join('\n')+'\n';
 const ok=[{type:'system',subtype:'init',tools:[]},{type:'assistant',message:{content:[{type:'text',text:'draft'}]}},{type:'result',subtype:'success',is_error:false,result:'I see a red square.'}];
 assert.equal(subscriptionAnswer('claude',lines(ok),true),'I see a red square.');
 assert.equal(subscriptionAnswer('claude',JSON.stringify({type:'result',result:'same'})),'same','json path unchanged');
 assert.throws(()=>subscriptionAnswer('claude',lines(ok.slice(0,2)),true),/cli_failed/,'no result');
 assert.throws(()=>subscriptionAnswer('claude',lines([...ok,ok[2]]),true),/cli_failed/,'two results');
 assert.throws(()=>subscriptionAnswer('claude',lines([{type:'result',is_error:true,result:'x'}]),true),/cli_failed/);
 assert.throws(()=>subscriptionAnswer('claude',lines([{type:'result',is_error:true,api_error_code:'oauth_not_allowed_for_organization',result:'x'}]),true),/subscription_org_blocked/);
 assert.throws(()=>subscriptionAnswer('claude','not json\n',true));
});

test('who sees images: Codex and Claude Code the chat\'s files; Gemini none (the chat keeps the images_not_seen notice)',async()=>{
 assert.deepEqual(await chatImagesSeenBy('subscription:codex',files),files);
 assert.deepEqual(await chatImagesSeenBy('subscription:claude/opus',[...files,'/etc/passwd']),files);
 assert.deepEqual(await chatImagesSeenBy('subscription:gemini',files),[]);
 const fake=join(dataDir,'chat-images',chat,`${'f'.repeat(32)}.png`);writeFileSync(fake,'not an image');
 assert.deepEqual(await chatImagesSeenBy('subscription:claude',[fake]),[],'a file that is not an image is not shown');
 const route=readFileSync(new URL('../src/api/routes/chat.ts',import.meta.url),'utf8');
 assert.match(route,/const seen=await chatImagesSeenBy\(subscriptionSource,input\.images\?\.map\(i=>i\.file\)\);\n\s*if\(input\.images\?\.length&&!seen\.length\)\{currentChatRun\(\)\?\.notice\?\.\('images_not_seen'/);
 assert.match(route,/images:seen,thinking/);
});

const run=promisify(execFile),binary=join(home,'.local','bin','claude'),record=join(home,'.local','bin','record.json');
const source=new URL('../src/services/subscription-chat.ts',import.meta.url).href;
// Fake claude: records its argv and stdin, then answers in the format its flags ask for.
const FAKE=`const fs=require('node:fs');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{fs.writeFileSync(require('node:path').join(__dirname,'record.json'),JSON.stringify({argv:process.argv.slice(2),stdin:s}));
 if(process.argv.includes('stream-json')){const m=JSON.parse(s.trim());const n=m.message.content.filter(c=>c.type==='image').length;
  for(const row of [{type:'system',subtype:'init'},{type:'assistant',message:{content:[{type:'text',text:'x'}]}},{type:'result',subtype:'success',is_error:false,result:'saw '+n+' images'}])process.stdout.write(JSON.stringify(row)+'\\n');}
 else process.stdout.write(JSON.stringify({type:'result',result:'text:'+s}));});`;
async function fixture(code){writeFileSync(binary,'#!'+process.execPath+'\n'+FAKE,{mode:0o700});const result=await run(process.execPath,['--import','tsx','--input-type=module','-e',`const api=await import(${JSON.stringify(source)});try{${code}}finally{await api.stopSubscriptionProcesses();}`],{env:{PATH:process.env.PATH,HOME:home,DPRO_SUBSCRIPTION_CHAT:'1',AGENT_PLAYER_DATA_DIR:dataDir,DATABASE_PATH:join(dataDir,'fixture.db')},timeout:20000,maxBuffer:65536});return result.stdout.trim().split("\n").pop();}

test('fake Claude Code binary: an image turn sends one stream-json message and returns the result; a text turn is unchanged',async()=>{
 const sig='new AbortController().signal';
 assert.equal(await fixture(`console.log(await api.runSubscription('subscription:claude',${JSON.stringify(workspace)},'What is in it?',${sig},{appToolsOnly:true,images:${JSON.stringify(files)}}));`),'saw 2 images');
 let rec=JSON.parse(readFileSync(record,'utf8'));
 assert.deepEqual(rec.argv,['-p','--input-format','stream-json','--output-format','stream-json','--verbose',...BASE.slice(1)]);
 const msg=JSON.parse(rec.stdin);assert.ok(rec.stdin.endsWith('\n'));
 assert.deepEqual(msg.message.content.map(c=>c.type==='text'?c.text:c.source.media_type+':'+c.source.data),['What is in it?','image/png:'+png.toString('base64'),'image/jpeg:'+jpg.toString('base64')]);
 assert.equal(await fixture(`console.log(await api.runSubscription('subscription:claude',${JSON.stringify(workspace)},'plain words',${sig},{appToolsOnly:true}));`),'text:plain words');
 rec=JSON.parse(readFileSync(record,'utf8'));assert.deepEqual(rec.argv,['-p','--output-format','json',...BASE.slice(1)]);assert.equal(rec.stdin,'plain words');
});

test('an image file that cannot be read stops the turn before Claude Code starts',async()=>{
 const gone=join(dataDir,'chat-images',chat,`${'e'.repeat(32)}.png`);writeFileSync(record,'{}');
 assert.equal(await fixture(`try{await api.runSubscription('subscription:claude',${JSON.stringify(workspace)},'x',new AbortController().signal,{appToolsOnly:true,images:${JSON.stringify([gone])}});console.log('unexpected');}catch(e){console.log(e.message);}`),'cli_input_invalid');
 assert.equal(readFileSync(record,'utf8'),'{}','never launched');
});

test('Claude Code gets an image only up to 3.75 MB (5 MB once in base64); a bigger one is left out', async () => {
  const { CLAUDE_IMAGE_RAW_BYTES } = await import('../src/services/subscription-chat.ts');
  assert.equal(CLAUDE_IMAGE_RAW_BYTES, 3932160);
  assert.ok(Math.ceil(CLAUDE_IMAGE_RAW_BYTES / 3) * 4 <= 5 * 1024 * 1024);
});
