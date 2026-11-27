import test from 'node:test';import assert from 'node:assert/strict';
import {PublishedLegalPolicies} from '../src/auth/legal-policy.ts';
import {legalFixture} from './helpers/legal-policy-fixture.mjs';
test('published approved text is hash-verified; explicit acceptance is server-timestamped',async()=>{
 const f=legalFixture(),policies=new PublishedLegalPolicies(f.fetcher);const policy=await policies.load();assert.equal(policy.contentSha256,f.acceptance.contentSha256);const receipt=await policies.accept(f.acceptance);assert.equal(receipt.version,'test.1');assert.ok(Number.isFinite(Date.parse(receipt.acceptedAt)));assert.equal('documents' in receipt,false);
 for(const acceptance of [undefined,{...f.acceptance,accepted:false},{...f.acceptance,version:'old'},{...f.acceptance,extra:true}])await assert.rejects(policies.accept(acceptance));
});
test('draft, future, tampered, changed-version and foreign-URL policies fail closed',async()=>{
 for(const mutate of [f=>{f.manifest.status='draft';},f=>{f.manifest.effectiveAt='2999-01-01';},f=>{f.content.documents.terms.sections[0].paragraphs[0]='Changed';},f=>{f.content.version='old';},f=>{f.manifest.contentUrl='https://example.com/policy';}]){const f=legalFixture();mutate(f);await assert.rejects(new PublishedLegalPolicies(f.fetcher).load());}
});
test('publication change during load, non-JSON and unavailable sources are refused without a cache fallback',async()=>{
 const f=legalFixture();let manifestReads=0;
 await assert.rejects(new PublishedLegalPolicies(async url=>{if(url.endsWith('/policy.json')&&++manifestReads>1)return new Response(JSON.stringify({...f.manifest,version:'new'}),{headers:{'Content-Type':'application/json'}});return f.fetcher(url);}).load());
 for(const response of [new Response('Unavailable',{status:503}),new Response('{}',{headers:{'Content-Type':'text/html'}})])await assert.rejects(new PublishedLegalPolicies(async()=>response.clone()).load());
});
