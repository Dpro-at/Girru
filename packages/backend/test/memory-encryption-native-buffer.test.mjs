import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createNativeMemoryBufferIssuer,consumeAuthorizedMemoryFile} from '../src/memory/encryption/import-file.ts';

test('native content snapshot never opens its display path and trusted metadata spreads retain original capability',async()=>{
 const handle={},bytes=Buffer.from('Synthetic new owner document.'),sha256=createHash('sha256').update(bytes).digest('hex');let current=true;
 const issuer=createNativeMemoryBufferIssuer({ownerId:'synthetic-owner',profileId:'synthetic-profile',validateNativeCapability:(value,expected)=>value===handle?{...expected,isCurrent:()=>current}:null});
 try{const lease=issuer.issue({handle,fileId:'a'.repeat(32),path:'/synthetic-display-only/nonexistent.txt',sha256,bytes});bytes.fill(0);assert.equal(lease.kind,'native-buffer');assert.equal('exclusive'in lease,false);
 const decorated={...lease,sourceId:'b'.repeat(32)};const text=await consumeAuthorizedMemoryFile({fileId:lease.fileId,authorize:async()=>decorated,isCurrent:()=>current,consume:async({bytes,sourceLease})=>{assert.equal(sourceLease(),true);return bytes.toString();}});assert.equal(text,'Synthetic new owner document.');
 await assert.rejects(()=>consumeAuthorizedMemoryFile({fileId:lease.fileId,authorize:async()=>({...decorated,sha256:'0'.repeat(64)}),isCurrent:()=>true,consume:async()=>assert.fail('changed identity consumed')}));
 await assert.rejects(()=>consumeAuthorizedMemoryFile({fileId:lease.fileId,authorize:async()=>({...JSON.parse(JSON.stringify(lease)),isCurrent:()=>true}),isCurrent:()=>true,consume:async()=>assert.fail('forged snapshot consumed')}));
 current=false;await assert.rejects(()=>consumeAuthorizedMemoryFile({fileId:lease.fileId,authorize:async()=>lease,isCurrent:()=>true,consume:async()=>assert.fail('revoked snapshot consumed')}));
 }finally{issuer.close();bytes.fill(0);}
});
test('native snapshot issuer refuses reused response handles and revocation wipes owned snapshot',async()=>{
 const handle={},bytes=Buffer.from('Synthetic content'),sha256=createHash('sha256').update(bytes).digest('hex');const issuer=createNativeMemoryBufferIssuer({ownerId:'synthetic-owner',profileId:'synthetic-profile',validateNativeCapability:(value,expected)=>value===handle?{...expected,isCurrent:()=>true}:null});
 try{const request={handle,fileId:'c'.repeat(32),path:'/synthetic-display-only/test.txt',sha256,bytes},lease=issuer.issue(request);assert.throws(()=>issuer.issue(request));issuer.revoke(lease);await assert.rejects(()=>consumeAuthorizedMemoryFile({fileId:lease.fileId,authorize:async()=>lease,isCurrent:()=>true,consume:async()=>assert.fail('wiped snapshot consumed')}));}finally{issuer.close();bytes.fill(0);}
});
