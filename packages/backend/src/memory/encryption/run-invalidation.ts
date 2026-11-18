/** Same-process revocation of captured model inputs after a real scope/access transition. */
const revokers=new Map<string,Set<()=>void>>();
export function registerEncryptedRunInvalidation(ownerId:string,revoke:()=>void):()=>void{if(!ownerId||typeof revoke!=='function')throw Error('invalid_run_revocation');let entries=revokers.get(ownerId);if(!entries){entries=new Set();revokers.set(ownerId,entries);}entries.add(revoke);return()=>{entries!.delete(revoke);if(!entries!.size)revokers.delete(ownerId);};}
export function invalidateEncryptedRunAdmissions(ownerId?:string):void{if(ownerId!==undefined){for(const revoke of [...(revokers.get(ownerId)??[])])revoke();return;}for(const entries of [...revokers.values()])for(const revoke of [...entries])revoke();}
