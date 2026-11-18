import {runOllamaAgentLoop} from '../agent/providers/ollama-agent-loop.js';
import {DEFAULT_OLLAMA_MODEL} from '../llm/ollama.js';
import {defaultOllamaUrl} from '../config/ollama-url.js';
import {traitsToBehavior} from './personality.js';
import {validateProfile,profileInstructions,LibraryError} from './personality-library-profile.js';
/** The local model's origin, or null when the configured URL is not a plain loopback http address. */
export function localModelOrigin():string|null{
 const url=new URL(defaultOllamaUrl());
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return null;
 return url.origin;
}
/** One tool-free reply from the local model only: no history, memory, grants or cloud fallback. Empty string when it gave nothing. */
export async function localModelReply(origin:string,o:{system:string;prompt:string;temperature:number;maxTokens:number;timeoutMs?:number},fetchImpl:typeof fetch=fetch){
 const result=await runOllamaAgentLoop({url:origin,model:DEFAULT_OLLAMA_MODEL,messages:[{role:'system',content:o.system},{role:'user',content:o.prompt}],tools:[],execute:async()=>{throw new Error('No tools in a local preview');},write:()=>{},signal:AbortSignal.timeout(o.timeoutMs??20000),temperature:o.temperature,maxTokens:o.maxTokens,think:false,maxSteps:1,fetchImpl:(input,init)=>fetchImpl(input,{...init,redirect:'error'})});
 return result.aborted?'':result.answer;
}
/** One local, tool-free reply. No chat history, memory, grants or cloud fallback. */
export async function personalityPreview(raw:unknown,prompt:unknown,fetchImpl:typeof fetch=fetch){
 const p=validateProfile(raw);
 if(typeof prompt!=='string'||!prompt.trim()||prompt.length>2000)throw new LibraryError('invalid_input');
 const origin=localModelOrigin();
 if(!origin)throw new LibraryError('local_model_required',409);
 const behavior=traitsToBehavior(p.traits,p.dialect);
 try{
  const answer=await localModelReply(origin,{system:behavior.promptBlock+'\n'+profileInstructions(p)+'\nThis is a reply preview. You have no tools or memory. Do not claim to have performed any action.',prompt,temperature:behavior.temperature,maxTokens:Math.min(behavior.maxTokens,1024)},fetchImpl);
  if(!answer.trim())throw new LibraryError('preview_unavailable',503);
  return {reply:answer.slice(0,8000),model:DEFAULT_OLLAMA_MODEL,generated:true};
 }catch(e){if(e instanceof LibraryError)throw e;throw new LibraryError('preview_unavailable',503);}
}
