/** Real runtime adapter: normal chat admission remains the only route to provider/tool execution. */
import {findConversation,findProject} from '../repositories/chat-conversations.js';
import {q} from '../repositories/sql-steps.js';
import {chatRuns} from '../services/chat-runs.js';
export interface ComputerRunAdmission {
 start(input:{ownerId:string;sessionId:string;runId:string;agentId:string;projectId:string;model:string;text:string;canExecute:()=>Promise<boolean>;finished:(state:string)=>Promise<void>}):Promise<void>;
 stop(runId:string):Promise<boolean>;
}
export function existingComputerRunAdmission(adapters?:{start?:typeof import('../api/routes/chat-conversations.js').startTurn;catalogue?:()=>Promise<{models:{id:string;available?:boolean}[]}>}):ComputerRunAdmission{return {
 async start(input){const conversation=await findConversation(input.ownerId,input.sessionId);if(!conversation||conversation.agentId!==input.agentId||conversation.projectId!==input.projectId||conversation.model!==input.model||!await findProject(input.ownerId,input.projectId)||!await input.canExecute())throw Error('computer_local_admission_changed');
  const {loadModelCatalogue}=await import('../services/model-catalogue.js');const catalogue=await (adapters?.catalogue??loadModelCatalogue)();if(!catalogue.models.some((m:any)=>m.id===input.model&&m.available!==false))throw Error('computer_local_model_unavailable');
  const {startTurn}=await import('../api/routes/chat-conversations.js');const result=await (adapters?.start??startTurn)({userId:input.ownerId,role:'owner',c:conversation,runId:input.runId,message:input.text,agentId:input.agentId,model:input.model,canStart:input.canExecute,effectFence:input.canExecute,onFinished:input.finished});if(result.code!==202)throw Error('computer_normal_admission_refused');const journal=await q.one('SELECT run_id FROM chat_run_journal WHERE run_id=? AND user_id=? AND session_id=?',input.runId,input.ownerId,input.sessionId);if(!journal)throw Error('computer_run_checkpoint_unknown');
 },async stop(runId){const live=chatRuns.get(runId);if(!live)return false;live.requestStop();return true;}
};}
