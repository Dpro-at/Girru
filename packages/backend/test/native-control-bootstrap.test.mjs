/** Deferred synthetic control bootstrap fixtures; no operating-system custody acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {openNativeControlBootstrap} from '../src/memory/encryption/native-control-bootstrap.ts';
const require=createRequire(import.meta.url),C=require('../../identity/src/memory-native-proof.cjs');
test('a caller-selected path without the real signed native capsule cannot open even an empty control database',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'girru-control-deferred-'));try{fs.chmodSync(root,0o700);const database=path.join(root,'agent-player.db');fs.writeFileSync(database,'',{mode:0o600});const before=fs.statSync(database),dir=fs.statSync(root);await assert.rejects(openNativeControlBootstrap({bootstrap:{v:1,type:'native-control-bootstrap',launchId:randomBytes(32).toString('base64url'),control:{v:1,purpose:'new-native-control',controlId:'synthetic-control',storageId:'synthetic-storage',root,database,rootIdentity:String(dir.dev)+':'+String(dir.ino),fileIdentity:String(before.dev)+':'+String(before.ino)},capsulePath:path.join(root,'missing-capsule'),macKey:randomBytes(32).toString('base64url')},parentIsCurrent:()=>true,onPoison:()=>{}}));assert.equal(fs.statSync(database).size,0);assert.deepEqual(fs.readdirSync(root),['agent-player.db']);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('a private envelope cannot substitute an active signature with an unsigned authorization boolean',()=>{
 const key=randomBytes(32),value={v:1,purpose:'native-control-lease',state:'active',current:true};const bytes=C.signed(value,key),parsed=JSON.parse(bytes.toString());parsed.record.current=false;assert.throws(()=>C.openSigned(Buffer.from(JSON.stringify(parsed)),key,x=>x));key.fill(0);
});
