import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {recallEncryptedMemories} from '../src/memory/encryption/recall.ts';
import {encryptMemoryRow,memoryRowSurfaceManifest} from '../src/memory/encryption/row-codec.ts';
import {MemoryCipherError} from '../src/memory/encryption/envelope.ts';
const key=randomBytes(32),scope={ownerId:'recall-owner',memberId:'recall-member'},manifest=memoryRowSurfaceManifest().find(x=>x.table==='memories');
function cipher(id,content,project='allowed',status='active',ownerId=scope.ownerId){
 const row=Object.fromEntries([[manifest.id,id],[manifest.owner,ownerId],...manifest.bound.map(f=>[f,null]),...manifest.text.map(f=>[f,null]),...manifest.binary.map(f=>[f,null])]);
 Object.assign(row,{content,drawer_kind:'project',drawer_key:project,status});return encryptMemoryRow('memories',row,{...scope,ownerId},key,'recall-key');
}
function options(extra={}){
 const buffers=[];return {buffers,settings:{scope,query:'teal report',authorize:row=>row.drawer_key==='allowed',isCurrent:()=>true,validateCurrent:async()=>true,recordRead:async()=>true,resolveKey:async()=>{const buffer=Buffer.from(key);buffers.push(buffer);return {id:'recall-key',key:buffer,scope};},...extra}};
}
test('authorized English/Arabic recall reuses lexical ranking, excludes other scopes, and wipes opened key buffers',async()=>{
 const rows=[cipher('a','Use teal covers for the trial report.'),cipher('b','The invoice is due on Friday.'),cipher('private','teal report secret','denied'),cipher('old','teal report obsolete','allowed','replaced'),cipher('other-owner','teal report other','allowed','active','someone-else')];
 const x=options(),result=await recallEncryptedMemories(rows,x.settings);assert.deepEqual(result.map(x=>x.id),['a']);
 assert.equal(x.buffers.length,2);assert.ok(x.buffers.every(b=>b.equals(Buffer.alloc(32))));
 const ar=options({query:'اللون الأزرق'});const found=await recallEncryptedMemories([cipher('arabic','نختار اللون الأزرق لغلاف التقرير التجريبي.')],ar.settings);assert.equal(found[0].id,'arabic');
 assert.deepEqual(await recallEncryptedMemories(rows,options({query:'nonexistentterm'}).settings),[]);
});
test('locked or revoked sessions cannot decrypt or return results, including lock during asynchronous key opening',async()=>{
 let current=true,opened;const x=options({isCurrent:()=>current,resolveKey:async()=>{opened=Buffer.from(key);current=false;return {id:'recall-key',key:opened,scope};}});
 await assert.rejects(recallEncryptedMemories([cipher('a','teal report')],x.settings),MemoryCipherError);assert.ok(opened.equals(Buffer.alloc(32)));
 const locked=options({isCurrent:()=>false,resolveKey:async()=>{throw Error('must not open');}});await assert.rejects(recallEncryptedMemories([],locked.settings),MemoryCipherError);
});
test('a forged allowed drawer or malformed ciphertext fails closed, not as an empty or leaked result',async()=>{
 const moved={...cipher('private','teal secret','denied'),drawer_key:'allowed'};
 await assert.rejects(recallEncryptedMemories([moved],options().settings),MemoryCipherError);
 const bad={...cipher('a','teal report'),content:'plaintext-fallback'};
 await assert.rejects(recallEncryptedMemories([bad],options().settings),MemoryCipherError);
});
test('bounds, missing permission and mismatched member keys do not open unbounded or unauthorized candidates',async()=>{
 const row=cipher('a','teal report'),denied=options({authorize:()=>false});assert.deepEqual(await recallEncryptedMemories([row],denied.settings),[]);assert.equal(denied.buffers.length,0);
 await assert.rejects(recallEncryptedMemories([row,row],options({maxCandidates:1}).settings),MemoryCipherError);
 await assert.rejects(recallEncryptedMemories([row],options({limit:51}).settings),MemoryCipherError);
 await assert.rejects(recallEncryptedMemories([row],options({query:'x'.repeat(4097)}).settings),MemoryCipherError);
 await assert.rejects(recallEncryptedMemories([row],options({resolveKey:async()=>({id:'recall-key',key:Buffer.from(key),scope:{...scope,memberId:'wrong'}})}).settings),MemoryCipherError);
});
test('an asynchronous key lookup cannot replace the already-authorized row snapshot with another project',async()=>{
 const original=cipher('allowed-row','teal public report'),replacement=cipher('private-row','teal confidential report','denied');
 const x=options({resolveKey:async()=>{Object.assign(original,replacement);return {id:'recall-key',key:Buffer.from(key),scope};}});
 const found=await recallEncryptedMemories([original],x.settings);assert.equal(found[0].id,'allowed-row');assert.equal(found[0].content,'teal public report');
});

