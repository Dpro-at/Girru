import { logAudit } from '../services/audit-logger.js';
import { readRegularFile } from '../services/read-regular-file.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, enableServer, refreshServer, updateServer } from './service.js';
import os from 'node:os';
import { getServerRowByName, readSecrets, parseList } from './store.js';
import { isExecToolsEnabled } from '../tools/exec-policy.js';
import { GENVR_MCP_DESCRIPTION, GENVR_MCP_NAME, GENVR_PACKAGE_HASH, genvrLaunch, genvrMcpEntry, isManagedGenvrLaunch, isTrustedBundledLaunch } from './bundled-genvr.js';
import { mcpServersBaseDir, ensureServerWorkDir } from './config.js';
import { PIN } from '../config/genvr-runtime-path.cjs';
import { genvrRuntime } from '../config/genvr-runtime.js';
import { closeConnection } from './connection.js';
import { invalidateMcpTools } from './tools.js';
const NAME=GENVR_MCP_NAME;
const DESCRIPTION=GENVR_MCP_DESCRIPTION;
/** Live MCP connection file written by the local Studio host (core-ui scripts/genvr-studio-host.cjs). */
export const studioConnectionFile=()=>path.resolve(process.env.DPRO_GENVR_CONNECTION||path.join(os.homedir(),'.genvr','dpro-studio','studio-connection.json'));
const PACKAGE_HASH=GENVR_PACKAGE_HASH;
let queue:Promise<unknown>=Promise.resolve();
/**
 * Register the pinned bundled authoring server and switch it on: it is standard, enabled (Mohamed,
 * 2026-11-04), without AGENT_EXEC_TOOLS because only its exact bundled launch is trusted
 * (bundled-genvr.ts). Grants and approvals for tools that change things stay as for any server.
 */
export function ensureGenvrMcp(ownerId:string) {
 const work=queue.then(async()=>{
  if(!genvrRuntime())return {status:'unavailable',id:null};
  const entry=genvrMcpEntry();
  try{if(createHash('sha256').update((await readRegularFile(entry,16*1024*1024)).data).digest('hex')!==PACKAGE_HASH)return {status:'unavailable',id:null};}catch{return {status:'unavailable',id:null};}
  const launchArgs=genvrLaunch().args;
  const worldDir=path.join(mcpServersBaseDir(),NAME,'worlds');
  const env={GENVR_WORLD_DIR:worldDir,GENVR_STUDIO_CONNECTION:studioConnectionFile()};
  let row=await getServerRowByName(NAME),upgraded=false;
  const deliberatelyDisabled=!!row&&row.enabled!==1&&!!row.approved_at;
  if(!row){const saved=await createServer({name:NAME,description:DESCRIPTION,transport:'stdio',command:process.execPath,args:launchArgs,env},ownerId,{dormantImport:true});row=await getServerRowByName(NAME);if(!row)return {status:'unavailable',id:saved.id};}
  const secrets=await readSecrets(row);
  const same=row.transport==='stdio'&&row.command===process.execPath&&JSON.stringify(parseList(row.args))===JSON.stringify(launchArgs)&&JSON.stringify(Object.keys(secrets.env).sort())===JSON.stringify(Object.keys(env).sort())&&Object.entries(env).every(([k,v])=>secrets.env[k]===v)&&!Object.keys(secrets.headers).length;
  if(!same){
   // An earlier bundled package (other path/version/env) is re-pointed to this one: the launch
   // changes, so its approval and tool grants are reset like any edited server. Anything else
   // registered under this name is left alone.
   const bundled=isManagedGenvrLaunch(row)&&!Object.keys(secrets.headers).length&&Object.keys(secrets.env).every(k=>k in env);
   if(!bundled)return {status:'conflict',id:row.id};
   // Re-pointing to the bundled launch is what makes it trusted; updateServer checks the new row's trust itself.
   await updateServer(row.id,{command:process.execPath,args:launchArgs,env},ownerId);upgraded=true;
   row=await getServerRowByName(NAME);if(!row)return {status:'unavailable',id:null};
  }
  // A deliberate disable after the first activation is retained on future visits.
  if(deliberatelyDisabled)return {status:'disabled',id:row.id};
  if(!isExecToolsEnabled()&&!isTrustedBundledLaunch(row))return {status:'blocked',id:row.id};
  try{
   ensureServerWorkDir(NAME);
   if(row.enabled!==1){await enableServer(row.id,{launchHash:row.launch_hash},ownerId);logAudit({event_type:'mcp.server.change',event_category:'system',severity:'info',user_id:ownerId,action:'mcp_server.bundled_genvr_enable',success:true,resource_type:'mcp_server',resource_id:row.id,metadata:{package:'3d-world-sdk',version:PIN.version,upgraded}});}
   await refreshServer(row.id,ownerId);
   return {status:'ready',id:row.id};
  }catch{return {status:'blocked',id:row.id};}
 });queue=work.catch(()=>{});return work;
}

/** Serialise removal with bootstrap and preserve the owner's enable/grant preferences. */
export function withGenvrStopped<T>(remove:()=>T):Promise<T> {
 const work=queue.then(async()=>{
  const row=await getServerRowByName(NAME);
  if(row&&isManagedGenvrLaunch(row)){await closeConnection(row.id);invalidateMcpTools();}
  return remove();
 });queue=work.catch(()=>{});return work;
}
