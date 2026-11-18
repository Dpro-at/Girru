import {initializeStoredRunBindingsStep} from './stored-run-binding.js';
/** Opens only the immutable native-created control target on this SAME Node connection. */
import {registerProtectedMemoryFilesystem,registerProtectedMemoryDatabaseFile,bindProtectedMemoryDatabaseCloser,installProtectedMemoryDescriptorPoison,afterQuarantinedMemoryDescriptors,assertNoPendingMemoryDatabaseDescriptors} from './protected-filesystem.js';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {getDatabase,closeDatabase} from '../../db/database.js';
import {sqliteStepsOn} from '../../repositories/sql-steps.js';
import {createSelectedOperationCoordinator} from './selected-operation-coordinator.js';
import {bindSqliteControlFence,sqliteControlConnectionIdentity} from '../../db/sqlite-control-fence.js';
import {isolateNewControlMemorySinks} from './control-content-isolation.js';
const C=createRequire(import.meta.url)('../../../../identity/src/memory-native-proof.cjs');
function fail():never{throw C.error();}
/** Metadata comes exclusively from the authenticated parent process bootstrap, never environment/HTTP. */
export async function openNativeControlBootstrap(input:{bootstrap:any;parentIsCurrent:()=>boolean;onPoison:()=>void}){
 const b=input.bootstrap;C.exact(b,['v','type','launchId','control','capsulePath','macKey']);if(b.v!==1||b.type!=='native-control-bootstrap'||typeof input.parentIsCurrent!=='function'||typeof input.onPoison!=='function')fail();C.opaque(b.launchId);const key=Buffer.from(C.opaque(b.macKey),'base64url'),control=b.control;
 C.exact(control,['v','purpose','controlId','storageId','root','database','rootIdentity','fileIdentity']);if(control.v!==1||control.purpose!=='new-native-control'||!path.isAbsolute(control.root)||path.resolve(control.root)!==control.root||control.database!==path.join(control.root,'agent-player.db'))fail();C.text(control.controlId);C.text(control.storageId);
 let closed=false,fd:number|undefined,manager:ReturnType<typeof getDatabase>|undefined,coordinator:ReturnType<typeof createSelectedOperationCoordinator>|undefined;
 const same=(a:any,b:any)=>C.canonical(a)===C.canonical(b);
 function capsule(value:any){C.exact(value,['v','purpose','launchId','serial','state','control','cipherFiles','fingerprints','directoryProofs']);if(value.v!==1||value.purpose!=='native-control-lease'||value.launchId!==b.launchId||value.serial!==1||value.state!=='active'||!same(value.control,control))fail();const files=C.cipherFiles(value.cipherFiles);if(files.length!==2||files.map((f:any)=>f.id).sort().join()!=='control-receipt,control-witness'||files.some((f:any)=>f.path===control.database||f.optional))fail();C.verifyDirectories(value.directoryProofs);if(!same(C.fingerprintNativeFiles(files,value.fingerprints),value.fingerprints))fail();return value;}
 const getUid=process.getuid;
 function physical(){try{if(closed||fd===undefined||!input.parentIsCurrent())return false;C.openSigned(C.readProtectedFile(b.capsulePath,C.MAX_WIRE).bytes,key,capsule);const named=fs.lstatSync(control.database,{bigint:true}),held=fs.fstatSync(fd,{bigint:true}),root=fs.lstatSync(control.root,{bigint:true});return !named.isSymbolicLink()&&named.isFile()&&named.nlink===1n&&fs.realpathSync(control.database)===control.database&&String(named.dev)+':'+String(named.ino)===control.fileIdentity&&named.dev===held.dev&&named.ino===held.ino&&root.isDirectory()&&!root.isSymbolicLink()&&String(root.dev)+':'+String(root.ino)===control.rootIdentity&&fs.realpathSync(control.root)===control.root&&(process.platform==='win32'||typeof getUid==='function'&&named.uid===BigInt(getUid())&&root.uid===BigInt(getUid())&&(named.mode&0o077n)===0n&&(root.mode&0o077n)===0n);}catch{return false;}}
 try{
  // This identity descriptor stays open until AFTER SQLite closes. Never read the DB with fs.
  C.openSigned(C.readProtectedFile(b.capsulePath,C.MAX_WIRE).bytes,key,capsule);const beforeFile=fs.lstatSync(control.database,{bigint:true}),beforeRoot=fs.lstatSync(control.root,{bigint:true});if(beforeFile.isSymbolicLink()||!beforeFile.isFile()||beforeFile.nlink!==1n||String(beforeFile.dev)+':'+String(beforeFile.ino)!==control.fileIdentity||beforeRoot.isSymbolicLink()||!beforeRoot.isDirectory()||String(beforeRoot.dev)+':'+String(beforeRoot.ino)!==control.rootIdentity||fs.realpathSync(control.root)!==control.root||fs.realpathSync(control.database)!==control.database)fail();
  assertNoPendingMemoryDatabaseDescriptors(control.database);
  fd=fs.openSync(control.database,fs.constants.O_RDWR|(fs.constants.O_NOFOLLOW??0));if(!physical())fail();const candidate=getDatabase({path:control.database}),db=candidate.getDb();if(sqliteControlConnectionIdentity(db).file!==control.database)fail();manager=candidate;db.pragma('journal_mode = DELETE');db.pragma('locking_mode = EXCLUSIVE');db.exec('BEGIN EXCLUSIVE; COMMIT');if(!physical()||sqliteControlConnectionIdentity(db).lockingMode!=='exclusive')fail();
  await manager.initialize();if(!physical())fail();const raw=sqliteStepsOn(db),lease={kind:'new-app-owned-control' as const,profileId:control.controlId,storageId:control.storageId,isCurrent:physical};await raw.tx(()=>initializeStoredRunBindingsStep());const isolation=await isolateNewControlMemorySinks({runner:raw,lease});
  coordinator=createSelectedOperationCoordinator({runner:raw,launchId:b.launchId,onPoison:input.onPoison});const currentCoordinator=coordinator;
  const fence=bindSqliteControlFence(db,{...lease,file:control.database,canExecute:currentCoordinator.canExecute,trackIterator:currentCoordinator.trackIterator,runEffect:currentCoordinator.runEffect});
  installProtectedMemoryDescriptorPoison({isCurrent:physical,poison:()=>{currentCoordinator.close();input.onPoison();}});
  registerProtectedMemoryDatabaseFile({file:control.database,isCurrent:physical});
  bindProtectedMemoryDatabaseCloser({file:control.database,isCurrent:physical,isClosed:()=>!db.open,revokeAndClose:()=>{closed=true;currentCoordinator.close();input.onPoison();closeDatabase();const identity=fd;fd=undefined;afterQuarantinedMemoryDescriptors(control.database,()=>{if(identity!==undefined)fs.closeSync(identity);});key.fill(0);}});
  registerProtectedMemoryFilesystem({purpose:'native-owned-control',roots:[control.root,...C.openSigned(C.readProtectedFile(b.capsulePath,C.MAX_WIRE).bytes,key,capsule).directoryProofs.map((directory:any)=>directory.path)],isCurrent:physical});
  return Object.freeze({manager,coordinator:currentCoordinator,runner:currentCoordinator.runner,lease:fence,isolation,captureControlFence:async()=>{if(!physical()||!fence.isCurrent())fail();return fence;},async close(){if(closed)return;closed=true;currentCoordinator.close();try{closeDatabase();}finally{const identity=fd;fd=undefined;const done=afterQuarantinedMemoryDescriptors(control.database,()=>{if(identity!==undefined)fs.closeSync(identity);});key.fill(0);await done;}}});
 }catch(error){closed=true;coordinator?.close();try{if(manager)closeDatabase();}finally{if(fd!==undefined&&(!manager||!manager.getDb().open)){fs.closeSync(fd);fd=undefined;}else if(fd!==undefined)input.onPoison();key.fill(0);}throw error;}
}
