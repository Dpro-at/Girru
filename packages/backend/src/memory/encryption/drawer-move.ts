/** Inactive move preparation. Source and destination authorizers must be captured independently. */
import {normalizeDrawer,type DrawerRef} from '../drawers.js';
import {decryptMemoryRow,encryptMemoryRow,type MemoryRowScope} from './row-codec.js';
import {MemoryCipherError} from './envelope.js';
export function prepareEncryptedDrawerMove(cipher:Record<string,unknown>,target:DrawerRef,scope:MemoryRowScope,key:Buffer,keyId:string,authorizeSource:(row:Readonly<Record<string,unknown>>)=>boolean,authorizeDestination:(row:Readonly<Record<string,unknown>>)=>boolean){
 try{
  const drawer=normalizeDrawer(target);
  if(authorizeSource(cipher)!==true)throw new MemoryCipherError();
  const plain=decryptMemoryRow('memories',cipher,scope,key,keyId);
  if((plain.status??'active')!=='active'||authorizeSource(plain)!==true)throw new MemoryCipherError();
  const moved={...plain,drawer_kind:drawer.kind,drawer_key:drawer.key??''};
  if(authorizeDestination(moved)!==true)throw new MemoryCipherError();
  return encryptMemoryRow('memories',moved,scope,key,keyId);
 }catch{throw new MemoryCipherError();}
}
