'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function syncContract(ts,root=path.resolve(__dirname,'..'),check=false){
 const source=path.join(root,'packages/display-renderer/src'),target=path.join(root,'packages/backend/src/services/display-runtime');let hashes={};
 for(const name of ['catalogue','contract']){
  const input=fs.readFileSync(path.join(source,name+'.ts'),'utf8');const output=ts.transpileModule(input,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText.replace('require("./catalogue")','require("./catalogue.cjs")');
  const file=path.join(target,name+'.cjs');hashes[name]=crypto.createHash('sha256').update(input).digest('hex');
  if(check){if(fs.readFileSync(file,'utf8')!==output)throw Error('Stale display contract: '+name);}else{fs.mkdirSync(target,{recursive:true});fs.writeFileSync(file,output);}
 }
 const metadata=JSON.stringify({schemaVersion:1,source:'packages/display-renderer/src',files:hashes},null,2)+'\n',manifest=path.join(target,'provenance.json');if(check){if(fs.readFileSync(manifest,'utf8')!==metadata)throw Error('Stale display contract provenance');}else fs.writeFileSync(manifest,metadata);
}
if(require.main===module)syncContract(require('typescript'),undefined,process.argv.includes('--check'));
module.exports={syncContract};
