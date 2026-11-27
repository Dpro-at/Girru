require('./load.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {SessionClient}=require('../src/session.ts'),{LegalConsent}=require('../src/LegalConsent.tsx');
const {canAgreeToPolicy,parseLegalPolicy}=require('../src/legal-policy-contract.js');
const {legalFixture}=require('../../backend/test/helpers/legal-policy-fixture.mjs');
const legal=legalFixture();
// The consent gate only appears for a new owner (setup); these fixtures run in setup mode. SETUP carries the owner-creation input.
const SETUP={setupToken:'s'.repeat(43),name:'Temporary owner',workspaceType:'individual'};
function fixture(policyResponse={status:200,body:legal.policy}){const calls=[];const transport=async request=>{calls.push(request);if(request.path==='/api/setup/status')return {status:200,body:{setupRequired:true,setupComplete:false,message:'Setup required'}};if(request.path==='/api/auth/google/policy')return typeof policyResponse==='function'?policyResponse():policyResponse;if(request.path==='/api/auth/google/start')return {status:409,body:{code:'google_policy_changed'}};return {status:200,body:{cancelled:true}};};return {calls,client:new SessionClient({live:transport})};}
test('scrolling and checkbox are jointly required; policy errors cannot enable agreement',()=>{
 for(const [read,checked,busy,result]of [[false,false,false,false],[true,false,false,false],[false,true,false,false],[true,true,true,false],[true,true,false,true]])assert.equal(canAgreeToPolicy(read,checked,busy),result);
 assert.throws(()=>parseLegalPolicy({...legal.policy,version:''}));assert.throws(()=>parseLegalPolicy({...legal.policy,privacyUrl:'https://example.com/'}));
 const html=renderToStaticMarkup(React.createElement(LegalConsent,{state:{status:'ready',policy:legal.policy},onAgree(){},onCancel(){},onRetry(){}}));assert.match(html,/role="region"/);assert.match(html,/tabindex="0"/);assert.match(html,/disabled=""[^>]*>Agree and continue/);assert.match(html,/I have read and agree/);
});
test('new-owner setup shows consent and loading text never starts Google; cancellation returns without an OAuth call',async()=>{
 const {client,calls}=fixture();client.selectMode('live');await client.discoverSetup();await client.loginGoogle(SETUP);assert.equal(client.getSnapshot().legalConsent.status,'ready');assert.equal(calls.some(r=>r.path.endsWith('/start')),false);client.cancelLegalConsent();assert.equal(client.getSnapshot().legalConsent,undefined);assert.equal(client.getSnapshot().setup,'required');assert.equal(calls.some(r=>r.path.endsWith('/start')),false);
});
test('a returning sign-in shows no consent gate and sends no acceptance',async()=>{
 const calls=[];const transport=async request=>{calls.push(request);if(request.path==='/api/setup/status')return {status:200,body:{setupRequired:false,setupComplete:true,message:'Setup already completed'}};if(request.path==='/api/auth/google/policy')return {status:200,body:legal.policy};if(request.path==='/api/auth/google/start')return {status:200,body:{flowId:'f'}};if(request.path==='/api/auth/google/status')return {status:200,body:{state:'ready'}};if(request.path==='/api/auth/google/finish')return {status:200,body:{user:{id:'u',email:'e@example.test',username:'U',role:'owner'},token:'t',deviceToken:'d'.repeat(43)}};if(request.path==='/api/auth/me')return {status:200,body:{user:{id:'u',email:'e@example.test',username:'U',role:'owner'}}};return {status:200,body:{}};};
 const client=new SessionClient({live:transport});client.selectMode('live');await client.discoverSetup();await client.loginGoogle();
 assert.equal(client.getSnapshot().phase,'authenticated');assert.equal(client.getSnapshot().legalConsent,undefined);assert.equal(calls.some(r=>r.path.endsWith('/policy')),false);assert.equal(calls.find(r=>r.path.endsWith('/start')).body.legalAcceptance,undefined);
});
test('load failure and late completion after cancellation remain closed',async()=>{
 const failed=fixture({status:503,body:{code:'google_policy_unavailable'}});failed.client.selectMode('live');await failed.client.discoverSetup();await failed.client.loginGoogle(SETUP);assert.equal(failed.client.getSnapshot().legalConsent.status,'failed');await failed.client.acceptLegalConsent();assert.equal(failed.calls.some(r=>r.path.endsWith('/start')),false);
 let resolve;const delayed=fixture(()=>new Promise(done=>{resolve=done;}));delayed.client.selectMode('live');await delayed.client.discoverSetup();const loading=delayed.client.loginGoogle(SETUP);await new Promise(r=>setImmediate(r));delayed.client.cancelLegalConsent();resolve({status:200,body:legal.policy});await loading;assert.equal(delayed.client.getSnapshot().legalConsent,undefined);assert.equal(delayed.calls.some(r=>r.path.endsWith('/start')),false);
});
test('only explicit agreement sends the displayed version and hash, and changed policy refuses sign-in',async()=>{
 const {client,calls}=fixture();client.selectMode('live');await client.discoverSetup();await client.loginGoogle(SETUP);await client.acceptLegalConsent();const start=calls.find(r=>r.path.endsWith('/start'));assert.deepEqual(start.body.legalAcceptance,legal.acceptance);assert.equal(client.getSnapshot().phase,'signed-out');assert.equal(client.getSnapshot().user,undefined);
});
