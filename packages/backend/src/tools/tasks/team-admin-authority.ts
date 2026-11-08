import type {Tool,ToolExecutionContext} from '../types.js';
import {one,sql,sqliteSync,type Step} from '../../repositories/sql-steps.js';
import {userActor,type Actor} from '../../repositories/actor.js';

export const TEAM_ADMIN_READ='team_admin_read';
export const TEAM_ADMIN_WRITES=new Set(['specialty_apply','team_agent_create','team_agent_update','team_personality_apply','team_specialty_apply']);
export const isTeamAdminName=(name:string)=>name===TEAM_ADMIN_READ||TEAM_ADMIN_WRITES.has(name);
export const isTeamAdminTool=(tool:Tool)=>!tool.extensionId&&!tool.mcp&&isTeamAdminName(tool.name);
/** Model parameters never participate in determining administrative authority. */
export function eligibleContext(c:ToolExecutionContext){return !!c.userId&&!!c.agentId&&!!c.sessionId&&c.chatPlan===true&&!c.toolPolicy&&!c.taskId&&!c.taskRun&&!c.delegation&&!c.delegatedFrom?.length;}
export function* mainAdminStep(c:ToolExecutionContext):Step<boolean>{
 if(!eligibleContext(c))return false;
 const row=yield* one<{role:string;is_primary:number;parent_agent_id:string|null;agent_id:string|null;archived_at:string|null}>(
  'SELECT u.role,a.is_primary,p.parent_agent_id,s.agent_id,s.archived_at FROM users u JOIN chat_sessions s ON s.user_id=u.id JOIN agents_config a ON a.id=s.agent_id LEFT JOIN agent_grant_profiles p ON p.agent_id=a.id WHERE u.id=? AND s.id=? AND a.id=?',c.userId!,c.sessionId!,c.agentId!);
 return row?.role==='owner'&&row.is_primary===1&&!row.parent_agent_id&&!row.archived_at&&row.agent_id===c.agentId;
}
export async function mainAdminEligible(c:ToolExecutionContext){try{return await sql().read(mainAdminStep(c));}catch{return false;}}
export function mainAdminEligibleSync(c:ToolExecutionContext){try{return sqliteSync(mainAdminStep(c));}catch{return false;}}
const commands=new WeakMap<ToolExecutionContext,{name:string;ownerId:string}>();
/** Called only by the trusted registry after its grant/mode/approval checks. Not serialized. */
export async function bindOwnerCommand(c:ToolExecutionContext,name:string,approved:boolean){
 if(!isTeamAdminName(name)||TEAM_ADMIN_WRITES.has(name)&&!approved||!await mainAdminEligible(c))throw Error('team_admin_forbidden');
 const bound={...c};commands.set(bound,{name,ownerId:c.userId!});return bound;
}
/** Explicit owner command authority; the original agent actor remains on context for audit. */
export async function ownerCommandActor(c:ToolExecutionContext|undefined,name:string):Promise<Actor>{
 const authority=c&&commands.get(c);
 if(!c||!authority||authority.name!==name||authority.ownerId!==c.userId||!await mainAdminEligible(c))throw Error('team_admin_forbidden');
 return userActor({id:authority.ownerId,role:'owner'});
}
