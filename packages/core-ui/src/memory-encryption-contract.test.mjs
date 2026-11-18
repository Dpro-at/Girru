// Source fixtures deferred until final whole-task verification.
import test from 'node:test';import assert from 'node:assert/strict';import {allowedEncryption,encryptionResponse} from './memory-encryption-contract.js';
test('encryption status contract never enables keys, filesystem paths or implicit activation',()=>{assert.equal(allowedEncryption('GET','/api/memory/encryption/status',undefined),true);assert.equal(allowedEncryption('POST','/api/memory/encryption/unlock',{key:'secret'}),false);assert.equal(allowedEncryption('GET','/api/memory/encryption/rows/memories/id',undefined),false);assert.deepEqual(encryptionResponse(404,{}),{code:'encrypted_memory_unavailable'});assert.throws(()=>encryptionResponse(200,{state:'ready',activationReady:true}));assert.throws(()=>encryptionResponse(200,{state:'ready',activationReady:false,key:'secret'}));});
test('review decisions require the displayed hash and previews discard unrelated fields',()=>{const path='/api/memory/encryption/proposals/proposal-a';assert.equal(allowedEncryption('POST',path+'/decision',{decision:'approve',reviewHash:'a'.repeat(64)}),true);assert.equal(allowedEncryption('POST',path+'/decision',{decision:'approve',reviewHash:'a'.repeat(64),ownerId:'other'}),false);assert.throws(()=>encryptionResponse(200,{id:'other'},path));const view=encryptionResponse(200,{id:'proposal-a',status:'pending',reviewHash:'a'.repeat(64),changes:[{op:'add',after:{type:'fact',content:'SYNTHETIC_REVIEW',importance:5}}],conflictWith:null,ownerSecret:'discarded'},path);assert.equal(view.content,'SYNTHETIC_REVIEW');assert.equal(Object.hasOwn(view,'ownerSecret'),false);});
test('single conflict preview requires matching old identity and carries both reviewed texts',()=>{const path='/api/memory/encryption/proposals/proposal-a',body={id:'proposal-a',status:'pending',reviewHash:'b'.repeat(64),changes:[{op:'update',id:'memory-old',before:{type:'fact',importance:5,content:'SYNTHETIC_OLD'},after:{type:'fact',importance:5,content:'SYNTHETIC_NEW'}}],conflictWith:'memory-old'};const view=encryptionResponse(200,body,path);assert.equal(view.kind,'conflict');assert.equal(view.before,'SYNTHETIC_OLD');assert.equal(view.content,'SYNTHETIC_NEW');assert.throws(()=>encryptionResponse(200,{...body,conflictWith:'different-memory'},path));});
// Deferred until final whole-task verification.
test('encrypted import review exposes every proposed addition and retains the exact decision hash',()=>{
 const base='/api/memory/encryption',id='synthetic-import',hash='a'.repeat(64),entries=[{op:'add',after:{content:'Synthetic first',type:'fact',importance:5}},{op:'add',after:{content:'Synthetic second',type:'fact',importance:5}}];
 const result=encryptionResponse(200,{id,status:'pending',source:'import',reviewHash:hash,changes:entries,conflictWith:null},base+'/proposals/'+id);assert.equal(result.kind,'import');assert.deepEqual(result.entries,entries.map(change=>change.after));assert.equal(result.reviewHash,hash);
 assert.equal(allowedEncryption('POST',base+'/import',{text:'Synthetic text',format:'text',drawer:'owner'}),true);
 assert.equal(allowedEncryption('POST',base+'/import',{text:'Synthetic text',format:'text',drawer:'owner',profile:'/synthetic/untrusted'}),false);
});

test('encrypted graph contract requires exact reviewed decisions and bounded named relationships',()=>{
 const path='/api/memory/encryption/graph/synthetic-memory';assert.equal(allowedEncryption('GET',path,undefined),true);
 assert.equal(allowedEncryption('POST',path+'/decision',{decision:'approve',reviewHash:'a'.repeat(64)}),true);
 assert.equal(allowedEncryption('POST',path+'/decision',{decision:'approve',reviewHash:'bad'}),false);
 const preview={memoryId:'synthetic-memory',reviewHash:'a'.repeat(64),entities:[{name:'Alice',kind:'person'},{name:'Atlas',kind:'project'}],links:[{from:'Alice',to:'Atlas',type:'works_on'}]};
 assert.equal(encryptionResponse(200,preview,path).links.length,1);
 assert.throws(()=>encryptionResponse(200,{...preview,links:[{from:'Alice',to:'Unknown',type:'works_on'}]},path));
 assert.throws(()=>encryptionResponse(200,{...preview,memoryId:'other-memory'},path));
});

test('document invalidation notices expose bounded source provenance without paths or plaintext',()=>{
 const path='/api/memory/encryption/documents/status',source={id:'source-synthetic',kind:'project',refId:'project-synthetic',revision:2,files:0,chunks:0,documentsNeedOwnerReimport:true,invalidatedFileCount:3,invalidatedChunkCount:9},body={documentsNeedOwnerReimport:true,pendingImports:1,sources:[source]};
 assert.equal(allowedEncryption('GET',path),true);assert.deepEqual(encryptionResponse(200,body,path),body);for(const bad of [{...body,sources:[{...source,root:'/private/owner/source'}]},{...body,documentsNeedOwnerReimport:false},{...body,sources:[source,source]},{...body,pendingImports:-1},{...body,sources:[{...source,invalidatedChunkCount:NaN}]}])assert.throws(()=>encryptionResponse(200,bad,path));assert.equal(allowedEncryption('POST',path,{root:'/private/owner/source'}),false);
});

