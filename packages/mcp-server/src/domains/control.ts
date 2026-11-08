import {BackendError,type BackendClient} from '../backend.js';
export const workspaceControlDefinition={name:'workspace_control',title:'Owner-approved workspace control',description:'Actually create/update agents, personalities, specialties, Markdown skills and rules, and change permitted assignments, using real owner approval. preview returns exact before/after and affected agents with current revision and stable generated ID. request creates an existing encrypted/hash-bound Approvals card. Only the owner approves it in Girru; poll status/history, never confirm or approve on their behalf. No apply/approve/delete, arbitrary provider/config/grants, primary status, package installation or model execution. Uncertain execution is never automatically retried. Old workspace_drafts remain notes and are not approval cards.',inputSchema:{type:'object',properties:{operation:{type:'string',enum:['options','preview','request','status','history']},id:{type:'string',maxLength:128},body:{type:'object'}},required:['operation'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}} as const;
export class ControlInputError extends Error{}
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const plain=(v:unknown)=>{if(typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v)||v.includes('..'))throw new ControlInputError('Invalid identifier');return v;};
export async function workspaceControlTool(args:Record<string,unknown>,backend:BackendClient){
 const op=args.operation;if(!['options','preview','request','status','history'].includes(String(op)))throw new ControlInputError('Only preview/request/status/history/options; owner approval and apply are not exposed');
 const allowed=op==='status'?['operation','id']:op==='preview'||op==='request'?['operation','body']:['operation'];if(Object.keys(args).some(k=>!allowed.includes(k)))throw new ControlInputError('Unknown control argument');
 let path='/api/workspace-control',body:Record<string,unknown>|undefined;
 if(op==='status')path+='/'+encodeURIComponent(plain(args.id));else path+='/'+op;
 if(op==='preview'||op==='request'){
  if(!object(args.body))throw new ControlInputError('Explicit operation body required');body=args.body;
  const fields=op==='request'?['operationId','fingerprint']:['requestId','kind','action','targetId','expectedRevision','draft'];if(Object.keys(body).some(k=>!fields.includes(k))||Buffer.byteLength(JSON.stringify(body))>48000)throw new ControlInputError('Invalid bounded control body');
  if(op==='request'){plain(body.operationId);if(typeof body.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(body.fingerprint))throw new ControlInputError('Server fingerprint required');}
  else{plain(body.requestId);if(!['agent','personality','specialty','skill','rule'].includes(String(body.kind))||!['create','update','assign'].includes(String(body.action))||!Number.isSafeInteger(body.expectedRevision)||Number(body.expectedRevision)<0||!object(body.draft))throw new ControlInputError('Kind/action/current revision/draft required');if(body.targetId!==undefined)plain(body.targetId);}
 }
 const self=await backend.request('GET','/api/auth/me');if(self?.user?.role!=='owner'||self.user.status!=='active')throw new BackendError('Workspace control requires an active owner session',403);
 const data=await backend.request(op==='preview'||op==='request'?'POST':'GET',path,body);return {message:'Server-prepared operation. Only a real owner approval executes it; never approve for the owner. Check exact changes/affected agents. Uncertain means inspect, never automatically retry.',data};
}
