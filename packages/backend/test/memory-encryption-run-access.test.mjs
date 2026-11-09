import test from 'node:test';import assert from 'node:assert/strict';
import {captureEncryptedRunAccess} from '../src/memory/encryption/run-access.ts';
import {MemoryCipherError} from '../src/memory/encryption/envelope.ts';
const policy={ownerId:'owner',version:3,rules:[],templates:new Map(),roles:new Map(),projectDept:new Map()};
const permission=(id,read)=>({agentId:id,memoryRead:read,memoryWrite:[],sharedMemory:false,modes:{},version:2});
function input(){return {ownerId:'owner',agentId:'child',chain:[permission('child',['owner','project']),permission('parent',['project'])],policy,project:'allowed',drawers:[{kind:'owner'},{kind:'project',key:'allowed'}],audience:'owner',tokenExpiresAt:10000};}
test('existing delegated permission intersection and selected drawer key restrict encrypted candidates',()=>{
 const access=captureEncryptedRunAccess(input(),100);
 assert.equal(access.authorize({user_id:'owner',drawer_kind:'project',drawer_key:'allowed'}),true);
 for(const row of [{user_id:'other',drawer_kind:'project',drawer_key:'allowed'},{user_id:'owner',drawer_kind:'project',drawer_key:'denied'},{user_id:'owner',type:'fact'},{user_id:'owner',drawer_kind:'project',drawer_key:'allowed',status:'replaced'}])assert.equal(access.authorize(row),false);
 assert.equal(captureEncryptedRunAccess({...input(),audience:'outsider'},100).authorize({user_id:'owner',drawer_kind:'project',drawer_key:'allowed'}),false);
});
test('time-dependent owner rule expiry bounds the capture; malformed expiry fails closed',()=>{
 const rule={scope_kind:'company',scope_id:'',agent_id:'unrelated-agent',drawer_kind:'project',read_mode:'inherit',write_mode:'inherit',ends_at:new Date(5000).toISOString()};
 const access=captureEncryptedRunAccess({...input(),policy:{...policy,rules:[rule]}},100);assert.equal(access.validUntil,5000);
 assert.throws(()=>captureEncryptedRunAccess({...input(),policy:{...policy,rules:[{...rule,ends_at:'bad'}]}},100),MemoryCipherError);
});
test('write authorization never exceeds the delegated memoryWrite intersection',()=>{
 const request=input();request.chain[0].memoryWrite=['project'];request.chain[1].memoryWrite=[];
 const row={user_id:'owner',drawer_kind:'project',drawer_key:'allowed'};
 const denied=captureEncryptedRunAccess(request,100);assert.equal(denied.authorize(row),true);assert.equal(denied.authorizeWrite(row),false);
 request.chain[1].memoryWrite=['project'];assert.equal(captureEncryptedRunAccess(request,100).authorizeWrite(row),true);
});
// Deferred with the rest of the current whole-task source changes.
test('read-only linked project drawers remain readable but cannot gain write authority',()=>{
 const request=input();for(const member of request.chain)member.memoryWrite=['project'];
 request.drawers=[{kind:'project',key:'allowed',readOnly:true}];
 const row={user_id:'owner',drawer_kind:'project',drawer_key:'allowed'},access=captureEncryptedRunAccess(request,100);
 assert.equal(access.authorize(row),true);assert.equal(access.authorizeWrite(row),false);
});
