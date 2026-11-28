import test from 'node:test';
import assert from 'node:assert/strict';
import {callTool} from '../src/tools.ts';

test('memory_helper reads and acts through the owner-only helper and night routes',async()=>{
 const calls=[];const backend={request:async(method,path,body)=>{calls.push({method,path,body});return path.endsWith('/stop')?{stopped:true}:{ok:true};}};
 assert.notEqual((await callTool('memory_helper',{operation:'status'},{backend})).isError,true);
 assert.deepEqual(calls.slice(-2).map(c=>[c.method,c.path]),[['GET','/api/memory/helper'],['GET','/api/memory/scopes/night']]);
 assert.notEqual((await callTool('memory_helper',{operation:'settings',ram:{mode:'custom',customGb:12},worker:'qwen3:4b'},{backend})).isError,true);
 assert.deepEqual(calls.at(-1),{method:'PUT',path:'/api/memory/helper/settings',body:{ram:{mode:'custom',customGb:12},worker:'qwen3:4b'}});
 assert.notEqual((await callTool('memory_helper',{operation:'settings',worker:null},{backend})).isError,true);
 assert.deepEqual(calls.at(-1).body,{worker:null});
 assert.notEqual((await callTool('memory_helper',{operation:'start'},{backend})).isError,true);
 assert.deepEqual([calls.at(-1).method,calls.at(-1).path],['POST','/api/memory/scopes/night/run']);
 assert.notEqual((await callTool('memory_helper',{operation:'stop'},{backend})).isError,true);
 assert.deepEqual([calls.at(-1).method,calls.at(-1).path],['POST','/api/memory/scopes/night/stop']);
 const n=calls.length;
 for(const input of [{operation:'settings'},{operation:'settings',ram:{mode:'big'}},{operation:'settings',ram:{mode:'custom'}},{operation:'settings',worker:'../x'},{operation:'status',ram:{mode:'auto'}},{operation:'delete'}]){
  assert.equal((await callTool('memory_helper',input,{backend})).isError,true,JSON.stringify(input));
 }
 assert.equal(calls.length,n);
});

test('memory_helper status passes on what the night work is doing now, newest first',async()=>{
 const night={running:true,step:'read',now:{step:'read',file:'docs/storage-map.md',project:'girru',read:12,startedAt:'2026-11-28T01:04:00.000Z'},events:[{at:'2026-11-28T01:09:00.000Z',kind:'read',text:'Read README.md',project:'girru'}]};
 const backend={request:async(method,path)=>path==='/api/memory/scopes/night'?night:{ok:true}};
 const r=await callTool('memory_helper',{operation:'status'},{backend});
 assert.notEqual(r.isError,true);
 const text=JSON.stringify(r);
 assert.ok(text.includes('docs/storage-map.md')&&text.includes('Read README.md'),'now and events reach the coding app');
});
