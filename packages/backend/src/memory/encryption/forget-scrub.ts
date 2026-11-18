/** Internal encrypted cross-record scrub. Caller supplies authenticated source texts and audits every decrypt. */
import {decryptMemoryRow,encryptMemoryRow,type MemoryRowScope} from './row-codec.js';
import {renderDigest,type WeeklyDigest} from '../weekly-summary.js';
import {MemoryCipherError} from './envelope.js';
type Row=Record<string,unknown>;
export type ScrubTable='memories'|'memory_file_proposals'|'memory_weekly_summaries';
export function prepareEncryptedForgetScrub(table:ScrubTable,cipher:Row,id:string,texts:readonly string[],actor:string,at:string,scope:MemoryRowScope,key:Buffer,keyId:string,isCurrent:()=>boolean):Row|null{
 return prepareEncryptedForgetBatchScrub(table,cipher,[id],texts,actor,at,scope,key,keyId,isCurrent);
}
/** Decrypt and encrypt each surviving row once for the entire authenticated target set. */
export function prepareEncryptedForgetBatchScrub(table:ScrubTable,cipher:Row,ids:readonly string[],texts:readonly string[],actor:string,at:string,scope:MemoryRowScope,key:Buffer,keyId:string,isCurrent:()=>boolean):Row|null{
 try{
  if(!isCurrent()||!ids.length||ids.length>5000||ids.some(id=>typeof id!=='string'||!id||Buffer.byteLength(id)>256)||new Set(ids).size!==ids.length||!actor||actor.length>256||!Number.isFinite(Date.parse(at))||texts.length>5000||texts.some(t=>typeof t!=='string'||Buffer.byteLength(t)>1024*1024))throw new MemoryCipherError();
  const targets=new Set(ids);
  const row=decryptMemoryRow(table,cipher,scope,key,keyId),next={...row};
  const mentions=(v:unknown,terms:readonly string[])=>typeof v==='string'&&(ids.some(id=>v.includes(id))||terms.some(t=>t.length>=3&&v.includes(t)));
  if(table==='memory_file_proposals'){
   if(typeof row.changes!=='string')throw new MemoryCipherError();
   const changes=JSON.parse(row.changes);if(!Array.isArray(changes)||changes.length>1000)throw new MemoryCipherError();
   const lesson=typeof row.reasons==='string'&&ids.some(id=>(row.reasons as string).includes('lesson-from:'+id));
   let visited=0;const quotes=(value:unknown,depth=0):boolean=>{if(++visited>20000||depth>20)throw new MemoryCipherError();if(typeof value==='string')return texts.includes(value)||mentions(value,texts);if(value&&typeof value==='object')return Object.entries(value).some(([key,child])=>mentions(key,texts)||quotes(child,depth+1));return false;};
   let touched=false;
   next.changes=JSON.stringify(changes.map(c=>{if(!c||typeof c!=='object'||Array.isArray(c)||!['add','update','delete'].includes(c.op))throw new MemoryCipherError();const hit=lesson||targets.has(c.id)||quotes(c);if(!hit)return c;touched=true;return{op:c.op,...(c.id?{id:c.id}:{}),redacted:true};}));
   // Secondary text fields can quote the forgotten source too; discard only fields that match.
   for(const field of ['note','reasons','decision'])if(mentions(row[field],texts)){next[field]=null;touched=true;}
   if(typeof row.conflict_with==='string'&&targets.has(row.conflict_with)){next.conflict_with=null;touched=true;}
   if(!touched)return null;
   if(row.status==='pending'){next.status='cancelled';next.decided_by=actor;next.decided_at=at;next.note='cancelled: a memory it touched was forgotten';}
  }else if(table==='memory_weekly_summaries'){
   const previews=texts.map(t=>t.replace(/\s+/g,' ').trim().slice(0,60)).filter(t=>t.length>=3);
   if(!['digest','text','model_text'].some(f=>mentions(row[f],previews)))return null;
   if(typeof row.digest!=='string')throw new MemoryCipherError();const digest=JSON.parse(row.digest) as WeeklyDigest;
   if(!digest||digest.userId!==scope.ownerId||!Array.isArray(digest.drawers)||digest.drawers.length>1000||typeof digest.periodStart!=='string'||typeof digest.periodEnd!=='string'||!digest.totals)throw new MemoryCipherError();
   let count=0;for(const drawer of digest.drawers){if(!drawer||!Array.isArray(drawer.items)||(count+=drawer.items.length)>5000)throw new MemoryCipherError();drawer.items=drawer.items.filter(item=>{if(!item||typeof item!=='object')throw new MemoryCipherError();return !targets.has(item.memoryId)&&!previews.some(p=>typeof item.preview==='string'&&item.preview.includes(p));});}
   next.digest=JSON.stringify(digest);next.text=renderDigest(digest);next.model_text=null;next.model=null;
  }
  if(table==='memories'){
   if(row.related_memory_ids===null)return null;
   if(typeof row.related_memory_ids!=='string')throw new MemoryCipherError();const related=JSON.parse(row.related_memory_ids);
   if(!Array.isArray(related)||related.length>5000||related.some(v=>typeof v!=='string'||Buffer.byteLength(v)>256))throw new MemoryCipherError();
   if(!related.some(v=>targets.has(v)))return null;next.related_memory_ids=JSON.stringify(related.filter(v=>!targets.has(v)));
  }
  if(!isCurrent())throw new MemoryCipherError();const result=encryptMemoryRow(table,next,scope,key,keyId);if(!isCurrent())throw new MemoryCipherError();return result;
 }catch{throw new MemoryCipherError();}
}
