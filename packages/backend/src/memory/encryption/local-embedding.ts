/** Short-lived adapter to the existing embedding service; no global cache or remote provider selection. */
import {EmbeddingService,DEFAULT_EMBEDDING_MODEL,type EmbeddingResult} from '../embedding.js';
import {MemoryCipherError} from './envelope.js';
export type SelectedMemoryEmbeddingOptions={mode:'hash'}|{mode:'ollama';baseUrl:string;model:string};
export function createSelectedMemoryEmbedding(input:SelectedMemoryEmbeddingOptions,refreshHostFoundations?:()=>Promise<void>){
 const options={...input};
 if(options.mode!=='hash'&&options.mode!=='ollama')throw new MemoryCipherError();
 if(options.mode==='ollama'){
  let url:URL;try{url=new URL(options.baseUrl);}catch{throw new MemoryCipherError();}
  // Numeric loopback avoids DNS resolution; redirects are refused by the underlying provider.
  if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||typeof options.model!=='string'||!options.model||options.model.length>200)throw new MemoryCipherError();
  options.baseUrl=url.origin;
 }
 let closed=false;
 async function embed(text:string,query:boolean):Promise<EmbeddingResult>{
  if(closed||typeof text!=='string'||Buffer.byteLength(text)>(query?4096:200000))throw new MemoryCipherError();
  await refreshHostFoundations?.();if(closed)throw new MemoryCipherError();
  const service=new EmbeddingService(options.mode==='hash'?{mode:'hash',model:DEFAULT_EMBEDDING_MODEL,baseUrl:'http://127.0.0.1:11434'}:options);
  let result:EmbeddingResult|undefined;
  try{
   result=await(query?service.embedQuery(text):service.embedDetailed(text));
   await refreshHostFoundations?.();
   if(closed||!result||!Number.isInteger(result.dims)||result.dims<1||result.dims>8192||result.vector.length!==result.dims||result.vector.some(value=>!Number.isFinite(value)||Math.abs(value)>3.4028234663852886e38))throw new MemoryCipherError();
   return{...result,vector:[...result.vector]};
  }finally{service.cache.clear();result?.vector.fill(0);}
 }
 return Object.freeze({query:(text:string)=>embed(text,true),document:(text:string)=>embed(text,false),close(){closed=true;}});
}
