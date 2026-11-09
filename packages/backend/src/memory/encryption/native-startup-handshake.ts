/** Private parent startup plan, obtained before configuration or any database initializer. */
import {createRequire} from 'node:module';
const C=createRequire(import.meta.url)('../../../../identity/src/memory-native-proof.cjs');
let consumed=false;
export async function receiveNativeStartupPlan(){
 if(consumed)throw C.error();consumed=true;if(typeof process.send!=='function')return null;if(!process.connected)throw C.error();
 return new Promise<any>((resolve,reject)=>{
  const cleanup=()=>{clearTimeout(timer);process.off('message',message);process.off('disconnect',disconnect);};
  const disconnect=()=>{cleanup();reject(C.error());};
  const message=(raw:any)=>{if(raw?.type!=='memory-control-bootstrap')return;try{C.exact(raw,['v','type','plan']);if(raw.v!==1)throw C.error();C.exact(raw.plan,['control','selection']);C.exact(raw.plan.selection,['selected','profileId','mode']);const selected=raw.plan.selection;if(!['active','pending','none'].includes(selected.mode)||selected.selected!==(selected.mode!=='none'))throw C.error();if(typeof selected.selected!=='boolean'||selected.selected&&(typeof selected.profileId!=='string'||!selected.profileId)||!selected.selected&&selected.profileId!==null)throw C.error();if(raw.plan.control===null&&selected.selected)throw C.error();cleanup();resolve(raw.plan);}catch{cleanup();reject(C.error());}};
  const timer=setTimeout(()=>{cleanup();reject(C.error());},30000);process.on('message',message);process.once('disconnect',disconnect);process.send!({v:1,type:'memory-control-ready'},error=>{if(error){cleanup();reject(C.error());}});
 });
}
