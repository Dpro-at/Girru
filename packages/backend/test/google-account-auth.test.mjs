import {legalFixture} from './helpers/legal-policy-fixture.mjs';
import {PublishedLegalPolicies} from '../src/auth/legal-policy.ts';
process.env.NODE_ENV='test';
// Native broker is explicitly stubbed; local SQL/auth/session policies remain real.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes} from 'node:crypto';
const root=realpathSync(mkdtempSync(join(tmpdir(),'google-account-fixture-')));process.env.HOME=root;process.env.AGENT_PLAYER_DATA_DIR=join(root,'data');process.env.AGENT_PLAYER_CONFIG_DIR=join(root,'config');process.env.DATABASE_PATH=join(root,'app.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
const {GoogleAccountProvider}=await import('../src/auth/google-proof.ts'),{GoogleAccountFlows}=await import('../src/auth/google-account-flows.ts'),{googleAuthRoutes}=await import('../src/api/routes/google-auth.ts'),{registerAuthGate}=await import('../src/auth/auth-gate.ts'),{issueSetupToken}=await import('../src/auth/setup-token.ts'),{default:Fastify}=await import('fastify');
let resolveConsent,subject='123456789',email='google-owner@example.test';const channel={request:async(op)=>{if(op==='auth-cancel'){resolveConsent?.(null);return {cancelled:true};}assert.equal(op,'auth-login');return new Promise(resolve=>{resolveConsent=()=>resolve({issuer:'https://accounts.google.com',subject,email,emailVerified:true,verifiedAt:Date.now(),expiresAt:Date.now()+300000});});}};
const legal=legalFixture();
const flows=new GoogleAccountFlows(new GoogleAccountProvider(channel,{localFixtureOnly:true})),app=Fastify();registerAuthGate(app);await app.register(googleAuthRoutes,{flows,policies:new PublishedLegalPolicies(legal.fetcher)});await app.ready();
const call=(op,body,headers={})=>app.inject({method:'POST',url:'/api/auth/google/'+op,payload:body,headers});const nonce=()=>randomBytes(32).toString('base64url');
async function begin(kind='signin',extra={},headers={}){const clientNonce=nonce(),r=await call((headers.authorization?'link/':'')+'start',{clientNonce,...(headers.authorization?{}:{kind,legalAcceptance:legal.acceptance}),...extra},headers);assert.equal(r.statusCode,200,r.body);return {flowId:r.json().flowId,clientNonce};}
async function consent(){resolveConsent();await new Promise(resolve=>setImmediate(resolve));}
test.after(async()=>{await app.close();await (await import('../src/onboarding/discovery.ts')).stopFirstRunDiscovery();await (await import('../src/services/discovery-fs.ts')).discoveryFs.close();closeDatabase();});
let ownerToken;
test('primary Google cannot start before explicit current-policy acceptance',async()=>{
 const token=issueSetupToken();
 for(const legalAcceptance of [undefined,{...legal.acceptance,accepted:false},{...legal.acceptance,version:'old'}]){const r=await call('start',{kind:'setup',clientNonce:nonce(),setupToken:token,legalAcceptance});assert.notEqual(r.statusCode,200);}
 assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE role='owner'").get().n,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM user_legal_acceptances').get().n,0);
 const response=await app.inject({method:'GET',url:'/api/auth/google/policy'});assert.equal(response.statusCode,200);assert.equal(response.json().version,legal.acceptance.version);
});

test('unified welcome requires confirmation after a verified new identity', async () => {
  const setupToken=issueSetupToken(), flow=await begin('setup',{setupToken,unifiedWelcome:true});
  await consent();
  const status=await call('status',flow);
  assert.equal(status.json().requiresAccountCreation,true);
  const denied=await call('finish',{...flow,setupToken});
  assert.equal(denied.json().code,'google_setup_confirmation_required');
  assert.equal(db.prepare('SELECT id FROM users WHERE email=?').get(email),undefined);
  await call('cancel',flow);
});

test('first-run Google signup is asynchronous and one-use setup-bound, session recorded before token returned',async()=>{const setupToken=issueSetupToken(),f=await begin('setup',{name:'Disposable owner',setupToken,workspaceType:'individual',unifiedWelcome:true});let r=await call('status',f);assert.equal(r.json().state,'waiting');assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE role='owner'").get().n,0);await consent();assert.equal((await call('status',f)).json().state,'ready');r=await call('finish',{...f,setupToken,confirmAccountCreation:true});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().user.role,'owner');assert.equal(db.prepare('SELECT COUNT(*) n FROM user_legal_acceptances WHERE user_id=?').get(r.json().user.id).n,1);ownerToken=r.json().token;assert.equal(db.prepare('SELECT COUNT(*) n FROM user_identity_providers').get().n,1);assert.ok(db.prepare('SELECT COUNT(*) n FROM auth_sessions').get().n>=1);assert.notEqual((await call('finish',{...f,setupToken})).statusCode,200);assert.notEqual((await call('start',{kind:'setup',name:'Other',clientNonce:nonce(),setupToken})).statusCode,200);});
test('canonical issuer/sub signs in; another Google identity with same email never merges',async()=>{let f=await begin();await consent();let r=await call('finish',f);assert.equal(r.statusCode,200,r.body);assert.ok(r.json().token);subject='999999999';f=await begin();await consent();r=await call('finish',f);assert.notEqual(r.statusCode,200);assert.equal(db.prepare('SELECT COUNT(*) n FROM user_identity_providers').get().n,1);subject='123456789';});
test('flow nonce, cancellation and private/public operation boundaries fail closed',async()=>{const f=await begin();assert.notEqual((await call('status',{...f,clientNonce:nonce()})).statusCode,200);assert.equal((await call('cancel',f)).statusCode,200);assert.notEqual((await call('finish',f)).statusCode,200);const other=await begin();await consent();assert.notEqual((await call('link/finish',other,{authorization:'Bearer '+ownerToken})).statusCode,200);assert.equal((await call('finish',{...other,idToken:'attacker'})).statusCode,409);});
test('linking a current session still requires fresh local password; email collision grants nothing',async()=>{const {default:bcrypt}=await import('bcryptjs');const password='Temporary-local-password-728!';db.prepare('UPDATE users SET password_hash=? WHERE role=?').run(await bcrypt.hash(password,4),'owner');const headers={authorization:'Bearer '+ownerToken};subject='555555555';email='different-google@example.test';let f=await begin('link',{},headers);await consent();let r=await call('link/finish',f,headers);assert.notEqual(r.statusCode,200);assert.equal(db.prepare('SELECT COUNT(*) n FROM user_identity_providers').get().n,1);f=await begin('link',{},headers);await consent();r=await call('link/finish',{...f,password:'wrong'},headers);assert.notEqual(r.json().linked,true);assert.equal(db.prepare('SELECT COUNT(*) n FROM user_identity_providers').get().n,1);});

test('session persistence failure returns no JWT; a fresh flow reads the current mapping version',async()=>{subject='123456789';email='google-owner@example.test';let f=await begin();await consent();db.exec("CREATE TRIGGER fixture_session_failure BEFORE INSERT ON auth_sessions BEGIN SELECT RAISE(ABORT,'temporary session failure'); END");try{const r=await call('finish',f);assert.equal(r.statusCode,503);assert.equal(r.json().token,undefined);}finally{db.exec('DROP TRIGGER fixture_session_failure');}f=await begin();await consent();db.prepare('UPDATE user_identity_providers SET mapping_version=mapping_version+1').run();const r=await call('finish',f);assert.equal(r.statusCode,200,r.body);assert.ok(r.json().token);});

test('cancel before the start response leaves a bounded nonce tombstone and starts no consent later',async()=>{const clientNonce=nonce();assert.equal((await call('cancel',{clientNonce})).statusCode,200);const r=await call('start',{kind:'signin',clientNonce,legalAcceptance:legal.acceptance});assert.notEqual(r.statusCode,200);assert.equal(r.json().code,'google_flow_cancelled');});

test('acceptance persistence failure never returns a sign-in token',async()=>{subject='123456789';email='google-owner@example.test';const flow=await begin();await consent();db.exec("CREATE TRIGGER fixture_legal_failure BEFORE INSERT ON user_legal_acceptances BEGIN SELECT RAISE(ABORT,'temporary receipt failure'); END");try{const response=await call('finish',flow);assert.equal(response.statusCode,503);assert.equal(response.json().token,undefined);}finally{db.exec('DROP TRIGGER fixture_legal_failure');}});
