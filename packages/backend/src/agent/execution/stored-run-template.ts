/** One canonical stored template for owner review and scheduler execution. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {contractPrompt,type TaskContract} from '../../services/task-contracts.js';
import {assertMemoryFilesystemAccess,assertProtectedMemoryFileDescriptor,closeProtectedMemoryFileDescriptor} from '../../memory/encryption/protected-filesystem.js';
import {MemoryCipherError} from '../../memory/encryption/envelope.js';
function fail():never{throw new MemoryCipherError();}
export function storedTaskPrompt(task:{title:string;description:string;input?:Record<string,unknown>},contract:TaskContract|null){
 let prompt=`${task.title}\n\n${task.description}`;if(task.input?._upstream&&typeof task.input._upstream==='object')prompt+=`\n\n## Results from Previous Tasks (Pipeline Input)\n\`\`\`json\n${JSON.stringify(task.input._upstream,null,2)}\n\`\`\`\nUse these results as context for your work.`;
 if(contract)prompt+=`\n${contractPrompt(contract)}`;if(Buffer.byteLength(prompt)>512*1024)fail();return prompt;
}
export function captureStoredHeartbeatTemplate(agentName:string,workspace=process.cwd()){
 if(!agentName||path.basename(agentName)!==agentName||agentName.includes('\\')||!path.isAbsolute(workspace)||fs.realpathSync(workspace)!==workspace)fail();
 const candidates=[path.join(workspace,`HEARTBEAT-${agentName}.md`),path.join(workspace,'HEARTBEAT.md')];
 const read=()=>{for(const file of candidates){assertMemoryFilesystemAccess(file);let fd:number|undefined;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);assertProtectedMemoryFileDescriptor(fd);const before=fs.fstatSync(fd),entry=fs.lstatSync(file);if(!before.isFile()||entry.isSymbolicLink()||before.nlink!==1||before.dev!==entry.dev||before.ino!==entry.ino||before.size>128*1024)fail();const bytes=Buffer.alloc(before.size+1);let used=0;while(used<bytes.length){const count=fs.readSync(fd,bytes,used,bytes.length-used,used);if(!count)break;used+=count;}const after=fs.fstatSync(fd),named=fs.lstatSync(file);if(used!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||named.dev!==before.dev||named.ino!==before.ino)fail();const text=bytes.subarray(0,used).toString('utf8').trim();bytes.fill(0);if(!text.replace(/^#+\s.*$/gm,'').trim())continue;return{file,text,hash:createHash('sha256').update(text).digest('hex')};}catch(error:any){if(error?.code==='ENOENT')continue;throw error;}finally{if(fd!==undefined)closeProtectedMemoryFileDescriptor(fd,()=>fs.closeSync(fd!));}}fail();};
 const original=read(),prompt=`Read the HEARTBEAT.md checklist below. Follow it strictly. Do not infer or repeat old tasks from prior context. If nothing needs attention, reply with exactly: HEARTBEAT_OK\n\n## HEARTBEAT.md\n${original.text}`;
 return Object.freeze({prompt,hash:original.hash,isCurrent:()=>{try{const next=read();return next.file===original.file&&next.hash===original.hash;}catch{return false;}}});
}
