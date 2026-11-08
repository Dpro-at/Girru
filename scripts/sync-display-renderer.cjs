'use strict';
// Copy a generated consumer snapshot, never maintain another component registry.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),source=path.join(root,'packages/display-renderer/src');
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
function syncDisplay(sdkRoot,check=false){
 const base=fs.realpathSync(sdkRoot),pkg=JSON.parse(fs.readFileSync(path.join(base,'package.json'),'utf8'));
 if(pkg.name!=='3d-world-sdk')throw Error('Expected the explicit SDK source repository');
 const target=path.join(base,'corresponding-source/platform/packages/world-sdk/studio/presentation/shared-display');
 if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw Error('Refuse a linked output');
 const files=fs.readdirSync(source).filter(f=>/^[a-z-]+\.(?:ts|tsx)$/.test(f)).sort(),manifest={schemaVersion:1,source:'Girru/packages/display-renderer/src',files:{}};
 for(const file of files){const bytes=fs.readFileSync(path.join(source,file));manifest.files[file]=digest(bytes);const output=path.join(target,file);if(check){if(!fs.existsSync(output)||!bytes.equals(fs.readFileSync(output)))throw Error('Stale display snapshot: '+file);}else{fs.mkdirSync(target,{recursive:true});fs.writeFileSync(output,bytes);}}
 const backend=path.join(root,'packages/backend/src/services/display-runtime'),runtime=path.join(base,'corresponding-source/platform/packages/assistant/src/display-runtime');
 const proof=JSON.parse(fs.readFileSync(path.join(backend,'provenance.json'),'utf8'));
 for(const name of ['catalogue','contract']){if(proof.files[name]!==digest(fs.readFileSync(path.join(source,name+'.ts'))))throw Error('Regenerate the backend display contract first');const bytes=fs.readFileSync(path.join(backend,name+'.cjs'));const output=path.join(runtime,name+'.cjs');if(check){if(!bytes.equals(fs.readFileSync(output)))throw Error('Stale SDK contract');}else{fs.mkdirSync(runtime,{recursive:true});fs.writeFileSync(output,bytes);}}
 const declaration='declare const contract: {normalizeDisplay(input:unknown): {ok:true;document:{schemaVersion:1;root:string;elements:Record<string,{type:string;props:Record<string,unknown>;children:string[]}>};warnings:string[]}|{ok:false;error:string}}; export = contract;\n';
 const declarationPath=path.join(runtime,'contract.d.cts');if(check){if(fs.readFileSync(declarationPath,'utf8')!==declaration)throw Error('Stale SDK contract types');}else fs.writeFileSync(declarationPath,declaration);
 const metadata=JSON.stringify(manifest,null,2)+'\n',file=path.join(target,'provenance.json');
 if(check){if(fs.readFileSync(file,'utf8')!==metadata)throw Error('Stale display provenance');}else fs.writeFileSync(file,metadata);
 return manifest;
}
if(require.main===module){const args=process.argv.slice(2),check=args[0]==='--check';if(check)args.shift();if(args.length!==2||args[0]!=='--sdk-root')throw Error('Use [--check] --sdk-root <explicit source repository>');console.log(JSON.stringify(syncDisplay(args[1],check)));}
module.exports={syncDisplay};
