/**
 * Agent Files Service
 *
 * Manages per-agent PERSONALITY.md and MEMORY.md files
 * File-based storage for agent identity and learned patterns
 */

import { dataPath } from '../config/data-root.js';
import fs from 'fs/promises';
import path from 'path';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {readRegularFile} from './read-regular-file.js';
import {redactImportText} from '../memory/import/redact.js';

const AGENTS_DIR = dataPath('agents');

export interface AgentFiles {
  personality: string;
  memory: string;
  knowledgeFiles: string[];
}

/**
 * SECURITY: Sanitize path parameter to prevent directory traversal
 * @param param Path parameter (agentId or filename)
 * @returns Sanitized path component
 * @throws Error if parameter is invalid
 */
function sanitizePathParam(param: string): string {
  // Use path.basename to strip all directory components
  const sanitized = path.basename(param);

  // Reject empty, '.', or '..' after sanitization
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error('Invalid path parameter');
  }

  // Reject paths that still contain path separators (suspicious)
  if (sanitized.includes('/') || sanitized.includes('\\')) {
    throw new Error('Invalid path parameter');
  }

  return sanitized;
}

/**
 * Get agent directory path
 */
export const validAgentFileId=(id:unknown):id is string=>typeof id==='string'&&(/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/).test(id)&&!id.includes('..');
export function getAgentDir(agentId: string): string {
  if(!validAgentFileId(agentId))throw Error('Invalid agent id');
  return path.join(AGENTS_DIR, sanitizePathParam(agentId));
}

/**
 * Initialize agent directory structure
 */
export const MAX_PERSONALITY_BYTES = 1024 * 1024;

