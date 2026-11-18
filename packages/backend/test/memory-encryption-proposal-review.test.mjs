import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
import {memoryRowSurfaceManifest,encryptMemoryRow} from '../src/memory/encryption/row-codec.ts';import {proposalReviewHash} from '../src/memory/memory-files.ts';import {validateEncryptedSupersessionReview} from '../src/memory/encryption/proposal-review.ts';import {MemoryCipherError} from '../src/memory/encryption/envelope.ts';
const scope={ownerId:'review-owner',memberId:'review-member'},key=randomBytes(32),keyId='review-key';
function plain(table,id){const s=memoryRowSurfaceManifest().find(s=>s.table===table);return Object.fromEntries([[s.owner,scope.ownerId],[s.id,id],...s.bound.map(f=>[f,null]),...s.clear.map(f=>[f,0]),...s.text.map(f=>[f,null]),...s.binary.map(f=>[f,null])]);}
const older={...plain('memories','older'),type:'fact',content:'old reviewed content',importance_score:0.5,status:'active',drawer_kind:'project',drawer_key:'review-project',topic_key:'review-topic'},newer={...older,id:'newer',content:'new reviewed content'};
const changes=[{op:'update',id:'older',before:{type:'fact',importance:5,content:older.content},after:{type:'fact',importance:5,content:newer.content}}];
const proposal={...plain('memory_file_proposals','proposal-a'),status:'pending',source:'agent',drawer_kind:'project',drawer_key:'review-project',base_revision:0,base_hash:'synthetic-base',changes:JSON.stringify(changes),conflict_with:'older',decision:null};
const hash=proposalReviewHash({id:proposal.id,drawerId:'project:review-project',baseRevision:0,baseHash:proposal.base_hash,source:'agent',changes});
function validate(p=proposal,old=older,next=newer,h=hash){return validateEncryptedSupersessionReview(encryptMemoryRow('memory_file_proposals',p,scope,key,keyId),encryptMemoryRow('memories',old,scope,key,keyId),encryptMemoryRow('memories',next,scope,key,keyId),scope,key,keyId,h);}
test('the existing review hash binds authenticated proposal before/after text and topic to the exact supersession',()=>{assert.doesNotThrow(()=>validate());});
test('changed/replayed/mixed/file proposals and unreviewed replacement text or topic are refused',()=>{
 for(const p of [{...proposal,status:'approved'},{...proposal,conflict_with:'other'},{...proposal,source:'file'},{...proposal,changes:JSON.stringify([...changes,...changes])},{...proposal,base_revision:1}])assert.throws(()=>validate(p),MemoryCipherError);
 assert.throws(()=>validate(proposal,{...older,content:'changed meanwhile'}),MemoryCipherError);assert.throws(()=>validate(proposal,older,{...newer,content:'unreviewed'}),MemoryCipherError);assert.throws(()=>validate(proposal,older,{...newer,topic_key:'unreviewed-topic'}),MemoryCipherError);assert.throws(()=>validate(proposal,older,newer,'0'.repeat(64)),MemoryCipherError);
});
const {buildEncryptedReviewedReplacement}=await import('../src/memory/encryption/reviewed-replacement.ts');
const {decryptMemoryRow}=await import('../src/memory/encryption/row-codec.ts');
test('reviewed replacement uses existing memory/provenance factories and server-owned identity/defaults',()=>{
 const oldCipher=encryptMemoryRow('memories',{...older,visibility:'team',quality_score:99,tags:'["old-private-tag"]',context:'old private context'},scope,key,keyId),p=encryptMemoryRow('memory_file_proposals',{...proposal,created_by:'agent:review-agent'},scope,key,keyId);
 const replacement=buildEncryptedReviewedReplacement(p,oldCipher,scope,key,keyId,hash),plainNew=decryptMemoryRow('memories',replacement,scope,key,keyId);
 assert.notEqual(plainNew.id,older.id);assert.equal(plainNew.content,newer.content);assert.equal(plainNew.visibility,'private');assert.equal(plainNew.quality_score,50);assert.equal(plainNew.tags,null);assert.equal(plainNew.context,null);assert.equal(plainNew.embedding,null);assert.equal(plainNew.embedding_vec,null);assert.equal(plainNew.source,'agent');assert.equal(plainNew.source_agent_id,'review-agent');assert.equal(plainNew.trust,'checked');assert.deepEqual(JSON.parse(plainNew.metadata),{source:'agent',proposalId:proposal.id,supersedes:older.id});
 assert.ok(!JSON.stringify(replacement).includes(newer.content));validateEncryptedSupersessionReview(p,oldCipher,replacement,scope,key,keyId,hash);
});
test('server builder refuses an unreviewed change and does not accept a caller-supplied replacement identity',()=>{
 const p=encryptMemoryRow('memory_file_proposals',proposal,scope,key,keyId),old=encryptMemoryRow('memories',older,scope,key,keyId);
 assert.throws(()=>buildEncryptedReviewedReplacement(p,old,scope,key,keyId,'0'.repeat(64)),MemoryCipherError);
 const a=decryptMemoryRow('memories',buildEncryptedReviewedReplacement(p,old,scope,key,keyId,hash),scope,key,keyId),b=decryptMemoryRow('memories',buildEncryptedReviewedReplacement(p,old,scope,key,keyId,hash),scope,key,keyId);assert.notEqual(a.id,b.id);
});
