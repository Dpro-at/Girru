'use strict';
require('./load.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const ts = require('../node_modules/typescript');
const {reactResolve} = require('../scripts/react-runtime.cjs');
const uiRoot = path.resolve(__dirname, '..');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'girru-react-consumer-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const consumer = path.join(root, 'packages/core-ui'), renderer = path.join(root, 'packages/display-renderer/src');
  fs.mkdirSync(path.join(consumer, 'tests'), {recursive:true}); fs.mkdirSync(path.join(consumer, 'scripts')); fs.mkdirSync(renderer, {recursive:true});
  fs.writeFileSync(path.join(consumer, 'package.json'), '{"type":"commonjs"}');
  fs.copyFileSync(path.join(uiRoot, 'tests/load.cjs'), path.join(consumer, 'tests/load.cjs'));
  fs.copyFileSync(path.join(uiRoot, 'scripts/react-runtime.cjs'), path.join(consumer, 'scripts/react-runtime.cjs'));
  fs.copyFileSync(path.join(uiRoot, 'tsconfig.json'), path.join(consumer, 'tsconfig.json'));
  // Reuse only the already-installed consumer cache for this temporary fixture, not a renderer dependency link.
  fs.symlinkSync(fs.realpathSync(path.join(uiRoot, 'node_modules')), path.join(consumer, 'node_modules'), process.platform==='win32'?'junction':'dir');
  const foreign = path.join(root, 'node_modules/react'); fs.mkdirSync(foreign, {recursive:true});
  fs.writeFileSync(path.join(foreign, 'package.json'), '{"name":"react","main":"index.js"}');
  fs.writeFileSync(path.join(foreign, 'index.js'), 'throw Error("foreign ancestor React must not load");');
  const file = path.join(renderer, 'HookCard.tsx');
  fs.writeFileSync(file, 'import {useState,type ReactNode} from "react"; export function HookCard(){const [value]=useState(7);const label:ReactNode="Shared "+value;return <strong>{label}</strong>;} export {useState};');
  return {root,consumer,renderer,file};
}
test('sibling source uses the consumer React singleton without renderer node_modules or root dependencies', t => {
  const f=fixture(t),consumerRequire=createRequire(path.join(f.consumer,'package.json'));
  consumerRequire('./tests/load.cjs');
  const React=consumerRequire('react'),{renderToStaticMarkup}=consumerRequire('react-dom/server'),shared=consumerRequire(f.file);
  assert.equal(shared.useState,React.useState);
  assert.equal(renderToStaticMarkup(React.createElement(shared.HookCard)),'<strong>Shared 7</strong>');
  assert.equal(fs.existsSync(path.join(f.renderer,'../node_modules')),false);
});
test('consumer type mappings resolve React and JSX types for sibling source under strict checking', t => {
  const f=fixture(t),config=ts.readConfigFile(path.join(f.consumer,'tsconfig.json'),ts.sys.readFile);
  assert.equal(config.error,undefined);
  const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,f.consumer),options={...parsed.options};
  const program=ts.createProgram([f.file],options),errors=ts.getPreEmitDiagnostics(program);
  assert.deepEqual(errors.map(item=>ts.flattenDiagnosticMessageText(item.messageText,'\n')),[]);
  fs.appendFileSync(f.file,' const invalid:number="must fail strict checking";');
  assert.ok(ts.getPreEmitDiagnostics(ts.createProgram([f.file],options)).some(item=>item.code===2322));
});
test('development and verified builds both deduplicate the consumer React package and its subpaths',()=>{
  assert.deepEqual(reactResolve(),{dedupe:['react','react-dom']});
  for(const file of ['vite.config.ts','scripts/build.cjs'])assert.match(fs.readFileSync(path.join(uiRoot,file),'utf8'),/resolve:\s*reactResolve\(\)/);
});
