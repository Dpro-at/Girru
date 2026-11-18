import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRegularFile } from '../src/memory/bridge/regular-file.ts';

test('descriptor reads reject links, directories, oversize files and swaps between inspection and open', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dpro-regular-file-'));
 const file=path.join(root,'config'),other=path.join(root,'other');
 const open=fs.openSync;
 try {
  fs.writeFileSync(file,'original',{mode:0o600});fs.writeFileSync(other,'private');
  assert.equal(readRegularFile(root,'config',32).bytes.toString(),'original');
  assert.throws(()=>readRegularFile(root,'config',2),{code:'EFBIG'});
  assert.throws(()=>readRegularFile(root,'.',32),{code:'ENOTREG'});
  fs.symlinkSync(other,path.join(root,'link'));
  assert.throws(()=>readRegularFile(root,'link',32),{code:'ENOTREG'});
  fs.openSync=function(target,...args){
   if(target===file){fs.renameSync(file,file+'.old');fs.symlinkSync(other,file);}
   return open.call(fs,target,...args);
  };
  assert.throws(()=>readRegularFile(root,'config',32));
  fs.openSync=open;
  fs.mkdirSync(path.join(root,'inner'));fs.writeFileSync(path.join(root,'inner','note'),'inside');
  assert.equal(readRegularFile(root,'inner/note',32).bytes.toString(),'inside');
  assert.throws(()=>readRegularFile(path.join(root,'inner'),'../other',32),{code:'ENOTREG'});
  assert.throws(()=>readRegularFile(path.join(root,'inner'),other,32),{code:'ENOTREG'});
  fs.symlinkSync(root,path.join(root,'inner','up'));
  assert.throws(()=>readRegularFile(path.join(root,'inner'),'up/other',32),{code:'ENOTREG'},'a linked folder on the way cannot lead outside');
 } finally {fs.openSync=open;fs.rmSync(root,{recursive:true,force:true});}
});

test('the descriptor is bound to the leaf entry even when no-follow is unavailable',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dpro-regular-fallback-')),file=path.join(root,'file'),other=path.join(root,'outside');const open=fs.openSync;
 try{fs.writeFileSync(file,'original');fs.writeFileSync(other,'PRIVATE FIXTURE');fs.openSync=function(target,flags,...args){if(target===file){fs.renameSync(file,file+'.old');fs.symlinkSync(other,file);}return open.call(fs,target,flags&~(fs.constants.O_NOFOLLOW??0),...args);};assert.throws(()=>readRegularFile(root,'file',64),{code:'ENOTREG'});}finally{fs.openSync=open;fs.rmSync(root,{recursive:true,force:true});}
});
