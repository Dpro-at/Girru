/** Pure managed-document preparation. No filesystem writes or external-root authorization. */
import {createHash} from 'node:crypto';
import {MANAGED_FILES,MAX_MANAGED_FILE_BYTES,P2_LEGACY,PRE_P2_LEGACY,splitManaged,type ManagedName} from '../bridge/managed-files.js';
import {createScopedForgetFileRunner} from './forget-files.js';
import {DESIGN_MARK_START,DESIGN_MARK_END} from '../../discovery/project-tech.js';
import {MemoryCipherError} from './envelope.js';
type ForgetDocumentName=ManagedName|'DESIGN.md';
export function prepareManagedProjectForget(name:ForgetDocumentName,bytes:Buffer){
 try{
  if(!(name==='DESIGN.md'||MANAGED_FILES.includes(name))||!Buffer.isBuffer(bytes)||bytes.length>MAX_MANAGED_FILE_BYTES)throw new MemoryCipherError();
  const original=new TextDecoder('utf-8',{fatal:true}).decode(bytes),marks=name==='DESIGN.md'?[{start:DESIGN_MARK_START,end:DESIGN_MARK_END,startRe:/<!-- dpro-design:start\b[^\n]*?-->/g,endRe:/<!-- dpro-design:end -->/g}]:[...P2_LEGACY,...PRE_P2_LEGACY];
  if(!Buffer.from(original).equals(bytes))throw new MemoryCipherError();
  for(const mark of marks)if(splitManaged(original,mark)==='broken')throw new MemoryCipherError();
  let after=original,removed=false;
  for(const mark of marks){const section=splitManaged(after,mark);if(section==='broken')throw new MemoryCipherError();if(section){after=section.before+section.after;removed=true;}}
  const output=Buffer.from(after),hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
  return{beforeHash:hash(bytes),afterHash:hash(output),after:output,removed};
 }catch{throw new MemoryCipherError();}
}

/** Explicit-root writer only; does not authorize a project or relax external-copy coverage gates. */
export function createManagedProjectForgetWriter(selectedRoot:string){
 const execute=createScopedForgetFileRunner(selectedRoot);
 return async(name:ForgetDocumentName,expected:Buffer)=>{const prepared=prepareManagedProjectForget(name,expected);await execute([{path:name,beforeHash:prepared.beforeHash,afterBase64:prepared.after.toString('base64')}]);return{changed:prepared.removed};};
}
