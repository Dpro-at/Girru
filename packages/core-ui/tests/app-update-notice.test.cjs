require('./load.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict');
const {updateNoticeText}=require('../src/AppUpdateNotice.tsx');
const base={version:'1.0',checkedAt:null,busy:null,error:null,update:{version:'1.1',publishedAt:null,notes:'New',page:'https://example.test',canInstall:true}};
test('update notice is absent without a release and keeps actionable failures and progress visible',()=>{
 assert.equal(updateNoticeText(null),null);
 assert.equal(updateNoticeText({...base,update:null}),null);
 assert.equal(updateNoticeText(base),'Girru 1.1 is available');
 for(const busy of ['checking','downloading','backing-up','installing'])assert.ok(updateNoticeText({...base,busy}));
 assert.equal(updateNoticeText({...base,error:'failed'}),'Update needs attention');
});
