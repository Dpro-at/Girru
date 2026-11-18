/** Explicit selected-copy bridge assembly. No global database, install-token discovery or automatic enrollment. */
import {createSelectedEncryptedBridgePolicy} from './bridge-policy.js';
import {createEncryptedMemoryBridgeAdapter} from './bridge-adapter.js';
import type {createEncryptedMemoryRuntime} from './runtime-host.js';
import type {createMemoryUnlockSession} from './unlock-session.js';
import {MemoryCipherError} from './envelope.js';
type SelectedHost={runtime:ReturnType<typeof createEncryptedMemoryRuntime>;session:ReturnType<typeof createMemoryUnlockSession>};
type PolicyInput=Parameters<typeof createSelectedEncryptedBridgePolicy>[0];
type IssueSession=NonNullable<Parameters<typeof createEncryptedMemoryBridgeAdapter>[0]['issueSession']>;
export function createSelectedEncryptedMemoryBridgeHost(input:{host:SelectedHost;runner:PolicyInput['runner'];verifyInstallToken:PolicyInput['verifyInstallToken'];authorizeProject:PolicyInput['authorizeProject'];issueSession:IssueSession}){
 const {host,runner,verifyInstallToken,authorizeProject,issueSession}=input;
 if(!host?.runtime||typeof issueSession!=='function')throw new MemoryCipherError();
 let closed=false;const ownerId=host.runtime.ownerId;
 const policy=createSelectedEncryptedBridgePolicy({runner,ownerId,verifyInstallToken,authorizeProject});
 const boundary=()=>{if(closed||host.runtime.status()!=='ready'||!host.session.isUnlocked()||host.runtime.ownerId!==ownerId)throw new MemoryCipherError();};
 const adapter=createEncryptedMemoryBridgeAdapter({runtime:host.runtime,
  async issueSession(request){boundary();const result=await issueSession(request);boundary();return result;},
  async authorizeCall(request){boundary();const authorized=await policy.authorizeCall(request);boundary();const current=authorized.isCurrent.bind(authorized),validate=authorized.validateCurrent.bind(authorized);return{...authorized,isCurrent:()=>!closed&&host.session.isUnlocked()&&current(),async validateCurrent(){boundary();const valid=await validate();boundary();return valid;}};}
 });
 return Object.freeze({bridge:Object.freeze({async openSession(request:Parameters<typeof adapter.openSession>[0]){boundary();const result=await adapter.openSession(request);boundary();return result;},async call(request:Parameters<typeof adapter.call>[0]){boundary();const result=await adapter.call(request);boundary();return result;}}),close(){closed=true;policy.close();}});
}
