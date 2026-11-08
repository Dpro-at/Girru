import test from 'node:test';import assert from 'node:assert/strict';
import {displayCatalogue,validateDisplayDocument} from '../src/services/display-documents.ts';
import {displayCatalogueTool} from '../src/tools/display-catalogue.ts';
const doc=(type,props={})=>({schemaVersion:1,root:'r',elements:{r:{type,props,children:[]}}});
test('backend catalogue is pure data and shares the frontend61-type contract',async()=>{
 const result=displayCatalogue();assert.equal(result.components.length,61);assert.equal(result.authority,'display_only');
 assert.equal(validateDisplayDocument(doc('Metric',{label:'Synthetic',value:12})).ok,true);
 assert.equal(validateDisplayDocument(doc('InputField',{label:'Name',onChange:'delete everything'})).ok,false);
 const out=await displayCatalogueTool.execute({action:'validate',document:doc('Button',{label:'Request'})});assert.equal(out.data.ok,true);assert.equal(out.data.document.elements.r.type,'Button');
 assert.equal((await displayCatalogueTool.execute({action:'validate',document:doc('Card'),text:'{}'})).error,'invalid_input');
});
test('backend validation refuses dangerous structures, unknown versions and invalid props without data effects',()=>{
 assert.equal(validateDisplayDocument({...doc('Card'),schemaVersion:2}).ok,false);
 const v=doc('Card');v.elements.r.children=['r'];assert.equal(validateDisplayDocument(v).ok,false);
 assert.equal(validateDisplayDocument(doc('Table',{data:'not rows'})).ok,false);
 assert.equal(validateDisplayDocument('{"op":"add","path":"/elements/__proto__/x","value":1}').ok,false);
});
