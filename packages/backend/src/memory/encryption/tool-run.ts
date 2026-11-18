/** Derive a memory run only from the existing trusted tool context, never tool/model parameters. */
import type {ToolExecutionContext} from '../../tools/types.js';
import {toolMemoryUser,toolMemoryDrawers} from '../../tools/memory/scope.js';
import {normalizeDrawer,sameDrawer} from '../drawers.js';
import type {captureAuthenticatedMemoryRun} from './auth-capture.js';
import {MemoryCipherError} from './envelope.js';
export function encryptedMemoryRunFromToolContext(ownerId:string,context:ToolExecutionContext):Parameters<typeof captureAuthenticatedMemoryRun>[2]{
 if(toolMemoryUser(context)!==ownerId||context.toolPolicy||!context.agentId||context.actor?.kind!=='agent'||context.actor.agentId!==context.agentId||context.actor.userId!==ownerId)throw new MemoryCipherError();
 const delegatedFrom=[...(context.delegatedFrom??[])];if(delegatedFrom.length>31||new Set([context.agentId,...delegatedFrom]).size!==delegatedFrom.length+1)throw new MemoryCipherError();
 const drawers=toolMemoryDrawers(context).map(drawer=>({...normalizeDrawer(drawer),...(drawer.readOnly===true?{readOnly:true}:{})}));if(drawers.length>64||drawers.some((drawer,index)=>drawers.slice(0,index).some(previous=>sameDrawer(previous,drawer))))throw new MemoryCipherError();
 const activeProjects=drawers.filter(drawer=>drawer.kind==='project'&&drawer.readOnly!==true);if(activeProjects.length>1)throw new MemoryCipherError();
 return{agentId:context.agentId,delegatedFrom,drawers,project:activeProjects[0]?.key??null,audience:'owner'};
}
