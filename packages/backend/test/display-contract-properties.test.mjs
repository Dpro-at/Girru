import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../../../',import.meta.url));
const ts=require(process.env.DISPLAY_TEST_TYPESCRIPT||'typescript');
const mirror=require('../src/services/display-runtime/contract.cjs');
const sourceDir=path.join(root,'packages/display-renderer/src');
function compile(name){const module={exports:{}};const text=fs.readFileSync(path.join(sourceDir,name+'.ts'),'utf8');const output=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;vm.runInThisContext('(function(module,exports,require){'+output+'\n})')(module,module.exports,()=>compile('catalogue'));return module.exports;}
const source=compile('contract');
const doc=props=>({root:'r',elements:{r:{type:'UnsupportedSynthetic',props,children:[]}}});
const patch=(path,value,op='add')=>JSON.stringify({op,path,value});
for(const [label,api] of [['canonical',source],['mirror',mirror]]){
 test(label+' rejects dangerous keys at every object/array nesting and patch path',()=>{
  for(const key of ['__proto__','constructor','prototype']){
   for(const props of [JSON.parse('{"'+key+'":{"polluted":true}}'),{data:[JSON.parse('{"'+key+'":true}')]}])assert.equal(api.normalizeDisplay(doc(props)).ok,false);
   for(const op of ['add','replace','remove','copy','move']){
    const operation={op,path:'/elements/r/props/'+key,value:{polluted:true},from:'/elements/r/props/safe'};
    const text=[patch('/root','r'),patch('/elements/r',{type:'UnsupportedSynthetic',props:{safe:{}},children:[]}),JSON.stringify(operation)].join('\n');
    assert.equal(api.normalizeDisplay(text).ok,false);
   }
   const a=[];Object.defineProperty(a,key,{value:{polluted:true},enumerable:true});assert.equal(api.normalizeDisplay(doc({data:a})).ok,false);
  }
  assert.equal(Object.prototype.polluted,undefined);
 });
 test(label+' clones into own data dictionaries without calling getters or inherited setters',()=>{
  let calls=0;const props={};Object.defineProperty(props,'label',{enumerable:true,get(){calls++;return 'bad';}});
  assert.equal(api.normalizeDisplay(doc(props)).ok,false);assert.equal(calls,0);
  const a=[];Object.defineProperty(a,'0',{enumerable:true,get(){calls++;return 1;}});assert.equal(api.normalizeDisplay(doc({data:a})).ok,false);assert.equal(calls,0);
  Object.defineProperty(Object.prototype,'displaySyntheticSetter',{configurable:true,set(){calls++;}});
  try{
   const text=[patch('/root','r'),patch('/elements/r',{type:'UnsupportedSynthetic',props:{},children:[]}),patch('/elements/r/props/displaySyntheticSetter',{nested:[1,2]}),JSON.stringify({op:'copy',from:'/elements/r/props/displaySyntheticSetter',path:'/elements/r/props/copied'}),JSON.stringify({op:'move',from:'/elements/r/props/copied',path:'/elements/r/props/moved'})].join('\n');
   const result=api.normalizeDisplay(text);assert.equal(result.ok,true);assert.equal(calls,0);assert.equal(Object.getPrototypeOf(result.document.elements),null);assert.equal(Object.getPrototypeOf(result.document.elements.r.props),null);assert.equal(Object.hasOwn(result.document.elements.r.props,'moved'),true);assert.deepEqual(result.document.elements.r.props.moved.nested,[1,2]);
  }finally{delete Object.prototype.displaySyntheticSetter;}
 });
}
test('generated mirror exactly matches canonical source and provenance',()=>{
 const {syncContract}=require('../../../scripts/sync-display-contract.cjs');syncContract(ts,root,true);
 for(const input of [doc({safe:{items:[1,'two']}}),patch('/elements/__proto__',{}),doc({label:'Synthetic'})])assert.deepEqual(source.normalizeDisplay(input),mirror.normalizeDisplay(input));
});
test('all existing component fixtures retain their display schema and source/mirror trees',()=>{
 const fixtures=JSON.parse(fs.readFileSync(path.join(root,'packages/display-renderer/test/fixtures.json'),'utf8'));
 assert.equal(Object.keys(fixtures).length,61);
 for(const [type,props] of Object.entries(fixtures)){
  const input={schemaVersion:1,root:'r',elements:{r:{type,props,children:[]}}};
  const a=source.normalizeDisplay(input),b=mirror.normalizeDisplay(input);assert.equal(a.ok,true,type);assert.deepEqual(a,b);
  assert.deepEqual(JSON.parse(JSON.stringify(a.document)),input);assert.deepEqual(source.displayTree(a.document),mirror.displayTree(b.document));
 }
});
test('canonical and mirror refuse hidden or inherited serialization hooks without invoking them',()=>{
 for(const api of [source,mirror]){
  let calls=0;
  for(const container of [{},[]])for(const getter of [true,false]){
   const value=Array.isArray(container)?[]:{};
   Object.defineProperty(value,'toJSON',getter?{get(){calls++;return ()=>{calls++;return {};};}}:{value(){calls++;return {};}});
   assert.equal(api.normalizeDisplay(doc({data:value})).ok,false);assert.equal(calls,0);
  }
  Object.defineProperty(Object.prototype,'toJSON',{configurable:true,get(){calls++;return ()=>({});}});
  try{assert.equal(api.normalizeDisplay(doc({data:[]})).ok,false);assert.equal(calls,0);}finally{delete Object.prototype.toJSON;}
  const hidden={};Object.defineProperty(hidden,'hidden',{value:1});assert.equal(api.normalizeDisplay(doc(hidden)).ok,false);
  const symbolic={};symbolic[Symbol('hidden')]=1;assert.equal(api.normalizeDisplay(doc(symbolic)).ok,false);
 }
});
