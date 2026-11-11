/** Metadata-only witness POST. DNS answers are checked once and the socket is pinned to that address. */
import http from 'node:http';
import https from 'node:https';
import {isIP} from 'node:net';
import {checkUrl,resolvePublicAddress,type LookupFn} from '../services/net/safe-fetch.js';
const LIMIT=16000;
const loopbackDestinations=new WeakSet<URL>();
export function witnessDestination(raw:string,disposableLoopback=false):URL {
 const url=new URL(raw);
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/v1/device-anchor')throw Error('computer_witness_url_invalid');
 if(disposableLoopback&&process.env.NODE_ENV==='test'&&url.protocol==='http:'&&url.hostname==='127.0.0.1'){loopbackDestinations.add(url);return url;}
 return checkUrl(raw,[url.hostname]);
}
/** Pure policy helper; injected DNS does not bypass address validation. */
export async function resolveWitnessDestination(url:URL,lookup?:LookupFn){
 if(loopbackDestinations.has(url)&&url.protocol==='http:'&&process.env.NODE_ENV==='test'&&url.hostname==='127.0.0.1')return {address:'127.0.0.1',family:4};
 const checked=checkUrl(url.href,[url.hostname]);
 const resolved=await resolvePublicAddress(checked.hostname,lookup);
 if(isIP(resolved.address)!==resolved.family)throw Error('computer_witness_dns_invalid');
 return resolved;
}
export async function postWitness(input:URL,body:string,lookup?:LookupFn):Promise<unknown>{
 const url=witnessDestination(input.href,loopbackDestinations.has(input));
 if(Buffer.byteLength(body)>LIMIT)throw Error('computer_witness_request_bound');
 // The deadline covers DNS and the entire response, including trickled bodies.
 let timer:ReturnType<typeof setTimeout>|undefined;
 let request:http.ClientRequest|undefined;let expired=false;
 const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;request?.destroy();reject(Error('computer_witness_timeout'));},8000);});
 try{return await Promise.race([timeout,(async()=>{
  const target=await resolveWitnessDestination(url,lookup);
  if(expired)throw Error('computer_witness_timeout');
  return await new Promise<unknown>((resolve,reject)=>{
   const transport=url.protocol==='https:'?https:http;
   request=transport.request({protocol:url.protocol,hostname:url.hostname,port:url.port||undefined,path:'/v1/device-anchor',method:'POST',agent:false,
    lookup:(_host,options,callback)=>{if(options.all)callback(null,[target]);else callback(null,target.address,target.family);},
    headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'Accept':'application/json'}},response=>{
    const length=response.headers['content-length'];
    if(!response.statusCode||response.statusCode<200||response.statusCode>=300||response.headers['content-type']?.split(';')[0]?.trim().toLowerCase()!=='application/json'||length!==undefined&&(!/^\d+$/.test(length)||Number(length)>LIMIT)){
     response.destroy();reject(Error('computer_witness_unavailable'));return;
    }
    let size=0;const chunks:Buffer[]=[];
    response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>LIMIT){response.destroy(Error('computer_witness_response_bound'));return;}chunks.push(chunk);});
    response.on('error',reject);response.on('aborted',()=>reject(Error('computer_witness_unavailable')));
    response.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(error){reject(error);}});
   });
   request.on('error',reject);request.end(body);
  });
 })()]);}finally{if(timer)clearTimeout(timer);}
}
