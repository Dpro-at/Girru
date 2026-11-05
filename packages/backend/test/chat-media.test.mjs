import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFolderMedia, MAX_MEDIA_BYTES } from '../src/repositories/project-files.ts';
import { TerminalManager } from '../src/terminal/manager.ts';

test('media reads are bounded, project-confined and refuse secret symlink targets', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'girru-media-'));const project=path.join(root,'project');await fs.mkdir(project);
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const image=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>fictional</text></svg>');
  await fs.writeFile(path.join(project,'art.svg'),image);
  const r=await readFolderMedia(project,'art.svg');assert.equal(r.mime,'image/svg+xml');assert.deepEqual(Buffer.from(r.base64,'base64'),image);
  await fs.writeFile(path.join(project,'.env'),'synthetic');
  assert.equal((await readFolderMedia(project,'.env')).reason,'hidden');
  if(process.platform!=='win32'){
    await fs.symlink('.env',path.join(project,'secret.svg'));
    assert.equal((await readFolderMedia(project,'secret.svg')).reason,'hidden');
    await fs.writeFile(path.join(root,'outside.svg'),image);await fs.symlink('../outside.svg',path.join(project,'outside.svg'));
    await assert.rejects(readFolderMedia(project,'outside.svg'));
  }
  await assert.rejects(readFolderMedia(project,'../outside.svg'));
  const large=await fs.open(path.join(project,'large.mp4'),'w');await large.truncate(MAX_MEDIA_BYTES+1);await large.close();
  assert.deepEqual(await readFolderMedia(project,'large.mp4'),{path:'large.mp4',size:0,reason:'too_large'});
});

test('command mode passes exact command as one shell argument, stop keeps transcript until real exit', async t => {
  for(const platform of ['darwin','win32']){
    let args,exit,data,killed=false;
    const manager=new TerminalManager({os:platform,env:{AGENT_TERMINAL:'true',SHELL:'/bin/sh'},spawn:(file,a)=>{args=a;return{onData:f=>{data=f;},onExit:f=>{exit=f;},write(){},resize(){},kill(signal){if(platform==='win32' && signal!==undefined)throw new Error('Signals not supported on windows');killed=true;}};}});
    t.after(()=>manager.closeAll());
    const exact='printf "a; b"; exit 7';
    const session=await manager.create('owner',{cwd:os.tmpdir(),command:exact});
    assert.equal(platform==='win32'?Buffer.from(args.at(-1),'base64').toString('utf16le'):args.at(-1),exact);assert.ok(args.includes(platform==='win32'?'-EncodedCommand':'-c'));
    const seen=[];manager.subscribe('owner',session.id,0,e=>seen.push(e));data('fictional output');manager.stop('owner',session.id);
    assert.equal(killed,true);assert.equal(seen.some(e=>e.type==='exit'),false);exit({exitCode:7,signal:1});assert.equal(seen.at(-1).exitCode,7);
    const replay=[];manager.subscribe('owner',session.id,0,e=>replay.push(e));assert.equal(replay[0].chunk.data,'fictional output');assert.equal(replay.at(-1).exitCode,7);assert.equal(replay.at(-1).signal,1);
    assert.throws(()=>manager.stop('other',session.id));
    await assert.rejects(manager.create('owner',{command:'x\0y'}));
  }
});

test('finished command transcripts expire and never exhaust the live-session slots', async t => {
  const exits=[];
  const manager=new TerminalManager({exitRetentionMs:20,env:{AGENT_TERMINAL:'true',SHELL:'/bin/sh'},spawn:()=>({onData(){},onExit(fn){exits.push(fn);},write(){},resize(){},kill(){}})});
  t.after(()=>manager.closeAll());
  for(let i=0;i<8;i++){await manager.create('owner',{command:'printf done',cwd:os.tmpdir()});exits.at(-1)({exitCode:0});}
  assert.ok(manager.list('owner').length<=4);
  await new Promise(r=>setTimeout(r,40));assert.equal(manager.list('owner').length,0);
  await manager.create('owner',{command:'printf next',cwd:os.tmpdir()});
  assert.equal(manager.list('owner').length,1);
});

test('live commands ignore input-idle expiry; Stop escalates and keeps the real exit event', async t=>{
  let exit;const kills=[];
  const manager=new TerminalManager({idleTimeoutMs:5,stopGraceMs:10,exitRetentionMs:100,env:{AGENT_TERMINAL:'true',SHELL:'/bin/sh'},spawn:()=>({onData(){},onExit(fn){exit=fn;},write(){},resize(){},kill(signal){kills.push(signal);if(signal==='SIGKILL')exit({exitCode:0,signal:9});}})});
  t.after(()=>manager.closeAll());const s=await manager.create('owner',{command:'wait',cwd:os.tmpdir()});
  const frames=[];manager.subscribe('owner',s.id,0,f=>frames.push(f));
  await new Promise(r=>setTimeout(r,20));assert.equal(manager.list('owner').length,1);assert.deepEqual(kills,[]);
  manager.stop('owner',s.id);assert.deepEqual(kills,['SIGTERM']);assert.equal(frames.length,0);
  await new Promise(r=>setTimeout(r,25));assert.deepEqual(kills,['SIGTERM','SIGKILL']);assert.equal(frames.at(-1).signal,9);
});

test('server refuses hidden execution-changing characters but retains multiline scripts',async()=>{
  const {safeTerminalCommand}=await import('../src/terminal/manager.ts');
  const {safeTerminalCommand:clientSafe}=await import('../../core-ui/src/terminal-contract.js');
  for(const [command,ok] of [['echo one\necho two',true],['printf "مرحبا"',true],['echo\tvalue',true],['echo a\rb',false],['echo \x1b[31mb',false],['echo \u202eb',false],['echo \u200bb',false],['echo \u061cb',false]]){assert.equal(safeTerminalCommand(command),ok);assert.equal(clientSafe(command),ok);}
});
