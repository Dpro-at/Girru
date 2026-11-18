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
  // Chat commands stay off on Windows until verified on a real Windows shell.
  const off=new TerminalManager({os:'win32',env:{AGENT_TERMINAL:'true'},spawn:()=>{throw new Error('must not spawn');}});
  await assert.rejects(off.create('owner',{cwd:os.tmpdir(),command:'dir'}),e=>e.code==='unsupported');
  for(const platform of ['darwin','linux']){
    let args,exit,data,killed=false;
    const manager=new TerminalManager({os:platform,env:{AGENT_TERMINAL:'true',SHELL:'/bin/sh'},spawn:(file,a)=>{args=a;return{onData:f=>{data=f;},onExit:f=>{exit=f;},write(){},resize(){},kill(){killed=true;}};}});
    t.after(()=>manager.closeAll());
    const exact='printf "a; b"; exit 7';
    const session=await manager.create('owner',{cwd:os.tmpdir(),command:exact});
    assert.equal(args.at(-1),exact);assert.ok(args.includes('-c'));
    const seen=[];manager.subscribe('owner',session.id,0,e=>seen.push(e));data('fictional output');manager.stop('owner',session.id);
    assert.equal(killed,true);assert.equal(seen.some(e=>e.type==='exit'),false);exit({exitCode:7,signal:1});assert.equal(seen.at(-1).exitCode,7);
    const replay=[];manager.subscribe('owner',session.id,0,e=>replay.push(e));assert.equal(replay[0].chunk.data,'fictional output');assert.equal(replay.at(-1).exitCode,7);assert.equal(replay.at(-1).signal,1);
    assert.throws(()=>manager.stop('other',session.id));
    await assert.rejects(manager.create('owner',{command:'x\0y'}));
  }
});
