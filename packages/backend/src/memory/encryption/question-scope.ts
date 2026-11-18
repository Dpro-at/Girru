/** Versioned encrypted question headers. Legacy question hashes never imply agent/project access. */
import {createHash} from 'node:crypto';
import {normalizeDrawer,drawerId,type DrawerRef} from '../drawers.js';
import {captureMemoryRestoreAnchor,sameMemoryRestoreAnchor,type MemoryRestoreAnchor} from './restore-package.js';
import {MemoryCipherError} from './envelope.js';
import {captureEncryptedRunWriteAdmission,isTrustedEncryptedRunWriteAdmission} from './run-admission.js';
import type {decryptMemoryRowField} from './row-codec.js';
export type EncryptedQuestionScope={v:2;hash:string;agentId:string;runId:string;drawers:DrawerRef[]};
const identity=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value);
function canonicalDrawers(value:unknown):DrawerRef[]{if(!Array.isArray(value)||!value.length||value.length>500)throw new MemoryCipherError();const drawers=value.map(item=>{if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(key=>!['kind','key'].includes(key)))throw new MemoryCipherError();return normalizeDrawer(item);}).sort((a,b)=>drawerId(a).localeCompare(drawerId(b)));if(new Set(drawers.map(drawerId)).size!==drawers.length)throw new MemoryCipherError();return drawers;}
export function captureEncryptedQuestionScope(raw:unknown):EncryptedQuestionScope{
 if(typeof raw!=='string'||Buffer.byteLength(raw)>128*1024)throw new MemoryCipherError();const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='agentId,drawers,hash,runId,v'||value.v!==2||!identity(value.agentId)||!identity(value.runId)||typeof value.hash!=='string'||!/^[a-f0-9]{64}$/.test(value.hash))throw new MemoryCipherError();return{v:2,hash:value.hash,agentId:value.agentId,runId:value.runId,drawers:canonicalDrawers(value.drawers)};
}
/** Only actual trusted run admission can mint a question scope; caller hashes cannot create origin. */
export function prepareEncryptedQuestionScope(question:string,drawers:readonly DrawerRef[],admission:NonNullable<ReturnType<typeof captureEncryptedRunWriteAdmission>>):string{
 if(!isTrustedEncryptedRunWriteAdmission(admission)||typeof question!=='string'||!question.trim()||Buffer.byteLength(question)>50000)throw new MemoryCipherError();return JSON.stringify({v:2,hash:createHash('sha256').update(question).digest('hex'),agentId:admission.agentId,runId:admission.runId,drawers:canonicalDrawers(drawers.map(({kind,key})=>({kind,...(key===undefined?{}:{key})})))});
}
/** Returns false before question-text decryption when any origin/scope is unknown or hidden. */
export function authorizedEncryptedQuestionHeader(header:ReturnType<typeof decryptMemoryRowField>,input:{ownerId:string;memberId:string;agentId:string;rowAgentId:unknown;drawers:readonly DrawerRef[];anchor:MemoryRestoreAnchor}):boolean{
 try{const scope=captureEncryptedQuestionScope(header.value),producer=header.producer,anchor=captureMemoryRestoreAnchor(input.anchor),allowed=new Set(canonicalDrawers(input.drawers.map(({kind,key})=>({kind,...(key===undefined?{}:{key})}))).map(drawerId));return !!producer&&producer.kind==='admitted-run'&&scope.agentId===input.agentId&&scope.agentId===input.rowAgentId&&scope.agentId===producer.agentId&&scope.runId===producer.runId&&producer.ownerId===input.ownerId&&producer.memberId===input.memberId&&sameMemoryRestoreAnchor(anchor,{v:1,ownerId:producer.ownerId,memberId:producer.memberId,authorityId:producer.authorityId,keyId:producer.keyId,epoch:producer.epoch,forgetSequence:producer.forgetSequence,forgetMac:producer.forgetMac})&&scope.drawers.every(drawer=>allowed.has(drawerId(drawer)));}catch{return false;}
}
/** After header authorization, bind the opened text to the same authenticated producer and exact digest. */
export function verifiedEncryptedQuestionText(header:ReturnType<typeof decryptMemoryRowField>,text:ReturnType<typeof decryptMemoryRowField>):string{
 try{const scope=captureEncryptedQuestionScope(header.value);if(typeof text.value!=='string'||Buffer.byteLength(text.value)>50000||createHash('sha256').update(text.value).digest('hex')!==scope.hash||!header.producer||!text.producer||JSON.stringify(header.producer)!==JSON.stringify(text.producer))throw new MemoryCipherError();return text.value;}catch{throw new MemoryCipherError();}
}
