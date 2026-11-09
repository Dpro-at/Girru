/** Existing permission resolver adapter; inputs must come from the authenticated server run. */
import {scopeFactAccess} from '../scopes/pinned.js';
import {strictest,type AgentPermissions} from '../../tools/agent-permissions.js';
import {narrowPermissions,type AccessSnapshot} from '../scopes/access.js';
import {normalizeDrawer,sameDrawer,defaultDrawerForType,type DrawerRef} from '../drawers.js';
import {MemoryCipherError} from './envelope.js';
export function captureEncryptedRunAccess(input:{ownerId:string;agentId:string;chain:AgentPermissions[];policy:AccessSnapshot;project:string|null;drawers:DrawerRef[];audience:'owner'|'outsider';tokenExpiresAt:number},at=Date.now()){
 if(!input||input.ownerId!==input.policy?.ownerId||!Number.isFinite(at)||!Number.isFinite(input.tokenExpiresAt)||input.tokenExpiresAt<=at||!Array.isArray(input.chain)||!input.chain.length||input.chain.length>32||input.chain[0].agentId!==input.agentId||new Set(input.chain.map(p=>p.agentId)).size!==input.chain.length)throw new MemoryCipherError();
 const ownerId=input.ownerId,agents=input.chain.map(p=>({id:p.agentId,version:p.version})),policyVersion=input.policy.version;
 const permissions=strictest(input.agentId,input.chain.map(p=>narrowPermissions(p,input.policy,input.project,at)));
 const drawers=input.audience==='owner'?input.drawers.map(drawer=>({...normalizeDrawer(drawer),...(drawer.readOnly===true?{readOnly:true}:{})})).filter(d=>permissions.memoryRead.includes(d.kind)):[];
 let validUntil=input.tokenExpiresAt;
 // Conservatively stop at ANY upcoming owner rule expiry, including rules outside this project.
 for(const rule of input.policy.rules)if(rule.ends_at!==null){const end=Date.parse(rule.ends_at);if(!Number.isFinite(end))throw new MemoryCipherError();if(end>at)validUntil=Math.min(validUntil,end);}
 const permits=(row:Readonly<Record<string,unknown>>,writing:boolean)=>{
  if(row.user_id!==ownerId||(row.status??'active')!=='active')return false;
  try{const drawer=row.drawer_kind==null?defaultDrawerForType(typeof row.type==='string'?row.type:undefined):normalizeDrawer({kind:row.drawer_kind,key:row.drawer_key??''});return (!writing||permissions.memoryWrite.includes(drawer.kind))&&drawers.some(d=>sameDrawer(d,drawer)&&(!writing||d.readOnly!==true));}catch{return false;}
 };
 const pinnedFacts=scopeFactAccess(permissions,drawers.some(drawer=>drawer.kind==='owner'));if(!input.project||!drawers.some(drawer=>drawer.kind==='project'&&drawer.key===input.project)){pinnedFacts.project=false;pinnedFacts.department=false;}
 return Object.freeze({agents,policyVersion,validUntil,pinnedFacts:Object.freeze(pinnedFacts),authorize:(row:Readonly<Record<string,unknown>>)=>permits(row,false),authorizeWrite:(row:Readonly<Record<string,unknown>>)=>permits(row,true)});
}
