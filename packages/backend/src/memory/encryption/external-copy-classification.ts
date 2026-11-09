/** Metadata association only; classifications never establish ownership or permit deletion. */
import path from 'node:path';
import {all,one,dialect,type Step} from '../../repositories/sql-steps.js';
import {BRIEF_CONSUMER} from '../outbox/projection.js';
import {MemoryCipherError} from './envelope.js';
export type ObservedExternalCopy={path:string;bytes:number;sha256:string};
export type ExternalCopyClass='shared-document'|'registered-projection-match'|'registered-projection-changed'|'historical-copy-unverified'|'staged-copy-unverified'|'unclassified';
export function* classifyExternalCopiesStep(ownerId:string,scope:string,root:string,input:readonly ObservedExternalCopy[]):Step<Array<ObservedExternalCopy&{classification:ExternalCopyClass}>>{
 if(typeof ownerId!=='string'||!ownerId||Buffer.byteLength(ownerId)>256||typeof scope!=='string'||!scope.startsWith('project:')||Buffer.byteLength(scope)>512||typeof root!=='string'||!path.isAbsolute(root)||path.resolve(root)!==root||Buffer.byteLength(root)>16384||root.includes('\0')||!Array.isArray(input)||input.length>132)throw new MemoryCipherError();
 const files=input.map(file=>({...file})),seen=new Set<string>();let total=0;
 for(const file of files){if(!file||Object.keys(file).sort().join(',')!=='bytes,path,sha256'||typeof file.path!=='string'||!(/^\.girru\/[^/\\\0]+$/.test(file.path)||['AGENTS.md','CLAUDE.md','GEMINI.md','DESIGN.md'].includes(file.path))||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>1048576||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256)||seen.has(file.path))throw new MemoryCipherError();seen.add(file.path);total+=file.bytes;}
 if(total>8388608)throw new MemoryCipherError();
 const owner=yield* one<{owner_id:string}>('SELECT owner_id FROM change_scopes WHERE scope=?',scope);if(!owner||owner.owner_id!==ownerId)throw new MemoryCipherError();
 const driver=yield* dialect(),size=(column:string)=>driver==='sqlite'?`length(CAST(${column} AS BLOB))`:`octet_length(${column})`;
 const rows=yield* all<{target:string|null;content_hash:string|null}>(`SELECT CASE WHEN ${size('p.target')}<=16384 THEN p.target ELSE NULL END target,CASE WHEN ${size('p.content_hash')}<=64 THEN p.content_hash ELSE NULL END content_hash FROM projection_state p JOIN change_scopes s ON s.scope=p.scope WHERE p.scope=? AND p.consumer=? AND s.owner_id=? LIMIT 2`,scope,BRIEF_CONSUMER,ownerId);
 if(rows.length>1)throw new MemoryCipherError();const registered=rows[0];
 return files.map(file=>{
  let classification:ExternalCopyClass='unclassified';
  if(!file.path.startsWith('.girru/'))classification='shared-document';
  else if(file.path==='.girru/brief.md'&&registered?.target===path.join(root,'.girru','brief.md')&&typeof registered.content_hash==='string'&&/^[a-f0-9]{64}$/.test(registered.content_hash))classification=registered.content_hash===file.sha256?'registered-projection-match':'registered-projection-changed';
  else if(/^\.girru\/brief\.outside-\d+\.md$/.test(file.path))classification='historical-copy-unverified';
  else if(/^\.girru\/(brief\.md\.[a-f0-9]{16}\.tmp|\.brief\.md\.girru-\d+-[a-f0-9-]{8}\.tmp)$/.test(file.path))classification='staged-copy-unverified';
  return{...file,classification};
 });
}
