/** Encrypted coding-app contract. Trusted caller must reuse bridge session/client/capability/project policy first. */
import type {createEncryptedMemoryRuntime} from './runtime-host.js';
import type {captureAuthenticatedMemoryRun} from './auth-capture.js';
import {MemoryCipherError} from './envelope.js';
type Request={client:string;sessionToken:string;capabilityToken:string;tool:string;args:Record<string,unknown>;cwd?:string};
export function createEncryptedMemoryBridgeAdapter(input:{runtime:ReturnType<typeof createEncryptedMemoryRuntime>;issueSession?:(request:Readonly<{ownerId:string;client:string;nonce:string;proof:string}>)=>Promise<{token:string}>;authorizeCall:(request:Readonly<Request>)=>Promise<{ownerId:string;client:string;capabilityId:string;run:Parameters<typeof captureAuthenticatedMemoryRun>[2];isCurrent:()=>boolean;validateCurrent:()=>Promise<boolean>}>}){
 const {runtime,authorizeCall,issueSession}=input;if(typeof authorizeCall!=='function')throw new MemoryCipherError();
 return{
  async openSession(request:{client:string;nonce:string;proof:string}){
   if(typeof issueSession!=='function'||!request||![request.client,request.nonce,request.proof].every(value=>typeof value==='string'&&value.length>0&&value.length<=4096)||request.client.length>128)throw new MemoryCipherError();
   const result=await issueSession(Object.freeze({...request,ownerId:runtime.ownerId}));if(!result||typeof result.token!=='string'||!result.token||result.token.length>4096)throw new MemoryCipherError();return{token:result.token};
  },
  async call(request:Request){
  if(!request||typeof request.client!=='string'||!request.client||request.client.length>128||typeof request.sessionToken!=='string'||request.sessionToken.length>4096||!request.sessionToken||typeof request.capabilityToken!=='string'||!request.capabilityToken||request.capabilityToken.length>16384||!['memory_search','memory_recall','pinned_facts','project_brief'].includes(request.tool)||!request.args||Array.isArray(request.args)||Object.keys(request.args).some(key=>!(['pinned_facts','project_brief'].includes(request.tool)?[]:['query','limit']).includes(key)))throw new MemoryCipherError();
  if(request.cwd!==undefined&&(typeof request.cwd!=='string'||!request.cwd||Buffer.byteLength(request.cwd)>16384))throw new MemoryCipherError();
  const captured={cwd:request.cwd,client:request.client,sessionToken:request.sessionToken,capabilityToken:request.capabilityToken,tool:request.tool,args:Object.freeze({...request.args})};
  if(!['pinned_facts','project_brief'].includes(captured.tool)&&(typeof captured.args.query!=='string'||Buffer.byteLength(captured.args.query)>4096||captured.args.limit!==undefined&&(!Number.isInteger(captured.args.limit)||Number(captured.args.limit)<1||Number(captured.args.limit)>50)))throw new MemoryCipherError();
  const authorized=await authorizeCall(Object.freeze(captured));if(!authorized||authorized.ownerId!==runtime.ownerId||authorized.client!==captured.client||typeof authorized.capabilityId!=='string'||!authorized.capabilityId||typeof authorized.isCurrent!=='function'||typeof authorized.validateCurrent!=='function')throw new MemoryCipherError();
  const current=authorized.isCurrent.bind(authorized),validate=authorized.validateCurrent.bind(authorized),run={...authorized.run,delegatedFrom:[...authorized.run.delegatedFrom],drawers:authorized.run.drawers.map(drawer=>({...drawer}))};
  const check=async()=>{if(current()!==true||await validate()!==true||current()!==true)throw new MemoryCipherError();};await check();
  if(captured.tool==='project_brief'){const result=await runtime.readContext({run,persona:'',reader:{kind:'coding-app',id:authorized.client},callerLease:{isCurrent:current,validateCurrent:validate}});await check();return{text:result.text,data:{items:result.items}};}
  if(captured.tool==='pinned_facts'){const result=await runtime.readPinnedFacts({run,reader:{kind:'coding-app',id:authorized.client},callerLease:{isCurrent:current,validateCurrent:validate}});await check();return{text:result.text,data:{facts:result.facts}};}
  const query=captured.args.query;if(typeof query!=='string')throw new MemoryCipherError();
  const result=await runtime.recallCodingApp({run,client:authorized.client,callerLease:{isCurrent:current,validateCurrent:validate},query,limit:captured.args.limit as number|undefined});await check();return{text:JSON.stringify(result),data:{memories:result}};
 }};
}
