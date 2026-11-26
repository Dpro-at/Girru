require('./load.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {SessionClient}=require('../src/session.ts'),{LegalConsent}=require('../src/LegalConsent.tsx');
const {canAgreeToPolicy,parseLegalPolicy}=require('../src/legal-policy-contract.js');
const {legalFixture}=require('../../backend/test/helpers/legal-policy-fixture.mjs');
const legal=legalFixture();
function fixture(policyResponse={status:200,body:legal.policy}){const calls=[];const transport=async request=>{calls.push(request);if(request.path==='/api/setup/status')return {status:200,body:{setupRequired:false,setupComplete:true,message:'Setup already completed'}};if(request.path==='/api/auth/google/policy')return typeof policyResponse==='function'?policyResponse():policyResponse;if(request.path==='/api/auth/google/start')return {status:409,body:{code:'google_policy_changed'}};return {status:200,body:{cancelled:true}};};return {calls,client:new SessionClient({live:transport})};}
test('scrolling and checkbox are jointly required; policy errors cannot enable agreement',()=>{
 for(const [read,checked,busy,result]of [[false,false,false,false],[true,false,false,false],[false,true,false,false],[true,true,true,false],[true,true,false,true]])assert.equal(canAgreeToPolicy(read,checked,busy),result);
 assert.throws(()=>parseLegalPolicy({...legal.policy,version:''}));assert.throws(()=>parseLegalPolicy({...legal.policy,privacyUrl:'https://example.com/'}));
 const html=renderToStaticMarkup(React.createElement(LegalConsent,{state:{status:'ready',policy:legal.policy},onAgree(){},onCancel(){},onRetry(){}}));assert.match(html,/role="region"/);assert.match(html,/tabindex="0"/);assert.match(html,/disabled=""[^>]*>Agree and continue/);assert.match(html,/I have read and agree/);
});
test('loading/current text never starts Google; cancellation returns without an OAuth call',async()=>{
 const {client,calls}=fixture();client.selectMode('live');await client.discoverSetup();await client.loginGoogle();assert.equal(client.getSnapshot().legalConsent.status,'ready');assert.equal(calls.some(r=>r.path.endsWith('/start')),false);client.cancelLegalConsent();assert.equal(client.getSnapshot().legalConsent,undefined);assert.equal(client.getSnapshot().setup,'login');assert.equal(calls.some(r=>r.path.endsWith('/start')),false);
});
test('load failure and late completion after cancellation remain closed',async()=>{
 const failed=fixture({status:503,body:{code:'google_policy_unavailable'}});failed.client.selectMode('live');await failed.client.discoverSetup();await failed.client.loginGoogle();assert.equal(failed.client.getSnapshot().legalConsent.status,'failed');await failed.client.acceptLegalConsent();assert.equal(failed.calls.some(r=>r.path.endsWith('/start')),false);
 let resolve;const delayed=fixture(()=>new Promise(done=>{resolve=done;}));delayed.client.selectMode('live');await delayed.client.discoverSetup();const loading=delayed.client.loginGoogle();await new Promise(r=>setImmediate(r));delayed.client.cancelLegalConsent();resolve({status:200,body:legal.policy});await loading;assert.equal(delayed.client.getSnapshot().legalConsent,undefined);assert.equal(delayed.calls.some(r=>r.path.endsWith('/start')),false);
});
test('only explicit agreement sends the displayed version and hash, and changed policy refuses sign-in',async()=>{
 const {client,calls}=fixture();client.selectMode('live');await client.discoverSetup();await client.loginGoogle();await client.acceptLegalConsent();const start=calls.find(r=>r.path.endsWith('/start'));assert.deepEqual(start.body.legalAcceptance,legal.acceptance);assert.equal(client.getSnapshot().phase,'signed-out');assert.equal(client.getSnapshot().user,undefined);
});
