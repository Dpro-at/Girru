/** Native background consent covers reads and fixed internal trace maintenance, never semantic memory edits. */
import {currentStoredRunPrincipal} from './stored-run-principal.js';
const semanticWrites=new Set([
 'memory_add','memory_update','memory_save','memory_edit','memory_delete','memory_forget','memory_move',
 'memory_trash','memory_restore','memory_trash_empty','memory_project_trash','memory_person_forget',
 'memory_review_decide','memory_review_routine','memory_graph_review','memory_graph_topic','memory_graph_sync',
 'memory_scope_apply','memory_access_apply','memory_scope_forget','memory_group_apply','memory_bridge_apply',
 'memory_corrected_checked','memory_question_answer','memory_question_forget','memory_privacy_decide',
 'memory_doctor_fix','memory_reflect','handoff_save','run_note',
]);
export function storedRunAllowsTool(name:string):boolean{return !currentStoredRunPrincipal()||!semanticWrites.has(name);}
export function assertStoredRunToolAuthority(name:string):void{if(!storedRunAllowsTool(name))throw Error('background_semantic_memory_write_not_authorized');}
