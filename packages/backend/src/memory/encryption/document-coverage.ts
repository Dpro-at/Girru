/** Exact admitted producer output, never a guess at semantic independence from forgotten text. */
import {createHash} from 'node:crypto';
import {lexicalTokens} from '../text-normalize.js';
import {captureDocumentAdmissionPlan,requireAppliedDocumentAdmission} from './document-lineage.js';
import type {MemoryRestoreAnchor} from './restore-package.js';
import {MemoryCipherError} from './envelope.js';
type Row=Readonly<Record<string,unknown>>;
export function validateAdmittedDocumentFile(file:Row,source:Row,chunks:readonly Row[],admissions:readonly Row[],anchor:MemoryRestoreAnchor,memberId:string):void{
 const matches=admissions.filter(row=>row.state==='applied'&&row.file_id===file.id&&row.file_hash===file.file_hash&&Number(row.file_revision)===Number(file.revision));if(matches.length!==1)throw new MemoryCipherError();const admission=matches[0],plan=captureDocumentAdmissionPlan(JSON.parse(String(admission.plan)));requireAppliedDocumentAdmission(admission,plan,file,source,anchor,memberId);
 const ordered=[...chunks].sort((a,b)=>Number(a.ordinal)-Number(b.ordinal));if(ordered.length!==plan.chunks.length||Number(file.chunks)!==ordered.length||Number(file.bytes)!==plan.file.size||file.pages!==plan.pages||file.reason!==plan.reason||file.status!==(plan.reason?'unreadable':'ok')||Number(file.revision)!==plan.file.revision+1||Number(admission.source_revision)!==plan.source.revision+1||Number(source.revision)<Number(admission.source_revision))throw new MemoryCipherError();
 for(let ordinal=0;ordinal<ordered.length;ordinal++){const chunk=ordered[ordinal],expected=plan.chunks[ordinal],id=createHash('sha256').update(String(file.id)+'\n'+String(file.revision)+'\n'+ordinal).digest('hex').slice(0,32);if(chunk.id!==id||chunk.ordinal!==ordinal||chunk.file_id!==file.id||chunk.source_id!==source.id||chunk.file_hash!==file.file_hash||Number(chunk.revision)!==Number(file.revision)||chunk.scope_kind!==source.kind||chunk.scope_key!==source.ref_id||chunk.heading!==expected.heading||chunk.page!==expected.page||chunk.content!==expected.text||chunk.lex!==lexicalTokens((expected.heading?expected.heading+'\n':'')+expected.text).join(' '))throw new MemoryCipherError();}
}