test('native encrypted-profile workflow uses fixed owner actions and opaque IDs only',()=>{
 const root='/api/memory/encryption/native/',opaque='a'.repeat(43),profile={profileId:'owned-synthetic',name:'Encrypted synthetic profile',state:'prepared',sourceKind:'new-empty',activationReady:false};
 assert.equal(allowedEncryption('GET',root+'profiles',undefined),true);assert.equal(allowedEncryption('POST',root+'select-source-copy',{}),true);assert.equal(allowedEncryption('POST',root+'prepare-new-profile',{sourceId:null}),true);assert.equal(allowedEncryption('POST',root+'activate-profile',{profileId:profile.profileId,reviewNonce:opaque}),true);
 for(const [action,body]of [['select-source-copy',{path:'/private/original'}],['prepare-new-profile',{sourceId:opaque,path:'/private/target'}],['activate-profile',{profileId:profile.profileId,reviewNonce:opaque,key:'secret'}]])assert.equal(allowedEncryption('POST',root+action,body),false);
 assert.deepEqual(encryptionResponse(200,[profile],root+'profiles'),[profile]);assert.deepEqual(encryptionResponse(200,{...profile,reviewNonce:opaque},root+'prepare-new-profile'),{...profile,reviewNonce:opaque});
 assert.throws(()=>encryptionResponse(200,[profile,profile],root+'profiles'));assert.throws(()=>encryptionResponse(200,[{...profile,path:'/private/target'}],root+'profiles'));assert.throws(()=>encryptionResponse(200,[{...profile,activationReady:true}],root+'profiles'));
 assert.deepEqual(encryptionResponse(503,{error:'private backend text'},root+'profiles'),{code:'encrypted_memory_unavailable'});
});

test('native resume nonce belongs only to explicitly revalidating profiles',()=>{
 const root='/api/memory/encryption/native/',profile={profileId:'synthetic-resume',name:'Synthetic resume profile',state:'requires-native-revalidation',sourceKind:'new-empty',activationReady:false,reviewNonce:'a'.repeat(43)};
 assert.deepEqual(encryptionResponse(200,[profile],root+'profiles'),[profile]);
 assert.throws(()=>encryptionResponse(200,[{...profile,state:'active',activationReady:true}],root+'profiles'));
 assert.throws(()=>encryptionResponse(200,[{...profile,reviewNonce:'arbitrary-path'}],root+'profiles'));
});

test('document picker and new-content review expose no renderer filesystem authority',()=>{
 const base='/api/memory/encryption',id='a'.repeat(32),admissionId='12345678-1234-1234-1234-123456789abc';
 assert.equal(allowedEncryption('POST',base+'/native/pick-document',{}),true);
 assert.equal(allowedEncryption('POST',base+'/native/pick-document',{path:'/private/profile'}),false);
 assert.deepEqual(encryptionResponse(200,{fileId:id,name:'Synthetic notes.md'},base+'/native/pick-document'),{fileId:id,name:'Synthetic notes.md'});
 assert.equal(allowedEncryption('POST',base+'/document-imports',{fileId:id}),true);
 assert.equal(allowedEncryption('POST',base+'/document-imports/'+admissionId+'/decision',{decision:'approve',reviewHash:'b'.repeat(64)}),false);
 const preview={admissionId,reviewHash:'b'.repeat(64),state:'pending',file:'Synthetic notes.md',source:{kind:'agent',refId:'synthetic-agent'},bytes:20,pages:null,unreadable:null,contents:[{heading:null,page:null,text:'Synthetic document'}],newContent:true,confirmation:'IMPORT DOCUMENT AS NEW CONTENT'};
 assert.deepEqual(encryptionResponse(200,preview,base+'/document-imports'),preview);
 assert.throws(()=>encryptionResponse(200,{...preview,file:'../outside.md'},base+'/document-imports'));
});
test('background consent accepts only existing definition IDs and exposes no grant handles',()=>{const base='/api/memory/encryption/native/';assert.equal(allowedEncryption('GET',base+'background-definitions',undefined),true);assert.equal(allowedEncryption('POST',base+'background-approve',{kind:'task',id:'synthetic-task'}),true);assert.equal(allowedEncryption('POST',base+'background-approve',{kind:'task',id:'synthetic-task',definitionHandle:'a'.repeat(43)}),false);assert.equal(allowedEncryption('POST',base+'background-approve',{kind:'task',id:'../private'}),false);const view={state:'ready',definitions:[{kind:'agent-cron',id:'synthetic-agent',label:'Synthetic local schedule'}]};assert.deepEqual(encryptionResponse(200,view,base+'background-definitions'),view);assert.deepEqual(encryptionResponse(200,{state:'waiting-owner-unlock',definitions:[]},base+'background-definitions'),{state:'waiting-owner-unlock',definitions:[]});assert.throws(()=>encryptionResponse(200,{state:'approved',kind:'task',id:'synthetic-task',grantId:'private'},base+'background-approve'));assert.throws(()=>encryptionResponse(200,{state:'ready',definitions:[view.definitions[0],view.definitions[0]]},base+'background-definitions'));});

test('background approval reports queued binding counts without accepting private grant metadata',()=>{
 const path='/api/memory/encryption/native/background-approve',body={state:'approved',kind:'task',id:'task-a',bound:2,waiting:1};assert.deepEqual(encryptionResponse(200,body,path),body);
 for(const changed of [{...body,bound:-1},{...body,waiting:'1'},{...body,grantId:'private-grant'},{...body,bound:Number.MAX_SAFE_INTEGER+1}])assert.throws(()=>encryptionResponse(200,changed,path));
});
