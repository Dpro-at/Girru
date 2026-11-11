'use strict';
// Only immutable, public renderer bytes from an installed Store package are served here.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
function read(file,max){const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0));try{
 const st=fs.fstatSync(fd),entry=fs.lstatSync(file);if(!st.isFile()||entry.isSymbolicLink()||entry.dev!==st.dev||entry.ino!==st.ino||st.size>max)throw Error('Invalid app asset.');
 const data=Buffer.alloc(Math.min(st.size+1,max+1));let used=0;while(used<data.length){const n=fs.readSync(fd,data,used,data.length-used,used);if(!n)break;used+=n;}if(used>max)throw Error('Invalid app asset.');return data.subarray(0,used);
 }finally{fs.closeSync(fd);}}
function storeAppAsset(url,{dataDir=process.env.AGENT_PLAYER_DATA_DIR||path.join(process.cwd(),'.data')}={}){
 const u=new URL(url,'http://127.0.0.1');const match=/^\/store-apps\/(trading)\/(client\.(?:js|css))$/.exec(u.pathname);if(!match)return null;
 if([...u.searchParams.keys()].some(k=>k!=='v')||u.searchParams.getAll('v').length>1)return {status:400};
 try{const id=match[1],file=match[2],override=process.env.GIRRU_TRADING_APP_DIR,root=override&&path.isAbsolute(override)?override:path.join(path.resolve(dataDir),'apps',id);
  const marker=JSON.parse(read(path.join(root,'.girru-store.json'),128*1024).toString('utf8'));if(marker.source!=='store'||marker.id!==id||!/^[a-f0-9]{64}$/.test(marker.packageSha256))throw Error('Invalid app receipt.');
  const spec=Array.isArray(marker.files)&&marker.files.find(x=>x.path===file);if(!spec||!/^[a-f0-9]{64}$/.test(spec.sha256)||!Number.isSafeInteger(spec.size)||spec.size<1||spec.size>4*1024*1024)throw Error('Missing app asset.');
  const version=u.searchParams.get('v');if(version&&version!==spec.sha256)return {status:409};
  const data=read(path.join(root,file),4*1024*1024);if(data.length!==spec.size||createHash('sha256').update(data).digest('hex')!==spec.sha256)throw Error('App asset integrity mismatch.');
  return {status:200,data,type:file.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8'};
 }catch{return {status:404};}
}
module.exports={storeAppAsset};
