require('./load.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {AppSettings}=require('../src/AppSettings.tsx');
const {accountSettingsResponse,allowedAccountSettings}=require('../src/account-settings-contract.js');
const {verificationResponse,allowedVerification}=require('../src/verification-contract.js');
function fake(role){const state={calls:0};return {state,client:{getSnapshot:()=>({phase:'authenticated',mode:'live',user:{role,email:'f@example.invalid',username:'Fiction'}}),subscribe:()=>()=>{},request:async()=>{state.calls++;throw Error('Unexpected render-time request');}}};}
const page=(role,initialTab,extra={})=>{const {client,state}=fake(role);const html=renderToStaticMarkup(React.createElement(AppSettings,{signedIn:true,preference:'system',onTheme(){},onAccount(){},client,initialTab,onOpenApps(){},onOpenTool(){},...extra}));return {html,state};};
test('old section names still open their places (models, sharing)',()=>{
 assert.match(page('owner','models').html,/Primary reply engine[\s\S]*Cloud coding apps[\s\S]*Local models/);
 assert.match(page('owner','sharing').html,/Keys, accounts, conversations, memories and private project files are excluded/);
});
test('Account keeps the old role help and device line; it lists devices and two-step without render-time requests',()=>{
 const {html,state}=page('owner','account');
 assert.match(html,/Full control: hires agents, sets their permissions and approves memory changes\./);
 assert.match(html,/the sign-in is not stored on disk/);assert.match(html,/Two-step sign-in/);assert.match(html,/Checking verification…/);
 assert.match(html,/Sign out everywhere…/);assert.match(html,/Looking for your other devices…/);assert.equal(state.calls,0);
 assert.match(page('user','account').html,/Works with the agents; cannot change the team\./);
});
test('Models and replies keeps primary selection in one place and separates local providers',()=>{
 const {html}=page('owner','replies',{onOpenChat(){}});
 assert.match(html,/Primary reply engine/);assert.match(html,/Cloud coding apps/);assert.match(html,/Local models/);assert.match(html,/aria-label="Refresh reply engines"/);assert.match(html,/aria-label="Local model provider"/);assert.match(html,/Ollama/);assert.match(html,/LM Studio/);assert.match(html,/Google Gemini/);assert.doesNotMatch(html,/Use as primary|Per-agent overrides|>Open Chat</);assert.doesNotMatch(html,/setup-terminal/);
});
test('Permissions shows the grid of all agents and one agent\'s tools and memory',()=>{
 const {html}=page('owner','permissions');assert.match(html,/aria-label="What agents may do"/);assert.match(html,/One agent's tools and memory|One agent&#x27;s tools and memory/);assert.match(html,/aria-label="Permission views"/);assert.doesNotMatch(html,/>Actions</);
});
test('About: the owner gets the update check, others keep the old manual-updates row',()=>{
 assert.match(page('owner','about').html,/Looking at this copy…/);
 assert.match(page('user','about').html,/Automatic updates are not available in this build/);
});
test('contracts: devices, sign-out of one device and updates pass only known fields',()=>{
 assert.equal(allowedAccountSettings('GET','/api/auth/sessions'),true);assert.equal(allowedAccountSettings('POST','/api/auth/sessions/'+'a'.repeat(24)+'/sign-out'),true);
 assert.equal(allowedAccountSettings('POST','/api/auth/sessions/'+'a'.repeat(24)+'/sign-out',{}),false);assert.equal(allowedAccountSettings('POST','/api/auth/sessions/xyz/sign-out'),false);assert.equal(allowedAccountSettings('GET','/api/system/updates/check'),false);
 const s=accountSettingsResponse('/api/auth/sessions',200,{sessions:[{id:'b'.repeat(24),label:'Chrome on Mac',createdAt:1,lastSeenAt:2,current:true,token_hash:'secret'}]});
 assert.deepEqual(s,{sessions:[{id:'b'.repeat(24),label:'Chrome on Mac',createdAt:1,lastSeenAt:2,current:true}]});
 const u=accountSettingsResponse('/api/system/updates',200,{kind:'git',version:'1.3.0',branch:'main',follows:'origin/main',behind:2,ahead:0,lookedAt:5,command:'agent-player update',remote:'https://token@example.invalid'});
 assert.ok(!JSON.stringify(u).includes('token@'));assert.equal(u.behind,2);
 assert.deepEqual(accountSettingsResponse('/api/system/updates',403,{code:'forbidden'}),{code:'forbidden'});
});
test('verification contract: recovery count and new codes',()=>{
 assert.deepEqual(verificationResponse('/api/auth/verification',200,{enabled:true,recoveryLeft:3}),{enabled:true,recoveryLeft:3});
 assert.deepEqual(verificationResponse('/api/auth/verification',200,{enabled:false,recoveryLeft:3}),{enabled:false});
 const codes=Array.from({length:8},(_,i)=>i.toString(16).padStart(32,'0'));
 assert.deepEqual(verificationResponse('/api/auth/verification/recovery-codes',200,{recoveryCodes:codes}),{recoveryCodes:codes});
 assert.equal(verificationResponse('/api/auth/verification/recovery-codes',200,{recoveryCodes:codes,token:'x'}),null);
 assert.equal(allowedVerification('POST','/api/auth/verification/recovery-codes',{password:'p',code:'123456'}),true);
 assert.equal(allowedVerification('POST','/api/auth/verification/recovery-codes',{password:'p'}),false);
});
