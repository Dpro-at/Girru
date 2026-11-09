/** Denial-only reservation before load-env can apply a legacy raw restore. It cannot open/enroll a database. */
import {createRequire} from 'node:module';
import {registerProtectedMemoryFilesystem} from './protected-filesystem.js';
const C=createRequire(import.meta.url)('../../../../identity/src/memory-native-proof.cjs');
export function reserveNativeStartupExclusions(bootstrap:any){
 C.exact(bootstrap,['v','type','launchId','control','capsulePath','macKey']);if(bootstrap.v!==1||bootstrap.type!=='native-control-bootstrap'||!process.connected)throw C.error();C.opaque(bootstrap.launchId);const key=Buffer.from(C.opaque(bootstrap.macKey),'base64url');let released=false;
 function verify(value:any){C.exact(value,['v','purpose','launchId','serial','state','control','cipherFiles','fingerprints','directoryProofs']);if(value.v!==1||value.purpose!=='native-control-lease'||value.launchId!==bootstrap.launchId||value.serial!==1||value.state!=='active'||C.canonical(value.control)!==C.canonical(bootstrap.control))throw C.error();const files=C.cipherFiles(value.cipherFiles);if(files.length!==2||files.some((file:any)=>file.path===bootstrap.control.database||file.optional)||files.map((file:any)=>file.id).sort().join()!=='control-receipt,control-witness')throw C.error();C.verifyDirectories(value.directoryProofs);if(C.canonical(C.fingerprintNativeFiles(files,value.fingerprints))!==C.canonical(value.fingerprints))throw C.error();return value;}
 function capture(){if(released||!process.connected)throw C.error();return C.openSigned(C.readProtectedFile(bootstrap.capsulePath,C.MAX_WIRE).bytes,key,verify);}
 try{const proof=capture();registerProtectedMemoryFilesystem({purpose:'native-owned-control',roots:[bootstrap.control.root,...proof.directoryProofs.map((entry:any)=>entry.path)],isCurrent:()=>{try{capture();return true;}catch{return false;}}});return Object.freeze({release(){released=true;key.fill(0);}});}catch(error){released=true;key.fill(0);throw error;}
}
