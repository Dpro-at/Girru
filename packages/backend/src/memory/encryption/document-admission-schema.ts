/** Explicit selected-runner schema, shared with copy-target preparation. No default database access. */
import {run,type Step} from '../../repositories/sql-steps.js';
export const DOCUMENT_ADMISSION_TABLE='memory_encryption_document_admissions';
export function* ensureDocumentAdmissionSchemaStep():Step<void>{
 yield* run(`CREATE TABLE IF NOT EXISTS ${DOCUMENT_ADMISSION_TABLE}(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,source_id TEXT NOT NULL,file_id TEXT NOT NULL,file_hash TEXT NOT NULL,key_id TEXT NOT NULL,authority_id TEXT NOT NULL,epoch BIGINT NOT NULL,forget_sequence BIGINT NOT NULL,forget_mac TEXT NOT NULL,source_revision BIGINT NOT NULL,file_revision BIGINT NOT NULL,review_hash TEXT NOT NULL,state TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,decided_by TEXT,decided_at TEXT,plan TEXT NOT NULL)`);
 yield* run(`CREATE INDEX IF NOT EXISTS idx_memory_encryption_document_admissions_file ON ${DOCUMENT_ADMISSION_TABLE}(owner_id,file_id,state)`);
}
