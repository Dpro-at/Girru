require('./load.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict');
const {allowedConversation,conversationResponse}=require('../src/conversation-contract.js');
const {PanesController}=require('../src/panes.ts');
const cid='00000000-0000-4000-8000-000000000001',mid='00000000-0000-4000-8000-000000000002';
const base=`/api/chat/conversations/${cid}/messages/${mid}`;
const changes={branch:null,notGit:false,truncated:false,changes:[{path:'src/a.ts',status:'modified',added:7,removed:2},{path:'deleted.ts',status:'deleted',added:0,removed:5}]};
test('reply file contracts preserve counts and refuse traversal, missing paths and writes',()=>{
 assert.equal(allowedConversation('GET',base+'/changes'),true);assert.equal(allowedConversation('GET',base+'/diff?path=src%2Fa.ts'),true);
 for(const path of [base+'/diff',base+'/diff?path=..%2Fsecret',base+'/changes?path=x'])assert.equal(allowedConversation('GET',path),false);
 assert.equal(allowedConversation('POST',base+'/changes',{}),false);assert.deepEqual(conversationResponse(base+'/changes',200,changes),changes);
});
test('a card selection opens its saved reply diff, including a deleted file, without reading current git',async()=>{
 const calls=[],panes=new PanesController({request:async r=>{calls.push(r.path);return{status:200,body:{path:'deleted.ts',diff:'@@ -1 +0,0 @@\n-deleted\n',binary:false,hidden:false,truncated:false}};}});
 await panes.openReplyDiff(cid,mid,'deleted.ts',changes);assert.deepEqual(calls,[base+'/diff?path=deleted.ts']);
 assert.equal(panes.getSnapshot().focusPath,'deleted.ts');assert.equal(panes.getSnapshot().diffs['deleted.ts'].phase,'ready');
 panes.clearReply();assert.equal(panes.getSnapshot().reply,undefined);assert.deepEqual(panes.getSnapshot().diffs,{});panes.dispose();
});
test('a late historical diff cannot overwrite another conversation selection',async()=>{
 let resolve;const panes=new PanesController({request:()=>new Promise(r=>{resolve=r;})});
 const pending=panes.openReplyDiff(cid,mid,'src/a.ts',changes);panes.clearReply();resolve({status:200,body:{path:'src/a.ts',diff:'stale'}});await pending;assert.deepEqual(panes.getSnapshot().diffs,{});panes.dispose();
});

test('closing and reopening a diff ignores the older response for the same path',async()=>{
 const pending=[];const panes=new PanesController({request:()=>new Promise(resolve=>pending.push(resolve))});
 const first=panes.openReplyDiff(cid,mid,'src/a.ts',changes);await panes.toggleDiff('src/a.ts');const second=panes.toggleDiff('src/a.ts');
 pending[0]({status:200,body:{path:'src/a.ts',diff:'older'}});await first;assert.equal(panes.getSnapshot().diffs['src/a.ts'].phase,'loading');
 pending[1]({status:200,body:{path:'src/a.ts',diff:'current'}});await second;assert.equal(panes.getSnapshot().diffs['src/a.ts'].data.diff,'current');panes.dispose();
});