async function agentDirectory(dir:string,recursive=false):Promise<void>{
  try{await fs.mkdir(dir,{recursive,mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const stat=await fs.lstat(dir);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(process.platform!=='win32'&&((stat.mode&0o022)!==0||stat.uid!==process.getuid?.())))throw Error('Unsafe agent directory');
}
/** The agent's own folder, created safely (0700, no links); used by agent-file-library.ts too. */
export async function checkedAgentDirectory(agentId:string):Promise<string>{
  const dir=getAgentDir(agentId);
  await agentDirectory(AGENTS_DIR,true);
  await agentDirectory(dir);
  return dir;
}
async function regularAgentEntry(file:string):Promise<boolean>{
  try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw Error('Unsafe agent file');return true;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}
async function createAgentDefault(file:string,content:string):Promise<void>{
  let handle;
  try{handle=await fs.open(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await regularAgentEntry(file);return;}
  try{await handle.writeFile(content,'utf8');}finally{await handle.close();}
}
export async function initializeAgentDir(agentId: string): Promise<void> {
  const dir=await checkedAgentDirectory(agentId),knowledge=path.join(dir,'knowledge');
  await agentDirectory(knowledge);
  for(const name of ['docs','templates','data'])await agentDirectory(path.join(knowledge,name));
  await createAgentDefault(path.join(dir,'PERSONALITY.md'),getDefaultPersonality());
  await createAgentDefault(path.join(dir,'MEMORY.md'),getDefaultMemory());
}

/** Read only the fixed profile file; a bad entry is never replaced by defaults. */
export async function readPersonality(agentId: string): Promise<string> {
  const dir=await checkedAgentDirectory(agentId),file=path.join(dir,'PERSONALITY.md');
  try{const result=await readRegularFile(file,MAX_PERSONALITY_BYTES,{root:dir});if(result.stat.nlink!==1)throw Error('Unsafe agent file');return result.data.toString('utf8');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await initializeAgentDir(agentId);return getDefaultPersonality();}
}

/** Replace the fixed profile atomically. Never follow a caller-selected leaf or truncate a linked file. */
export async function writePersonality(agentId: string, content: string): Promise<void> {
  if(typeof content!=='string'||Buffer.byteLength(content,'utf8')>MAX_PERSONALITY_BYTES)throw Error('Invalid personality content');
  await initializeAgentDir(agentId);
  const dir=await checkedAgentDirectory(agentId),file=path.join(dir,'PERSONALITY.md');
  await regularAgentEntry(file);
  const temporary=path.join(dir,'.personality-'+randomUUID()+'.tmp');
  const handle=await fs.open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);
  try{
    await handle.writeFile(content,'utf8');await handle.sync();await handle.close();
    await checkedAgentDirectory(agentId);await regularAgentEntry(file);
    await fs.rename(temporary,file);
  }finally{await handle.close().catch(()=>{});await fs.unlink(temporary).catch(()=>{});}
}

/**
 * Read MEMORY.md for an agent
 */
const MEMORY_LIMIT=32768;
export interface MemorySnapshot {content:string;hash:string|null;truncated:boolean;redacted:boolean}
const digest=(content:Buffer|string)=>createHash('sha256').update(content).digest('hex');
function memoryDir(agentId:string){if(typeof agentId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(agentId)||agentId.includes('..'))throw Error('memory_unavailable');return path.join(AGENTS_DIR,agentId);}
async function checkDirectory(dir:string,create=false):Promise<boolean>{
 try{let info=await fs.lstat(dir);
  // Older installs made the agents folder 0755. Ours, a real folder and writable by no one else:
  // tighten it to 0700 (a forward repair). A folder others could write to is still refused.
  if(process.platform!=='win32'&&info.isDirectory()&&!info.isSymbolicLink()&&info.uid===process.getuid?.()&&(info.mode&0o022)===0&&(info.mode&0o077)!==0){await fs.chmod(dir,info.mode&0o700);info=await fs.lstat(dir);}
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw Error('memory_unavailable');return true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw Error('memory_unavailable');if(!create)return false;await fs.mkdir(dir,{mode:0o700});return checkDirectory(dir);}
}
async function checkedMemoryDir(agentId:string,create=false):Promise<string|null>{
 const dir=memoryDir(agentId);
 if(!await checkDirectory(AGENTS_DIR,create))return null;
 if(!await checkDirectory(dir,create))return null;
 return dir;
}
async function loadMemory(agentId:string):Promise<MemorySnapshot>{
 const dir=await checkedMemoryDir(agentId);if(!dir)return {content:getDefaultMemory(),hash:null,truncated:false,redacted:false};
 let handle;
 try{handle=await fs.open(path.join(dir,'MEMORY.md'),constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {content:getDefaultMemory(),hash:null,truncated:false,redacted:false};throw Error('memory_unavailable');}
 try{
  const info=await handle.stat();if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw Error('memory_unavailable');
  const bytes=Buffer.alloc(MEMORY_LIMIT+1);const {bytesRead}=await handle.read(bytes,0,bytes.length,0);let truncated=bytesRead>MEMORY_LIMIT||info.size>MEMORY_LIMIT;
  // Redaction cannot safely classify a secret whose closing boundary lies beyond the read cap.
  if(truncated)return {content:'[MEMORY CUT: oversized content withheld]',hash:null,truncated:true,redacted:false};
  const raw=bytes.subarray(0,Math.min(bytesRead,MEMORY_LIMIT));const text=new TextDecoder('utf-8',{fatal:true}).decode(raw,{stream:truncated});
  let clean=redactImportText(text).text;if(Buffer.byteLength(clean,'utf8')>MEMORY_LIMIT){clean=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(clean,'utf8').subarray(0,MEMORY_LIMIT),{stream:true});truncated=true;}
  const after=await handle.stat();if(info.ino!==after.ino||info.size!==after.size||info.mtimeMs!==after.mtimeMs)throw Error('memory_changed');
  await checkedMemoryDir(agentId);
  return {content:clean+(truncated?'\n\n[MEMORY CUT]':''),hash:truncated?null:digest(raw),truncated,redacted:clean!==text};
 }finally{await handle.close();}
}
export async function readMemorySnapshot(agentId:string):Promise<MemorySnapshot>{try{return await loadMemory(agentId);}catch{throw Error('memory_unavailable');}}
export async function readMemory(agentId:string):Promise<string>{return (await readMemorySnapshot(agentId)).content;}
async function syncDir(dir:string){const handle=await fs.open(dir,'r');try{await handle.sync();}finally{await handle.close();}}
/** Explicit expected-hash owner write; callers must enforce owner authentication and reviewed intent. */
export async function writeMemoryCAS(agentId:string,content:string,expectedHash:string|null):Promise<MemorySnapshot>{
 if(typeof content!=='string'||Buffer.byteLength(content,'utf8')>MEMORY_LIMIT||!(expectedHash===null||typeof expectedHash==='string'&&/^[a-f0-9]{64}$/.test(expectedHash)))throw Error('memory_write_invalid');
 const clean=redactImportText(content).text;if(Buffer.byteLength(clean,'utf8')>MEMORY_LIMIT)throw Error('memory_write_invalid');
 const dir=await checkedMemoryDir(agentId,true);if(!dir)throw Error('memory_unavailable');
 let lock;try{lock=await fs.open(path.join(dir,'.memory-lock'),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);}catch{throw Error('memory_conflict');}
 const temp=path.join(dir,'.memory-'+randomUUID()+'.tmp');
 try{
  const before=await readMemorySnapshot(agentId);if(before.truncated||before.hash!==expectedHash)throw Error('memory_conflict');
  const versions=path.join(dir,'.memory-versions');await checkDirectory(versions,true);
  const events=path.join(versions,'events');await checkDirectory(events,true);
  async function version(hash:string,value:string,previous:string|null){const target=path.join(versions,hash+'.json');let file;try{file=await fs.open(target,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST'){const existing=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=await existing.stat();if(!st.isFile()||st.nlink!==1||st.uid!==process.getuid?.()||(st.mode&0o077)!==0||st.size>262144)throw Error('memory_unavailable');const stored=JSON.parse(await existing.readFile('utf8'));if(stored.hash!==hash||stored.content!==value)throw Error('memory_unavailable');}finally{await existing.close();}return;}throw error;}try{await file.writeFile(JSON.stringify({hash,previousHash:previous,content:value}));await file.sync();}finally{await file.close();}}
  if(before.hash)await version(before.hash,before.content,null);
  await version(digest(clean),clean,before.hash);await syncDir(versions);
  const file=await fs.open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{await file.writeFile(clean,'utf8');await file.sync();}finally{await file.close();}
  const current=await readMemorySnapshot(agentId);if(current.truncated||current.hash!==expectedHash)throw Error('memory_conflict');
  await checkedMemoryDir(agentId);await fs.rename(temp,path.join(dir,'MEMORY.md'));await syncDir(dir);
  // Content snapshots may describe attempts. Unique post-rename events preserve repeated transitions.
  // Rename plus audit is not one atomic transaction: failure here has an uncertain write outcome.
  const appliedAt=Date.now(),event=await fs.open(path.join(events,`${appliedAt}-${randomUUID()}.json`),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await event.writeFile(JSON.stringify({kind:'applied_transition',previousHash:before.hash,nextHash:digest(clean),appliedAt}));await event.sync();}finally{await event.close();}
  await syncDir(events);return await readMemorySnapshot(agentId);
 }finally{await fs.unlink(temp).catch(()=>{});await lock.close();await fs.unlink(path.join(dir,'.memory-lock'));}
}
/**
 * STORE-MAP-01 P5: the MEMORY.md history kept by writeMemoryCAS, oldest
 * first (the text before the first saved change, then each applied change),
 * for the one-time import into the agent drawer. Entries that are missing,
 * linked, too large or not ours are skipped, never followed.
 */
export async function readMemoryHistory(agentId:string):Promise<{hash:string;content:string;appliedAt:number|null}[]>{
 const dir=await checkedMemoryDir(agentId);if(!dir)return [];
 const versions=path.join(dir,'.memory-versions'),events=path.join(versions,'events');
 async function json(file:string):Promise<any|null>{
  let handle;try{handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);}catch{return null;}
  try{const st=await handle.stat();if(!st.isFile()||st.nlink!==1||st.uid!==process.getuid?.()||(st.mode&0o077)!==0||st.size>262144)return null;return JSON.parse(await handle.readFile('utf8'));}catch{return null;}finally{await handle.close();}
 }
 let names:string[]=[];try{if(!await checkDirectory(versions)||!await checkDirectory(events))return [];names=(await fs.readdir(events)).filter(n=>/^\d{1,16}-[0-9a-f-]{36}\.json$/.test(n)).sort((a,b)=>Number(a.split('-')[0])-Number(b.split('-')[0])||a.localeCompare(b));}catch{return [];}
 const content=async(hash:string|null)=>{if(!hash||!/^[a-f0-9]{64}$/.test(hash))return null;const v=await json(path.join(versions,hash+'.json'));return v&&v.hash===hash&&typeof v.content==='string'?v.content:null;};
 const out:{hash:string;content:string;appliedAt:number|null}[]=[];
 for(const n of names.slice(0,1000)){
  const e=await json(path.join(events,n));if(!e||e.kind!=='applied_transition')continue;
  if(!out.length&&e.previousHash){const before=await content(e.previousHash);if(before!==null)out.push({hash:e.previousHash,content:before,appliedAt:null});}
  const next=await content(e.nextHash);if(next!==null&&out[out.length-1]?.hash!==e.nextHash)out.push({hash:e.nextHash,content:next,appliedAt:Number.isFinite(e.appliedAt)?e.appliedAt:null});
 }
 return out;
}

/** Blind writes are retired; no model may silently replace its own memory file. */
export async function writeMemory(_agentId:string,_content:string):Promise<void>{throw Error('reviewed_memory_required');}
export async function appendMemory(_agentId:string,_content:string):Promise<void>{throw Error('reviewed_memory_required');}

/**
 * List knowledge files for an agent
 */
export async function listKnowledgeFiles(agentId: string): Promise<string[]> {
  const knowledgeDir = path.join(getAgentDir(agentId), 'knowledge');

  try {
    const files: string[] = [];
    const scan = async (dir: string, prefix = '') => {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          await scan(fullPath, relativePath);
        } else {
          files.push(relativePath);
        }
      }
    };

    await scan(knowledgeDir);
    return files;
  } catch (err) {
    return [];
  }
}

/**
 * Read a knowledge file
 */
export async function readKnowledgeFile(agentId: string, filename: string): Promise<string> {
  // SECURITY: Sanitize filename to prevent path traversal
  const sanitizedFilename = sanitizePathParam(filename);
  const filePath = path.join(getAgentDir(agentId), 'knowledge', sanitizedFilename);
  return await fs.readFile(filePath, 'utf-8');
}

/**
 * Write a knowledge file
 */
export async function writeKnowledgeFile(
  agentId: string,
  filename: string,
  content: string
): Promise<void> {
  await initializeAgentDir(agentId);
  // SECURITY: Sanitize filename to prevent path traversal
  const sanitizedFilename = sanitizePathParam(filename);
  const filePath = path.join(getAgentDir(agentId), 'knowledge', sanitizedFilename);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * Delete a knowledge file
 */
export async function deleteKnowledgeFile(agentId: string, filename: string): Promise<void> {
  // SECURITY: Sanitize filename to prevent path traversal
  const sanitizedFilename = sanitizePathParam(filename);
  const filePath = path.join(getAgentDir(agentId), 'knowledge', sanitizedFilename);
  await fs.unlink(filePath);
}

/**
 * Get all agent files
 */
export async function getAgentFiles(agentId: string): Promise<AgentFiles> {
  const personality = await readPersonality(agentId);
  const memory = await readMemory(agentId);
  const knowledgeFiles = await listKnowledgeFiles(agentId);

  return {
    personality,
    memory,
    knowledgeFiles
  };
}

/**
 * Default PERSONALITY.md template (an unedited file = no personality text of its own).
 */
export function getDefaultPersonality(): string {
  return `# Agent Personality

## Core Identity

- **Role**: [Define your role - e.g., Customer Support, Code Reviewer, Data Analyst]
- **Specialty**: [What you're best at]
- **Tone**: [Professional / Friendly / Direct / Technical]

## Behavioral Rules

### Communication Style
- Be genuinely helpful, not performatively helpful
- Skip filler phrases like "Great question!" - just help
- Have opinions - you're allowed to disagree and prefer things
- Be concise when possible, thorough when needed

### Work Approach
- Fix errors immediately - don't ask, don't wait
- Be resourceful before asking - read files, check context, search first
- Use subagents for parallel execution when possible
- Read documentation before changing configs

### Boundaries
- Never force push, delete branches, or rewrite git history
- When in doubt about external actions, ask first
- Be careful with public-facing actions (emails, messages, posts)
- Respect user privacy and data

## Specialization

### What I Do Best
- [List your key capabilities]
- [Your core competencies]
- [What makes you unique]

### What I Avoid
- [Things outside your scope]
- [Actions you shouldn't take]
- [Known limitations]

## Values

- **Competence over conversation**: Actions speak louder than words
- **Proactive over passive**: Anticipate needs, don't just react
- **Quality over speed**: Get it right the first time
- **Security first**: Never compromise safety for convenience

---

*This file defines who you are. Update it as you learn and grow.*
`;
}

/**
 * Default MEMORY.md template
 */
function getDefaultMemory(): string {
  return `# Agent Memory

## Learned Patterns

*As you work, record patterns you discover here*

---

## Common Tasks

*Document recurring tasks and their solutions*

---

## User Preferences

*Remember what the user likes and dislikes*

---

## Project Context

*Key information about the projects you work on*

---

## Mistakes & Learnings

*Record errors you made and how to avoid them*

---

*This file grows as you learn. Update it regularly.*
`;
}
