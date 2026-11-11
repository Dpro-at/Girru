// Deferred source fixtures: no execution before whole-task source completion.
import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
import {encryptedGraphReview,reviewedEncryptedGraphMetadata,recallReviewedEncryptedGraph} from '../src/memory/encryption/graph-projection.ts';
const key=randomBytes(32),row={id:'synthetic-memory',user_id:'synthetic-owner',content:'Alice works on Project Atlas.',metadata:null,drawer_kind:'owner',drawer_key:'',type:'fact',status:'active',created_at:new Date(0).toISOString(),importance_score:0.5};
test('only explicitly reviewed signed graph metadata participates in encrypted graph recall',()=>{
 assert.deepEqual(recallReviewedEncryptedGraph([row],key,'Alice'),[]);const preview=encryptedGraphReview(row,key);assert.ok(preview.entities.length>0);
 const approved={...row,metadata:reviewedEncryptedGraphMetadata(row,key,preview.reviewHash,'approve')};
 assert.ok(recallReviewedEncryptedGraph([approved],key,preview.entities[0].name).some(hit=>hit.memory.id===row.id));
 const rejected={...approved,metadata:reviewedEncryptedGraphMetadata(approved,key,encryptedGraphReview(approved,key).reviewHash,'reject')};assert.deepEqual(recallReviewedEncryptedGraph([rejected],key,'Alice'),[]);
 assert.deepEqual(recallReviewedEncryptedGraph([{...approved,content:'A different synthetic note.'}],key,'Alice'),[]);
});
test('graph review refuses stale sources and signed projections cannot move between records or keys',()=>{
 const preview=encryptedGraphReview(row,key);assert.throws(()=>reviewedEncryptedGraphMetadata({...row,content:'Changed'},key,preview.reviewHash,'approve'));
 const approved={...row,metadata:reviewedEncryptedGraphMetadata(row,key,preview.reviewHash,'approve')};
 assert.throws(()=>recallReviewedEncryptedGraph([{...approved,id:'other-memory'}],key,'Alice'));
 assert.throws(()=>recallReviewedEncryptedGraph([approved],randomBytes(32),'Alice'));
 const modified=JSON.parse(approved.metadata);modified.__girru_reviewed_graph_v1.extraction.links.push({from:'Alice',type:'depends_on',to:'Invented'});assert.throws(()=>recallReviewedEncryptedGraph([{...approved,metadata:JSON.stringify(modified)}],key,'Alice'));
});
