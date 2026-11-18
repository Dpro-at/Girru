// Synthetic source fixtures; execution waits for whole-task source completion.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createEncryptedRunAdmissionRegistry,captureEncryptedRunWriteAdmission} from '../src/memory/encryption/run-admission.ts';
import {attachEncryptedRunProducer,encryptedFieldProducer,encryptMemoryRow,decryptMemoryRow,memoryRowSurfaceManifest} from '../src/memory/encryption/row-codec.ts';
import {prepareMemoryCopyBatch,verifyMemoryCopyBatch} from '../src/memory/encryption/copy-batch.ts';
const scope={ownerId:'synthetic-owner',memberId:'synthetic-member'},keyId='synthetic-key';
function plain(table){const s=memoryRowSurfaceManifest().find(s=>s.table===table);return Object.fromEntries([[s.owner,scope.ownerId],[s.id,'synthetic-record'],...s.bound.map(k=>[k,null]),...s.clear.map(k=>[k,null]),...s.text.map(k=>[k,'synthetic-'+k]),...s.binary.map(k=>[k,Buffer.from([0,1,2])])]);}
function registry(){let live=true;const anchor={v:1,...scope,authorityId:'synthetic-authority',keyId,epoch:1,forgetSequence:0,forgetMac:'0'.repeat(64)},r=createEncryptedRunAdmissionRegistry({...scope,profileId:'synthetic-profile',captureAuthority:async()=>({anchor,isCurrent:()=>live}),captureProfile:async()=>({profileId:'synthetic-profile',storageId:'synthetic-storage',isCurrent:()=>live})});return{r,revoke(){live=false;}};}
test('v1 unknown remains unknown; authenticated v2 origin survives spread, copy and key rotation without fresh origin',async()=>{
 const key=randomBytes(32),nextKey=randomBytes(32),verificationKey=randomBytes(32),{r}=registry();
 try{const lease=await r.admitRun({runId:'synthetic-run',ownerId:scope.ownerId,agentId:'synthetic-agent',kind:'task',unknownSources:[]});await lease.run(async()=>{
  const admission=captureEncryptedRunWriteAdmission(scope.ownerId,'synthetic-agent');assert.ok(admission);
  for(const table of ['memories','agent_handoffs','memory_pinned_facts','memory_open_questions','memory_import_batches']){
   const row=plain(table),field=memoryRowSurfaceManifest().find(s=>s.table===table).text[0];
   const old=decryptMemoryRow(table,encryptMemoryRow(table,row,scope,key,keyId),scope,key,keyId);assert.equal(encryptedFieldProducer(table,old,field,scope),null);
   const tagged=attachEncryptedRunProducer(table,row,scope,admission),cipher=encryptMemoryRow(table,tagged,scope,key,keyId),decoded=decryptMemoryRow(table,cipher,scope,key,keyId),origin=encryptedFieldProducer(table,decoded,field,scope);assert.equal(origin.runId,'synthetic-run');
   const batch=prepareMemoryCopyBatch(table,[{...decoded}],scope,nextKey,'rotated-key',verificationKey);verifyMemoryCopyBatch(batch,batch.rows,scope,nextKey,'rotated-key',verificationKey);
   const rotated=decryptMemoryRow(table,batch.rows[0],scope,nextKey,'rotated-key');assert.deepEqual(encryptedFieldProducer(table,rotated,field,scope),origin);assert.equal(origin.keyId,keyId);
   const changed={...decoded,[field]:'new unknown content'};assert.equal(encryptedFieldProducer(table,changed,field,scope),null);const resealed=decryptMemoryRow(table,encryptMemoryRow(table,changed,scope,key,keyId),scope,key,keyId);assert.equal(encryptedFieldProducer(table,resealed,field,scope),null);
  }
 });}finally{r.close();key.fill(0);nextKey.fill(0);verificationKey.fill(0);}
});
test('caller-shaped admissions and tainted runs cannot mint field provenance',async()=>{
 const {r}=registry();try{assert.throws(()=>attachEncryptedRunProducer('memories',plain('memories'),scope,{ownerId:scope.ownerId,memberId:scope.memberId,isCurrent:()=>true}));const lease=await r.admitRun({runId:'tainted-run',ownerId:scope.ownerId,agentId:'synthetic-agent',kind:'chat',unknownSources:['unverified-chat-history']});await lease.run(async()=>assert.equal(captureEncryptedRunWriteAdmission(scope.ownerId,'synthetic-agent'),null));}finally{r.close();}
});