test('legacy NULL active status is not silently omitted',async()=>{
 const found=await recallEncryptedMemories([cipher('legacy','teal report','allowed',null)],options().settings);assert.equal(found[0].id,'legacy');
});

test('encrypted input byte budget rejects oversized work before opening a key',async()=>{
 const x=options({maxEncryptedBytes:1024});const candidate={...cipher('bounded','teal report'),extra:'x'.repeat(1025)};
 await assert.rejects(recallEncryptedMemories([candidate],x.settings),MemoryCipherError);assert.equal(x.buffers.length,0);
});

test('request member identity is captured before asynchronous resolution',async()=>{
 const requestScope={...scope,memberId:'unprivileged'},candidate=cipher('bound-member','teal confidential report');let opened;
 const x=options({scope:requestScope,resolveKey:async()=>{requestScope.memberId=scope.memberId;opened=Buffer.from(key);return {id:'recall-key',key:opened,scope};}});
 await assert.rejects(recallEncryptedMemories([candidate],x.settings),MemoryCipherError);assert.ok(opened.equals(Buffer.alloc(32)));
});

test('audit failure or a lock during audit cannot open a data key',async()=>{
 const row=cipher('audited','teal report'),failed=options({recordRead:async()=>false});
 await assert.rejects(recallEncryptedMemories([row],failed.settings),MemoryCipherError);assert.equal(failed.buffers.length,0);
 let current=true;const locked=options({isCurrent:()=>current,recordRead:async()=>{current=false;return true;}});
 await assert.rejects(recallEncryptedMemories([row],locked.settings),MemoryCipherError);assert.equal(locked.buffers.length,0);
});
test('all decrypt candidates are durably logged before keys open, including nonmatching rows but excluding denied ones',async()=>{
 const {default:Database}=await import('better-sqlite3');const {sqliteStepsOn}=await import('../src/repositories/sql-steps.ts');
 const {createMemoryReadAuditStore,deriveMemoryAuditKey}=await import('../src/memory/encryption/read-audit.ts');
 const db=new Database(':memory:'),auditKey=deriveMemoryAuditKey(randomBytes(32),scope.ownerId),store=createMemoryReadAuditStore(sqliteStepsOn(db),scope.ownerId,auditKey);
 try{
  await store.initialize();let anchor=store.genesis();
  const x=options({recordRead:async ids=>{anchor=await store.append(anchor,{readerKind:'agent',readerId:'test-agent',purpose:'recall',records:ids.map(id=>({table:'memories',id}))});return true;},resolveKey:async()=>{assert.equal(db.prepare('SELECT count(*) n FROM memory_encryption_read_audit').get().n,1);return {id:'recall-key',key:Buffer.from(key),scope};}});
  const found=await recallEncryptedMemories([cipher('a','teal report'),cipher('b','unrelated invoice'),cipher('denied','teal report','denied')],x.settings);
  assert.deepEqual(found.map(x=>x.id),['a']);await store.verify(anchor);
  const payload=db.prepare('SELECT payload FROM memory_encryption_read_audit').get().payload;
  assert.deepEqual(JSON.parse(payload).records.map(x=>x.id),['a','b']);assert.ok(!payload.includes('teal report'));assert.ok(!payload.includes('unrelated invoice'));
 }finally{store.close();auditKey.fill(0);db.close();}
});
test('process key lease gates actual recall and rejects permission invalidation during audit',async()=>{
 const {createMemoryUnlockSession}=await import('../src/memory/encryption/unlock-session.ts');
 const session=createMemoryUnlockSession();session.unlock(key,'recall-key',scope);
 const lease=session.capture(),rows=[cipher('lease-record','teal report')];
 const successful=options({...lease});assert.equal((await recallEncryptedMemories(rows,successful.settings))[0].id,'lease-record');
 const interrupted=options({...lease,recordRead:async()=>{session.invalidatePermissions();return true;}});
 await assert.rejects(recallEncryptedMemories(rows,interrupted.settings),MemoryCipherError);
 assert.equal(lease.isCurrent(),false);
});
test('authoritative asynchronous revision denial after audit blocks key opening even when local lease stays current',async()=>{
 let permitted=true,opened=0;
 const x=options({validateCurrent:async()=>permitted,recordRead:async()=>{permitted=false;return true;},resolveKey:async()=>{opened++;return {id:'recall-key',key:Buffer.from(key),scope};}});
 await assert.rejects(recallEncryptedMemories([cipher('revision-row','teal report')],x.settings),MemoryCipherError);
 assert.equal(opened,0);
 const missing=options({validateCurrent:undefined});await assert.rejects(recallEncryptedMemories([],missing.settings),MemoryCipherError);
});
