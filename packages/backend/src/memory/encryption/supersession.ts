/** Inactive supersession preparation. New-row persistence, claims/history and old reseal must commit together. */
import {decryptMemoryRow,encryptMemoryRow,type MemoryRowScope} from './row-codec.js';
import {normalizeDrawer,defaultDrawerForType,sameDrawer} from '../drawers.js';
import {MemoryCipherError} from './envelope.js';
export function prepareEncryptedSupersession(olderCipher:Record<string,unknown>,newerCipher:Record<string,unknown>,scope:MemoryRowScope,key:Buffer,keyId:string,authorizeOlder:(row:Readonly<Record<string,unknown>>)=>boolean,authorizeNewer:(row:Readonly<Record<string,unknown>>)=>boolean,at=new Date().toISOString()){
 try{
  if(!Number.isFinite(Date.parse(at))||new Date(at).toISOString()!==at||authorizeOlder(olderCipher)!==true||authorizeNewer(newerCipher)!==true)throw new MemoryCipherError();
  const older=decryptMemoryRow('memories',olderCipher,scope,key,keyId),newer=decryptMemoryRow('memories',newerCipher,scope,key,keyId);
  if(older.id===newer.id||(older.status??'active')!=='active'||(newer.status??'active')!=='active'||typeof older.content!=='string'||typeof newer.content!=='string'||!newer.content.trim()||authorizeOlder(older)!==true||authorizeNewer(newer)!==true)throw new MemoryCipherError();
  const drawer=(row:Record<string,unknown>)=>row.drawer_kind==null?defaultDrawerForType(typeof row.type==='string'?row.type:undefined):normalizeDrawer({kind:row.drawer_kind,key:row.drawer_key??''});
  if(!sameDrawer(drawer(older),drawer(newer)))throw new MemoryCipherError();
  return encryptMemoryRow('memories',{...older,status:'replaced',valid_to:at,superseded_by:newer.id},scope,key,keyId);
 }catch{throw new MemoryCipherError();}
}
