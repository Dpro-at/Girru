/** Private metadata lease. Atomic mkdir never replaces an existing (even empty) writer lock. */
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
function privateStat(s:fs.Stats,directory=false){if(directory?!s.isDirectory():!s.isFile()||s.nlink!==1)throw Error('private_metadata_identity_refused');if(process.platform!=='win32'&&(s.uid!==process.getuid!()||(s.mode&0o077)!==0))throw Error('private_metadata_permissions_refused');}
function same(a:fs.Stats,b:fs.Stats){return a.dev===b.dev&&a.ino===b.ino;}
export function readPrivateMetadata(file:string,maxBytes:number){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|fs.constants.O_NONBLOCK);
 try{const before=fs.fstatSync(fd);privateStat(before);if(before.size>maxBytes)throw Error('private_metadata_bound');const name=fs.lstatSync(file);if(name.isSymbolicLink()||!same(name,before))throw Error('private_metadata_replaced');
 const bytes=Buffer.alloc(maxBytes+1);let length=0;while(length<bytes.length){const n=fs.readSync(fd,bytes,length,bytes.length-length,null);if(!n)break;length+=n;}if(length>maxBytes)throw Error('private_metadata_bound');
 const after=fs.fstatSync(fd),current=fs.lstatSync(file);privateStat(after);if(current.isSymbolicLink()||!same(before,after)||!same(after,current)||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw Error('private_metadata_replaced');return bytes.subarray(0,length).toString('utf8');
 }finally{fs.closeSync(fd);}
}
export function acquirePrivateMetadataLease(root:string,name:string){
 const rootStat=fs.lstatSync(root);privateStat(rootStat,true);if(rootStat.isSymbolicLink()||fs.realpathSync(root)!==root)throw Error('private_metadata_root_refused');
 const lock=path.join(root,name);fs.mkdirSync(lock,{mode:0o700});
 const lockStat=fs.lstatSync(lock);privateStat(lockStat,true);
 const owner=path.join(lock,'owner'),text=JSON.stringify({pid:process.pid,nonce:randomUUID(),started:Date.now()});
 // On any initialization error retain the lock as evidence; never turn uncertainty into a new grant.
 const fd=fs.openSync(owner,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW??0),0o600);
 try{fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 let released=false;
 const assertCurrent=()=>{if(released)throw Error('private_metadata_lease_closed');const r=fs.lstatSync(root),l=fs.lstatSync(lock);privateStat(r,true);privateStat(l,true);if(r.isSymbolicLink()||l.isSymbolicLink()||!same(r,rootStat)||!same(l,lockStat)||fs.realpathSync(root)!==root||readPrivateMetadata(owner,4096)!==text)throw Error('private_metadata_lease_replaced');};
 assertCurrent();return {assertCurrent,release(){if(released)return;assertCurrent();fs.unlinkSync(owner);fs.rmdirSync(lock);released=true;}};
}
