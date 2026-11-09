/** Explicit pre-activation document review only. It cannot start memory execution, restore, export or automatic indexing. */
import {all,tableExists,type StepRunner} from '../../repositories/sql-steps.js';
import {createMemoryUnlockSession} from './unlock-session.js';
import {authenticatedMemoryOwnerStep} from './auth-capture.js';
import {createAuthenticatedMemoryRestoreHost} from './restore-host.js';
import {configureEncryptedDocumentSource} from './document-writer.js';
import {ensureDocumentAdmissionSchemaStep,DOCUMENT_ADMISSION_TABLE} from './document-admission-schema.js';
import {previewAuthenticatedDocumentImport,readAuthenticatedDocumentImport,decideAuthenticatedDocumentImport,type DocumentAdmissionServices} from './document-admission.js';
import {MemoryCipherError} from './envelope.js';
type Input=Omit<DocumentAdmissionServices,'recordRead'>&Pick<Parameters<typeof createAuthenticatedMemoryRestoreHost>[0],'auditKey'|'verificationKey'|'auditCustody'|'authorizeEmptyTarget'>&{runPreparationOperation:<T>(operation:()=>Promise<T>,readOnlyContent?:boolean)=>Promise<T>};
export function createDocumentAdmissionReviewHost(input:Input){
 const {runner,token,session}=input,readAudit=createAuthenticatedMemoryRestoreHost(input);let state:'new'|'ready'|'failed'|'closed'='new',active:Promise<unknown>|undefined;
 const services:DocumentAdmissionServices={runner,token,session,authorizeFile:input.authorizeFile,captureAuthority:input.captureAuthority,recordRead:intent=>readAudit.recordRead(intent),embedDocument:input.embedDocument};
 const perform=<T>(operation:()=>Promise<T>):Promise<T>=>{if(state!=='ready'||active)return Promise.reject(new MemoryCipherError());const pending=(async()=>{try{return await input.runPreparationOperation(operation);}catch{state='failed';session.lock();throw new MemoryCipherError();}})();active=pending;void pending.finally(()=>{if(active===pending)active=undefined;}).catch(()=>{});return pending;};
 return Object.freeze({
  async start(){if(state!=='new')throw new MemoryCipherError();try{await input.runPreparationOperation(async()=>{if(!(await runner.read(tableExists(DOCUMENT_ADMISSION_TABLE))))throw new MemoryCipherError();await readAudit.start();},true);state='ready';}catch{state='failed';session.lock();throw new MemoryCipherError();}},
  status:()=>state,
  list:()=>perform(async()=>{const lease=session.capture(),owner=await runner.tx(()=>authenticatedMemoryOwnerStep(token),{immediate:true});if(owner.ownerId!==lease.scope.ownerId||!lease.isCurrent())throw new MemoryCipherError();const rows=await runner.read(all<{id:string}>(`SELECT id FROM ${DOCUMENT_ADMISSION_TABLE} WHERE owner_id=? AND state='pending' ORDER BY created_at,id LIMIT 1001`,owner.ownerId));if(rows.length>1000||!lease.isCurrent())throw new MemoryCipherError();return{ids:rows.map(row=>row.id),documentsNeedOwnerReimport:true,activationReady:false};}),
  configureSource:(request:Pick<Parameters<typeof configureEncryptedDocumentSource>[0],'kind'|'refId'|'enabled'|'expectedRevision'>)=>{const captured={...request};return perform(()=>configureEncryptedDocumentSource({...captured,runner,token,session,recordRead:services.recordRead}));},
  preview:(fileId:string)=>perform(()=>previewAuthenticatedDocumentImport({...services,fileId})),
  read:(admissionId:string)=>perform(()=>readAuthenticatedDocumentImport({...services,admissionId})),
  decide:(request:Pick<Parameters<typeof decideAuthenticatedDocumentImport>[0],'admissionId'|'reviewHash'|'decision'|'confirmation'>)=>{const captured={...request};return perform(()=>decideAuthenticatedDocumentImport({...services,...captured}));},
  async close(){if(state==='closed')return;state='closed';session.lock();try{await active;}catch{}await readAudit.close();},
 });
}
