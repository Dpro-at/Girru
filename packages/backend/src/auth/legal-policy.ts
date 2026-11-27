import {createHash} from 'node:crypto';
import {q} from '../repositories/sql-steps.js';
const ORIGIN='https://girru.dev';
const VERSION=/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export interface LegalAcceptance {accepted:true;version:string;contentSha256:string}
export interface LegalReceipt {version:string;contentSha256:string;effectiveAt:string;locale:'en';termsUrl:string;privacyUrl:string;acceptedAt:string}
export interface LegalPolicy {version:string;contentSha256:string;effectiveAt:string;locale:'en';termsUrl:string;privacyUrl:string;documents:{terms:LegalDocument;privacy:LegalDocument}}
interface LegalDocument {title:string;sections:{title:string;paragraphs:string[]}[]}
export interface LegalPolicies {load():Promise<LegalPolicy>;accept(value:unknown):Promise<LegalReceipt>}
export class PublishedLegalPolicies implements LegalPolicies {
 constructor(private fetcher:typeof fetch=fetch){}
 async load():Promise<LegalPolicy>{
  const signal=AbortSignal.timeout(15000);
  const get=async(path:string)=>{
   const response=await this.fetcher(ORIGIN+path,{headers:{Accept:'application/json'},redirect:'error',cache:'no-store',signal});
   if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))throw Error('google_policy_unavailable');
   const reader=response.body?.getReader();if(!reader)throw Error('google_policy_unavailable');let size=0;const parts:Uint8Array[]=[];
   try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>524288)throw Error('google_policy_unavailable');parts.push(value);}}finally{await reader.cancel().catch(()=>undefined);}
   return JSON.parse(Buffer.concat(parts).toString('utf8'));
  };
  try{
   const manifest=await get('/legal/policy.json');
   if(manifest?.schema!==1||manifest.product!=='Girru'||manifest.locale!=='en'||manifest.status!=='approved'||typeof manifest.version!=='string'||!VERSION.test(manifest.version)||!/^\d{4}-\d{2}-\d{2}$/.test(manifest.effectiveAt)||!Number.isFinite(Date.parse(manifest.effectiveAt))||Date.parse(manifest.effectiveAt)>Date.now())throw Error('google_policy_unavailable');
   for(const [key,path]of Object.entries({termsUrl:'/terms/',privacyUrl:'/privacy/',imprintUrl:'/imprint/',accessibilityUrl:'/accessibility/',contentUrl:'/legal/content.json'}))if(manifest[key]!==ORIGIN+path)throw Error('google_policy_unavailable');
   const content=await get('/legal/content.json');
   if(content?.schema!==1||content.product!=='Girru'||content.locale!=='en'||content.status!=='approved'||content.version!==manifest.version)throw Error('google_policy_changed');
   for(const key of ['terms','privacy']){
    const doc=content.documents?.[key];
    if(doc?.status!=='approved'||typeof doc.title!=='string'||!doc.title.trim()||!Array.isArray(doc.sections)||!doc.sections.length||doc.sections.length>200)throw Error('google_policy_unavailable');
    for(const section of doc.sections)if(typeof section.title!=='string'||!section.title.trim()||!Array.isArray(section.paragraphs)||!section.paragraphs.length||section.paragraphs.length>100||section.paragraphs.some((p:unknown)=>typeof p!=='string'||!p.trim()||p.length>20000))throw Error('google_policy_unavailable');
   }
   const hash=createHash('sha256').update(JSON.stringify({terms:content.documents.terms,privacy:content.documents.privacy})).digest('hex');
   if(manifest.approval?.contentSha256!==hash)throw Error('google_policy_changed');
   const current=await get('/legal/policy.json');
   if(current.version!==manifest.version||current.status!=='approved'||current.approval?.contentSha256!==hash)throw Error('google_policy_changed');
   return {version:manifest.version,contentSha256:hash,effectiveAt:manifest.effectiveAt,locale:'en',termsUrl:manifest.termsUrl,privacyUrl:manifest.privacyUrl,documents:content.documents};
  }catch(error){throw Error(error instanceof Error&&/^google_policy_[a-z_]+$/.test(error.message)?error.message:'google_policy_unavailable');}
 }
 async accept(value:unknown):Promise<LegalReceipt>{
  const input=value as LegalAcceptance;
  if(!input||typeof input!=='object'||Object.keys(input).sort().join(',')!=='accepted,contentSha256,version'||input.accepted!==true||typeof input.version!=='string'||!VERSION.test(input.version)||! /^[a-f0-9]{64}$/.test(input.contentSha256))throw Error('google_policy_acceptance_required');
  const policy=await this.load();if(policy.version!==input.version||policy.contentSha256!==input.contentSha256)throw Error('google_policy_changed');
  const {documents,...receipt}=policy;return {...receipt,acceptedAt:new Date().toISOString()};
 }
}
export async function recordLegalAcceptance(userId:string,receipt:LegalReceipt){
 await q.run('INSERT INTO user_legal_acceptances(user_id,policy_version,content_sha256,locale,effective_at,accepted_at,terms_url,privacy_url) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,policy_version,content_sha256) DO NOTHING',userId,receipt.version,receipt.contentSha256,receipt.locale,receipt.effectiveAt,receipt.acceptedAt,receipt.termsUrl,receipt.privacyUrl);
}
