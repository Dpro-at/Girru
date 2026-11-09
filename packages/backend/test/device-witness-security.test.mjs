import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {witnessDestination,resolveWitnessDestination,postWitness} from '../src/devices/witness-http-client.ts';
import {createPersistentWitnessStore} from '../src/devices/witness-store.ts';
import {acquirePrivateMetadataLease,readPrivateMetadata} from '../src/devices/private-metadata.ts';
const temp=()=>fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'witness-security-')));
test('public witness URL and every DNS answer must be public; local test access is explicit',async()=>{
 for(const url of ['http://example.com/v1/device-anchor','https://127.0.0.1/v1/device-anchor','https://2130706433/v1/device-anchor','https://[::1]/v1/device-anchor','https://example.com:444/v1/device-anchor','https://u:p@example.com/v1/device-anchor','https://example.com/v1/device-anchor?q=1'])assert.throws(()=>witnessDestination(url));
 const u=witnessDestination('https://example.com/v1/device-anchor');
 for(const address of ['127.0.0.1','10.0.0.2','169.254.169.254','::1','::ffff:127.0.0.1'])await assert.rejects(resolveWitnessDestination(u,async()=>[{address,family:address.includes(':')?6:4}]));
 await assert.rejects(resolveWitnessDestination(u,async()=>[{address:'8.8.8.8',family:4},{address:'192.168.1.1',family:4}]));
 assert.deepEqual(await resolveWitnessDestination(u,async()=>[{address:'8.8.8.8',family:4}]),{address:'8.8.8.8',family:4});
 assert.throws(()=>witnessDestination('http://127.0.0.1:1234/v1/device-anchor'));
 await assert.rejects(resolveWitnessDestination(new URL('http://127.0.0.1:1234/v1/device-anchor')));
});
test('pinned POST rejects redirects and oversized responses on disposable loopback',async()=>{
 let mode='ok';const server=http.createServer((req,res)=>{assert.equal(req.method,'POST');if(mode==='redirect'){res.writeHead(302,{location:'http://169.254.169.254/'});res.end();}else if(mode==='large'){res.writeHead(200,{'content-type':'application/json'});res.end('x'.repeat(16001));}else{res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const url=witnessDestination(`http://127.0.0.1:${server.address().port}/v1/device-anchor`,true);assert.deepEqual(await postWitness(url,'{}'),{ok:true});mode='redirect';await assert.rejects(postWitness(url,'{}'));mode='large';await assert.rejects(postWitness(url,'{}'));await assert.rejects(postWitness(url,'x'.repeat(16001)));}finally{await new Promise(resolve=>server.close(resolve));}
});
test('atomic writer acquisition never replaces an empty existing lock and release never removes replacement',()=>{
 const root=temp(),lock=path.join(root,'exclusive.lock');fs.mkdirSync(lock,{mode:0o700});assert.throws(()=>createPersistentWitnessStore(root));assert.deepEqual(fs.readdirSync(lock),[]);fs.rmdirSync(lock);
 const lease=acquirePrivateMetadataLease(root,'exclusive.lock');assert.throws(()=>acquirePrivateMetadataLease(root,'exclusive.lock'));fs.renameSync(lock,path.join(root,'old-lock'));fs.mkdirSync(lock,{mode:0o700});fs.writeFileSync(path.join(lock,'owner'),'replacement',{mode:0o600});assert.throws(()=>lease.release());assert.equal(fs.readFileSync(path.join(lock,'owner'),'utf8'),'replacement');
});
test('metadata reads bind descriptor identity and refuse symlinks, hard links, and public files',()=>{
 const root=temp(),file=path.join(root,'metadata');fs.writeFileSync(file,'{}',{mode:0o600});assert.equal(readPrivateMetadata(file,4096),'{}');fs.linkSync(file,path.join(root,'hard'));assert.throws(()=>readPrivateMetadata(file,4096));fs.unlinkSync(path.join(root,'hard'));fs.symlinkSync(file,path.join(root,'symbolic'));assert.throws(()=>readPrivateMetadata(path.join(root,'symbolic'),4096));fs.chmodSync(file,0o644);if(process.platform!=='win32')assert.throws(()=>readPrivateMetadata(file,4096));
});

test('HTTPS socket uses only validated pinned DNS address without redirect or second lookup',async(t)=>{let calls=0;const requestStub=t.mock.method(https,'request',(options,onResponse)=>{assert.equal(options.hostname,'example.com');assert.equal(options.agent,false);options.lookup('example.com',{},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'8.8.8.8');assert.equal(family,4);});options.lookup('example.com',{all:true},(error,addresses)=>{assert.equal(error,null);assert.deepEqual(addresses,[{address:'8.8.8.8',family:4}]);});const request=new EventEmitter();request.end=()=>{const response=new PassThrough();response.statusCode=200;response.headers={'content-type':'application/json'};onResponse(response);response.end('{}');};request.destroy=()=>{};return request;});try{assert.deepEqual(await postWitness(witnessDestination('https://example.com/v1/device-anchor'),'{}',async()=>{calls++;return [{address:'8.8.8.8',family:4}];}),{});assert.equal(calls,1);assert.equal(requestStub.mock.callCount(),1);await assert.rejects(postWitness(witnessDestination('https://example.com/v1/device-anchor'),'{}',async()=>[{address:'127.0.0.1',family:4}]));assert.equal(requestStub.mock.callCount(),1);}finally{requestStub.mock.restore();}});

test('destination is snapshotted before asynchronous DNS',async(t)=>{let finish;const answer=new Promise(resolve=>{finish=resolve;});const original=witnessDestination('https://example.com/v1/device-anchor');const stub=t.mock.method(https,'request',(options,onResponse)=>{assert.equal(options.protocol,'https:');assert.equal(options.hostname,'example.com');const request=new EventEmitter();request.end=()=>{const response=new PassThrough();response.statusCode=200;response.headers={'content-type':'application/json'};onResponse(response);response.end('{}');};request.destroy=()=>{};return request;});try{const result=postWitness(original,'{}',()=>answer);original.href='http://127.0.0.1:9/v1/device-anchor';finish([{address:'8.8.8.8',family:4}]);assert.deepEqual(await result,{});}finally{stub.mock.restore();}});

test('a live witness never resets its counter when the persisted state disappears',async()=>{const root=temp(),store=createPersistentWitnessStore(root);try{assert.equal(await store.nextSequence(),1);fs.unlinkSync(path.join(root,'anchors.json'));await assert.rejects(store.nextSequence());}finally{store.close();}});
