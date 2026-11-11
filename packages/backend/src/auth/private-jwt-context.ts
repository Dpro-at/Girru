/** Private owned-child signing context. Never installs a process-global key or environment fallback. */
import {AsyncLocalStorage} from 'node:async_hooks';
const context=new AsyncLocalStorage<{key:Buffer;isCurrent:()=>boolean;closed:()=>boolean}>();
const refused=()=>new Error('private_auth_unavailable');
export function privateJwtKey():Buffer|undefined{
 const current=context.getStore();if(!current)return undefined;
 if(current.closed()||current.isCurrent()!==true)throw refused();return current.key;
}
export function createPrivateJwtContext(input:{key:Buffer;isCurrent:()=>boolean}){
 if(!Buffer.isBuffer(input.key)||input.key.length<32||input.key.length>128||typeof input.isCurrent!=='function'||!input.isCurrent())throw refused();
 const key=Buffer.from(input.key);let closed=false;const current=()=>!closed&&input.isCurrent()===true;
 const scope={key,isCurrent:current,closed:()=>closed};
 return Object.freeze({
  run<T>(operation:()=>T):T{if(!current()||context.getStore())throw refused();return context.run(scope,operation);},
  isCurrent:current,
  close(){closed=true;key.fill(0);},
 });
}
