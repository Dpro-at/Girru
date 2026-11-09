/** Journal-bound internal operations. Required custody adapter never comes from restored data. */
import {createEncryptedMemoryOperationsHost} from './memory-operations-host.js';
import {createMemoryForgetAuthorityStore} from './forget-authority-store.js';
import {MemoryCipherError} from './envelope.js';
export function createAuthorityBoundMemoryOperationsHost(input:Omit<Parameters<typeof createEncryptedMemoryOperationsHost>[0],'recordForgetAuthority'>&{authority:ReturnType<typeof createMemoryForgetAuthorityStore>}){
 const {authority,...services}=input;if(!authority||typeof authority.appendRange!=='function'||typeof authority.capture!=='function')throw new MemoryCipherError();
 const host=createEncryptedMemoryOperationsHost({...services,recordForgetAuthority:async ids=>{
  const lease=services.session.capture(),captured=await authority.capture();if(!lease.isCurrent()||!captured.isCurrent()||captured.anchor.ownerId!==lease.scope.ownerId||captured.anchor.memberId!==lease.scope.memberId)throw new MemoryCipherError();
  // Commit the exact canonical multi-event range once, then advance native authority once.
  const canonical=[...ids].sort();if(!canonical.length||canonical.length>5000||new Set(canonical).size!==canonical.length)throw new MemoryCipherError();
  const changes:{kind:'forget';ids:string[]}[]=[];for(let i=0;i<canonical.length;i+=500)changes.push({kind:'forget',ids:canonical.slice(i,i+500)});
  const next=await authority.appendRange(changes);if(!lease.isCurrent()||next.ownerId!==lease.scope.ownerId||next.memberId!==lease.scope.memberId)throw new MemoryCipherError();
  const fresh=await authority.capture();if(!lease.isCurrent()||!fresh.isCurrent())throw new MemoryCipherError();return true;
 }});
 return{
  ...host,
  async start(){try{if(authority.status()==='new')await authority.initialize();const lease=services.session.capture(),current=await authority.capture();if(!lease.isCurrent()||!current.isCurrent()||current.anchor.ownerId!==lease.scope.ownerId||current.anchor.memberId!==lease.scope.memberId)throw new MemoryCipherError();return await host.start();}catch{services.session.lock();authority.close();throw new MemoryCipherError();}},
  async stop(){try{await host.stop();}finally{authority.close();}},
 };
}
