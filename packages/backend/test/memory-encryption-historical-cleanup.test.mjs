// Deferred: the whole ENC task must finish before any fixture is executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {randomBytes} from 'node:crypto';
import {sqliteStepsOn} from '../src/repositories/sql-steps.ts';
import {memoryRowSurfaceManifest,encryptMemoryRow} from '../src/memory/encryption/row-codec.ts';
import {loadEncryptedForgetRows,sameForgetRows} from '../src/memory/encryption/forget-scrub-store.ts';
const scope={ownerId:'synthetic-owner',memberId:'synthetic-member'};
test('cleanup snapshot retains the full multi-version history after a declared-surface restore',async()=>{
 const db=new Database(':memory:'),key=randomBytes(32);try{
  for(const {table} of memoryRowSurfaceManifest()){
   const s=memoryRowSurfaceManifest().find(s=>s.table===table),fields=[s.owner,s.id,...s.bound,...s.clear,...s.text,...s.binary];
   db.exec(`CREATE TABLE ${table}(${fields.map(f=>f+' '+(s.binary.includes(f)?'BLOB':s.clear.includes(f)?'INTEGER':'TEXT')).join(',')})`);
   if(table!=='memory_versions')continue;
   const insert=db.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`);
   db.transaction(()=>{for(let i=0;i<1866;i++){
    const row=Object.fromEntries([[s.owner,scope.ownerId],[s.id,'history-'+i],...s.bound.map(f=>[f,f==='memory_id'?'memory-'+Math.floor(i/2):f==='version'?i%2+1:null]),...s.text.map(f=>[f,f==='content'?'SYNTHETIC_CLEANUP_HISTORY':null])]);
    const encrypted=encryptMemoryRow(table,row,scope,key,'synthetic-key');insert.run(...fields.map(f=>encrypted[f]));
   }})();
  }
  const runner=sqliteStepsOn(db),first=await loadEncryptedForgetRows(runner,scope.ownerId);assert.equal(first.memory_versions.length,1866);
  assert.equal(sameForgetRows(first,await loadEncryptedForgetRows(runner,scope.ownerId)),true);
  db.prepare('DELETE FROM memory_versions WHERE id=?').run('history-1');assert.equal(sameForgetRows(first,await loadEncryptedForgetRows(runner,scope.ownerId)),false);
 }finally{key.fill(0);db.close();}
});