test('known memory lineage sources stay authenticated across rotation, never from raw metadata or changed source IDs',async()=>{
 const {stampEncryptedRunLineage,observeEncryptedRunContextSources}=await import('../src/memory/encryption/run-admission.ts'),{verifiedEncryptedMemoryLineageSources}=await import('../src/memory/encryption/memory-lineage.ts');
 const key=randomBytes(32),rotatedKey=randomBytes(32),verificationKey=randomBytes(32),{r}=registry();
 try{const lease=await r.admitRun({runId:'lineage-run',ownerId:scope.ownerId,agentId:'synthetic-agent',kind:'task',unknownSources:[]});await lease.run(async()=>{
  observeEncryptedRunContextSources([{kind:'memory',id:'synthetic-source-memory'}]);const admission=captureEncryptedRunWriteAdmission(scope.ownerId,'synthetic-agent');assert.ok(admission);
  const row=plain('memories');row.metadata=null;row.metadata=stampEncryptedRunLineage(row,admission,key);const tagged=attachEncryptedRunProducer('memories',row,scope,admission),cipher=encryptMemoryRow('memories',tagged,scope,key,keyId),decoded=decryptMemoryRow('memories',cipher,scope,key,keyId);
  const expected=[{kind:'memory',id:'synthetic-source-memory'}];assert.deepEqual(verifiedEncryptedMemoryLineageSources(decoded,scope,key),expected);
  const batch=prepareMemoryCopyBatch('memories',[decoded],scope,rotatedKey,'rotated-key',verificationKey),rotated=decryptMemoryRow('memories',batch.rows[0],scope,rotatedKey,'rotated-key');assert.deepEqual(verifiedEncryptedMemoryLineageSources(rotated,scope,rotatedKey),expected);
  const forged=JSON.parse(rotated.metadata);forged.__girru_run_lineage_v1.sources=[{kind:'memory',id:'unrelated-memory'}];assert.equal(verifiedEncryptedMemoryLineageSources({...rotated,metadata:JSON.stringify(forged)},scope,rotatedKey),null);
  assert.equal(verifiedEncryptedMemoryLineageSources({...rotated,content:'Changed content'},scope,rotatedKey),null);
  // Serialization of plaintext drops private AEAD proof. An old data-key MAC is not guessed.
  const lost=Object.fromEntries(Object.entries(rotated));assert.equal(verifiedEncryptedMemoryLineageSources(lost,scope,rotatedKey),null);
 });}finally{r.close();key.fill(0);rotatedKey.fill(0);verificationKey.fill(0);}
});

test('field-only decoding opens an authenticated scope header before unrelated question text',async()=>{
 const {decryptMemoryRowField}=await import('../src/memory/encryption/row-codec.ts'),key=randomBytes(32);try{const row=plain('memory_open_questions');row.question_hash=JSON.stringify({v:2,scope:{kind:'project',key:'synthetic-project'},hash:'a'.repeat(64)});const cipher=encryptMemoryRow('memory_open_questions',row,scope,key,keyId),hidden={...cipher,question:'SYNTHETIC_INVALID_UNOPENED_CONTENT'};assert.equal(decryptMemoryRowField('memory_open_questions',hidden,'question_hash',scope,key,keyId).value,row.question_hash);assert.throws(()=>decryptMemoryRow('memory_open_questions',hidden,scope,key,keyId));assert.throws(()=>decryptMemoryRowField('memory_open_questions',hidden,'agent_id',scope,key,keyId));assert.throws(()=>decryptMemoryRowField('memory_open_questions',{...hidden,id:'swapped-id'},'question_hash',scope,key,keyId));}finally{key.fill(0);}
});

test('question scope headers deny other agents, hidden drawers, stale heads and unbound text before consumption',async()=>{
 const {prepareEncryptedQuestionScope,authorizedEncryptedQuestionHeader,verifiedEncryptedQuestionText}=await import('../src/memory/encryption/question-scope.ts'),{decryptMemoryRowField}=await import('../src/memory/encryption/row-codec.ts'),key=randomBytes(32),{r}=registry();
 try{const lease=await r.admitRun({runId:'question-run',ownerId:scope.ownerId,agentId:'synthetic-agent',kind:'chat',unknownSources:[]});await lease.run(async()=>{
  const admission=captureEncryptedRunWriteAdmission(scope.ownerId,'synthetic-agent'),row=plain('memory_open_questions'),drawers=[{kind:'project',key:'project-a'},{kind:'project',key:'project-b'}];row.agent_id='synthetic-agent';row.question='Synthetic owner question?';row.question_hash=prepareEncryptedQuestionScope(row.question,drawers,admission);const cipher=encryptMemoryRow('memory_open_questions',attachEncryptedRunProducer('memory_open_questions',row,scope,admission),scope,key,keyId),header=decryptMemoryRowField('memory_open_questions',cipher,'question_hash',scope,key,keyId),text=decryptMemoryRowField('memory_open_questions',cipher,'question',scope,key,keyId),input={...scope,agentId:'synthetic-agent',rowAgentId:'synthetic-agent',drawers,anchor:admission.anchor};
  assert.equal(authorizedEncryptedQuestionHeader(header,input),true);assert.equal(verifiedEncryptedQuestionText(header,text),row.question);assert.equal(authorizedEncryptedQuestionHeader(header,{...input,drawers:[drawers[0]]}),false);assert.equal(authorizedEncryptedQuestionHeader(header,{...input,agentId:'other-agent'}),false);assert.equal(authorizedEncryptedQuestionHeader(header,{...input,anchor:{...input.anchor,forgetSequence:1,forgetMac:'1'.repeat(64)}}),false);assert.throws(()=>verifiedEncryptedQuestionText(header,{...text,value:'Changed question'}));assert.throws(()=>verifiedEncryptedQuestionText(header,{...text,producer:null}));assert.equal(authorizedEncryptedQuestionHeader({value:'legacy-hash',producer:null},input),false);
 });}finally{r.close();key.fill(0);}
});
