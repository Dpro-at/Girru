import {taskRules} from './task-rules.js';
/** Portable domain adapters. No raw DB/profile replication, grants, model installation or Git publication. */
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {z} from 'zod';
import {sql,one,dialect,type Step} from '../repositories/sql-steps.js';
import {forUpdate} from '../db/pg/dialect.js';
import type {Actor} from '../repositories/actor.js';
import {repositories} from '../repositories/index.js';
import {getPref,setPrefReviewed} from '../repositories/user-prefs.js';
import {getRule} from '../services/agent-rules.js';
import {PersonalityLibrary} from '../services/personality-library.js';
import {SpecialtyTemplates} from '../services/specialty-templates.js';
import {centralSkills} from '../skills/central-store.js';
import {getBoard,createCard,updateCard} from '../services/task-board.js';
import {findProject,findConversation,listConversationMessages,createConversation,importConversationMessages,gitInfo} from '../repositories/chat-conversations.js';
import {readReport,saveReport} from '../services/reports.js';
import {publishPreparedReport} from '../services/report-publication.js';
import {readRegularFile} from '../services/read-regular-file.js';
import {cleanRel,secretPath} from '../repositories/project-files.js';
import {safeWriteFile,safeRoot,safeParts} from '../services/safe-file.js';
import {redactImportText} from '../memory/import/redact.js';
import {footerChangeOk,footerPrefs} from '../api/routes/ui-footer.js';
import {fingerprint} from './contracts.js';
import type {SyncPayload} from './replication-contract.js';
const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),text=(n:number)=>z.string().max(n);
const panel=z.object({order:z.array(z.enum(['place','team','results','memory','mcp'])).max(5),folded:z.array(z.enum(['place','team','results','memory','mcp'])).max(5),diff:z.enum(['unified','split'])}).strict();
const card=z.object({title:text(200),description:text(5000),priority:z.enum(['low','normal','high','urgent']),type:z.enum(['task','idea','bug','milestone','request'])}).strict();
const chat=z.object({title:text(120),messages:z.array(z.object({id,role:z.enum(['user','assistant']),content:text(16000)}).strict()).min(1).max(20)}).strict();
const artifact=z.object({name:z.string().min(1).max(100),base64:z.string().max(32768),sha256:z.string().regex(/^[a-f0-9]{64}$/),git:z.object({commit:z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),branch:text(160).nullable()}).strict().nullable()}).strict();
export interface SyncLocalMapping {resourceId?:string;expectedRevision:number;agentId:string;modelSelection?:string;projectId?:string|null;boardId?:string;columnId?:string;resolveConflict?:boolean}
export const mappingSchema=z.object({resourceId:id.optional(),expectedRevision:z.number().int().min(0),agentId:id,modelSelection:z.string().min(1).max(200).optional(),projectId:id.nullable().optional(),boardId:id.optional(),columnId:id.optional(),resolveConflict:z.boolean().optional()}).strict();
const configKinds=['agent','personality','specialty','skill','rule'];
export const isConfiguration=(kind:string)=>configKinds.includes(kind);
export function portableBody(category:string,raw:unknown):Record<string,any>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||(redactImportText(JSON.stringify(raw)).total||/\[SECRET:/i.test(JSON.stringify(raw))))throw Error('computer_sync_private_content_refused');let b=raw as Record<string,any>;
 if(category==='agent')b=z.object({name:text(80),description:text(2000),emoji:text(24).optional(),system_prompt:text(12000).optional(),department:text(64).nullable(),role:z.enum(['manager','specialist','evaluator']).nullable()}).strict().parse(b);
 else if(category==='personality')b=z.object({profile:z.record(z.string(),z.unknown())}).strict().parse(b);
 else if(category==='specialty')b=z.object({name:text(80),department:text(64),description:text(1800),instructions:text(12000)}).strict().parse(b);
 else if(category==='skill'){b=z.object({name:text(100),files:z.array(z.object({path:text(400),content:text(24000)}).strict()).min(1).max(40)}).strict().parse(b);centralSkills().validatePortable(b.name,b.files);}
 else if(category==='rule')b=z.object({text:text(2000),when:text(300).nullable(),paused:z.boolean(),who:z.literal('all'),targets:z.array(z.never()).max(0),projectId:z.null()}).strict().parse(b);
 else if(category==='preferences'){if(Object.keys(b).sort().join(',')!=='key,value'||!['chat-panel','footer','theme','computer-task-rules'].includes(b.key))throw Error('computer_preference_not_portable');if(b.key==='chat-panel')b={key:b.key,value:panel.parse(b.value)};else if(b.key==='theme'){if(!['system','light','dark'].includes(b.value))throw Error('computer_preference_not_portable');b={key:b.key,value:b.value};}else if(b.key==='computer-task-rules'){b={key:b.key,value:portableTaskRules(b.value)};}else{if(!footerChangeOk(b.value))throw Error('computer_preference_not_portable');b={key:b.key,value:footerPrefs(b.value)};}}
 else if(category==='task')b=card.parse(b);
 else if(category==='chat')b=chat.parse(b);
 else if(category==='report')b=z.object({title:text(160),presentation:z.record(z.string(),z.unknown()),sections:z.array(z.record(z.string(),z.unknown())).max(24)}).strict().parse(b);
 else if(category==='artifact'){b=artifact.parse(b);safeParts(b.name);if(b.name.includes('/')||secretPath(b.name)||!/^.*\.(txt|md|csv|json|png|jpe?g|webp|pdf|docx|xlsx|pptx)$/i.test(b.name))throw Error('computer_artifact_name_refused');const bytes=Buffer.from(b.base64,'base64');if(bytes.toString('base64')!==b.base64||bytes.length>24576||createHash('sha256').update(bytes).digest('hex')!==b.sha256||redactImportText(bytes.toString('utf8')).total)throw Error('computer_artifact_hash_or_private_content');}
 else throw Error('computer_sync_category_refused');return b;
}
export async function exportDomain(actor:Actor,selection:{category:string;localId:string;boardId?:string;projectId?:string;path?:string;messageIds?:string[]}){
 const owner=actor.userId!;let body:unknown;
 if(selection.category==='agent'){const a=await repositories.agents.getConfig(actor,selection.localId);if(!a)throw Error('computer_resource_unavailable');body={name:a.name,description:a.description??'',emoji:a.emoji,system_prompt:a.system_prompt??'',department:a.department??null,role:a.role==='main'?'specialist':a.role??null};}
 else if(selection.category==='personality')body={profile:(await new PersonalityLibrary().read(selection.localId)).profile};
 else if(selection.category==='specialty'){const a=await new SpecialtyTemplates().get(selection.localId);body={name:a.name,department:a.department,description:a.description,instructions:a.instructions};}
 else if(selection.category==='skill'){const a=await centralSkills().read(selection.localId);body={name:a.skill.name,files:a.files};}
 else if(selection.category==='rule'){const a=await getRule(selection.localId);if(!a||a.projectId&&!await findProject(owner,a.projectId))throw Error('computer_resource_unavailable');body={text:a.text,when:a.when??null,paused:true,who:'all',targets:[],projectId:null};}
 else if(selection.category==='preferences'){const value=await getPref(owner,selection.localId);body={key:selection.localId,value:selection.localId==='computer-task-rules'?portableTaskRules(value):value};}
 else if(selection.category==='task'){if(!selection.boardId)throw Error('computer_board_required');const b=await getBoard(owner,selection.boardId),a=b.cards.find(a=>a.id===selection.localId);if(!a)throw Error('computer_resource_unavailable');body={title:a.title,description:a.description,priority:a.priority,type:a.type};}
 else if(selection.category==='chat'){const c=await findConversation(owner,selection.localId);if(!c||c.projectId!==selection.projectId||c.projectId&&!await findProject(owner,c.projectId)||!selection.messageIds?.length)throw Error('computer_chat_selection_required');const messages=await listConversationMessages(c.id);body={title:c.title??'Shared conversation',messages:selection.messageIds.map(key=>{const m=messages.find(m=>m.id===key);if(!m||m.role==='system')throw Error('computer_message_unavailable');return {id:m.id,role:m.role,content:m.content};})};}
 else if(selection.category==='report'){const r=await readReport(owner,selection.localId);if(r.report.projectId!==(selection.projectId??null))throw Error('computer_project_association_changed');if(!r.snapshot)throw Error('computer_report_snapshot_required');body={title:r.report.title,presentation:r.snapshot.presentation,sections:r.snapshot.sections};}
 else if(selection.category==='artifact'){const p=selection.projectId&&await findProject(owner,selection.projectId),rel=cleanRel(selection.path);if(!p||!p.folder||!rel||secretPath(rel)||/(^|\/)(memory|sessions?|credentials?|keychain|\.data)(\/|$)|(^|\/)(MEMORY|PERSONALITY|AGENTS|CLAUDE|GEMINI)\.md$/i.test(rel))throw Error('computer_artifact_unavailable');const read=await readRegularFile(path.join(p.folder,rel),24576,{root:p.folder});const bytes=Buffer.from(read.data);body={name:path.basename(rel),base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),git:await gitInfo(p.folder).then(g=>({commit:g.lastCommit?.hash??null,branch:g.branch})).catch(()=>null)};}
 else throw Error('computer_sync_category_refused');return portableBody(selection.category,body);
}
export async function domainBefore(actor:Actor,category:string,m:SyncLocalMapping,body:Record<string,any>){const owner=actor.userId!;if(m.projectId&&!await findProject(owner,m.projectId))throw Error('computer_project_unavailable');if(category==='preferences')return await getPref(owner,body.key)??null;if(category==='task'){if(!m.boardId||!m.columnId)throw Error('computer_board_mapping_required');const b=await getBoard(owner,m.boardId);const c=m.resourceId?b.cards.find(c=>c.id===m.resourceId):null;if(m.resourceId&&(!c||c.version!==m.expectedRevision))throw Error('computer_revision_conflict');return c??null;}if(category==='chat'){if(m.resourceId){const c=await findConversation(owner,m.resourceId);if(!c||c.projectId!==(m.projectId??null))throw Error('computer_chat_mapping_changed');return {conversation:c,messages:await listConversationMessages(c.id)};}return null;}if(category==='report')return m.resourceId?await readReport(owner,m.resourceId):null;if(category==='artifact'){const p=m.projectId?await findProject(owner,m.projectId):null;if(!p?.folder)throw Error('computer_artifact_project_required');return {projectId:p.id,folder:safeRoot(p.folder)};}return null;}
export async function applyDomain(actor:Actor,p:SyncPayload,m:SyncLocalMapping,peer:string,recordId:string,artifactFence:((root:string,write:()=>unknown)=>Promise<unknown>)|undefined,effectGuard:()=>Step<void>,expectedBefore:unknown){const owner=actor.userId!,body=portableBody(p.category,p.body);
 if(p.category==='preferences'){/* Task rules: only the parts that mean the same on every computer; this computer keeps its own AI tool, projects and Takes new tasks. */const value=body.key==='computer-task-rules'?stricterTaskRules(expectedBefore,body.value):body.value;await setPrefReviewed(owner,body.key,value,expectedBefore,effectGuard);return {key:body.key};}
 if(p.category==='task'){return m.resourceId?updateCard(owner,m.boardId!,m.resourceId,{...body,expectedVersion:m.expectedRevision,columnId:m.columnId},effectGuard):createCard(owner,m.boardId!,{...body,columnId:m.columnId},{guard:effectGuard});}
 if(p.category==='chat'){const id=m.resourceId??('shared-'+createHash('sha256').update(peer+'\n'+recordId).digest('hex').slice(0,48));await importConversationMessages(owner,id,peer,p.logicalId,body.messages,{guard:effectGuard,...(!m.resourceId?{create:{title:body.title,agentId:m.agentId,projectId:m.projectId??null}}:{}),projectId:m.projectId??null});return {conversationId:id,imported:true,executed:false};}
 if(p.category==='report'){const report=await saveReport(owner,m.resourceId??null,{requestId:recordId,expectedRevision:m.expectedRevision,title:body.title,instructions:'Imported prepared display snapshot. Refresh requires separate local execution approval.',agentId:m.agentId,projectId:m.projectId??null,presentation:body.presentation},effectGuard);await publishPreparedReport(owner,report.report.id,{requestId:recordId,expectedRevision:report.report.revision,projectId:m.projectId??null,sections:body.sections},effectGuard);return {reportId:report.report.id,source:'external_prepared',executed:false};}
 if(p.category==='artifact'){const project=m.projectId?await findProject(owner,m.projectId):null;if(!project?.folder)throw Error('computer_artifact_project_required');const rel='.girru/shared-artifacts/'+peer.slice(0,16)+'/'+recordId+'/'+body.name;const bytes=Buffer.from(body.base64,'base64');if(!artifactFence)throw Error('computer_artifact_custody_required');const before=expectedBefore as {projectId?:string;folder?:string};if(before?.projectId!==project.id||before.folder!==safeRoot(project.folder))throw Error('computer_artifact_project_changed');const result=await artifactFence(project.folder,()=>sql().tx(function*(){yield* effectGuard();const current=yield* one<{folder:string|null}>('SELECT folder FROM chat_projects WHERE id=? AND user_id=?'+forUpdate(yield* dialect()),project.id,owner);if(!current?.folder||safeRoot(current.folder)!==before.folder)throw Error('computer_artifact_project_changed');return safeWriteFile(project.folder!,rel,bytes,{encoding:'binary',mode:0o600,expectSha256:null,maxBytes:24576});})) as {sha256:string};return {projectId:project.id,path:rel,sha256:result.sha256,sourceDevice:peer,git:body.git,published:false};}
 throw Error('computer_configuration_requires_existing_control_approval');
}
export const portableFingerprint=(value:unknown)=>fingerprint(value);
/** CP13: the task rules that travel with “Same as” — how tasks are taken and where they land, never computer-specific parts. */
export function portableTaskRules(value:unknown){const r=taskRules(value);return {rule:r.rule,atOnce:r.atOnce,column:r.column};}
/** Same as never lets this computer accept more than before: the stricter rule and the smaller number win; only where tasks land is copied as is. */
const RULE_STRICTNESS={auto:0,ask:1,refuse:2} as const;
export function stricterTaskRules(local:unknown,incoming:unknown){const here=taskRules(local),there=portableTaskRules(incoming);return {...here,rule:RULE_STRICTNESS[there.rule]>RULE_STRICTNESS[here.rule]?there.rule:here.rule,atOnce:Math.min(here.atOnce,there.atOnce),column:there.column};}
