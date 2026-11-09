'use strict';
/** Main-process bridge. Store requires protected local custody plus an independent monotonic witness. */
function createMemoryTrustAdapters(store){
 if(!store||typeof store.capture!=='function'||typeof store.compareAndSwap!=='function'||typeof store.captureSlot!=='function')throw Error('memory_trust_unavailable');
 const copy=value=>JSON.parse(JSON.stringify(value));
 async function advance(field,expected,next){
  const prior=copy(expected),candidate=copy(next),captured=await store.capture();
  if(!captured.isCurrent()||JSON.stringify(captured.record[field])!==JSON.stringify(prior))throw Error('memory_trust_unavailable');
  const replacement={...copy(captured.record),revision:captured.record.revision+1,[field]:candidate};
  return await store.compareAndSwap(captured.record,replacement)===true;
 }
 return{
  async captureGenesis(){const captured=await store.captureSlot('genesis');return{anchor:copy(captured.value),isCurrent:captured.isCurrent};},
  async captureAuthority(){const captured=await store.captureSlot('restore');return{anchor:copy(captured.value),isCurrent:captured.isCurrent};},
  advanceAuthority:(expected,next)=>advance('restore',expected,next),
  auditCustody:{async capture(){const captured=await store.captureSlot('audit');return{head:copy(captured.value),isCurrent:captured.isCurrent};},advance:(expected,next)=>advance('audit',expected,next)},
 };
}
module.exports={createMemoryTrustAdapters};
