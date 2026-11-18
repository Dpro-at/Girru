import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import ts from 'typescript';import {fileURLToPath} from 'node:url';
import {assertStoreAppQuery} from '../src/services/store-app-data.ts';
test('the shipped Call Center program never asks its data port to read core tables',()=>{
 const root=fileURLToPath(new URL('./fixtures/store-apps/call-center/program/',import.meta.url));let checked=0;
 function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory()){walk(file);continue;}if(!entry.name.endsWith('.js'))continue;
 const ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 function visit(node){let text;
 if(ts.isTemplateExpression(node))text=node.head.text+node.templateSpans.map(s=>'1'+s.literal.text).join('');
 else if(ts.isStringLiteralLike(node))text=node.text;
 if(text&&/^\s*(SELECT[\s\S]+\bFROM\b|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b)/i.test(text)){assert.doesNotThrow(()=>assertStoreAppQuery('call-center',text),path.relative(root,file)+' SQL: '+text);checked++;}
 ts.forEachChild(node,visit);}visit(ast);
 }}walk(root);assert.ok(checked>=45,`Expected reachable SQL coverage, got ${checked}`);
});
