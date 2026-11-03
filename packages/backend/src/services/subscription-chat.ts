import {launchTrackedSubscription} from './subscription-launcher.js';
import {launchWindowsSubscription,stopWindowsSubscriptions} from './subscription-launcher-win.js';
import {findSession,readSession} from '../memory/import/local-agents.js';
/** Explicit owner-selected CLI sessions; never an agent tool or a channel provider. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {dataPath} from '../config/data-root.js';
import {SubscriptionProcesses} from './subscription-processes.js';
import {minimalChildEnv,safeChildCwd} from '../tools/exec-policy.js';
import {storeP6Enabled} from './store-p6.js';
import {storeP7Enabled} from './store-p7.js';
import {MAX_IMAGE_BYTES,sniffImage} from './chat-images.js';
export type SubscriptionKind='claude'|'codex'|'gemini';
export const subscriptionModel=(value:unknown):value is string=>typeof value==='string'&&/^subscription:(?:(?:claude|codex)(?::[a-f0-9]{32})?|gemini)(?:\/[a-z0-9][a-z0-9.-]{0,40})?$/.test(value);
/** The coding app's own model after the slash (subscription:claude/opus, subscription:codex/gpt-6.1-sol), or undefined for its default (CORE-PICKER-02). */
export const subscriptionVariant=(model:string):string|undefined=>model.match(/\/([a-z0-9][a-z0-9.-]{0,40})$/)?.[1];
const CLAUDE_VARIANTS=[{id:'fable',label:'Fable'},{id:'opus',label:'Opus'},{id:'sonnet',label:'Sonnet'},{id:'haiku',label:'Haiku'}];
/** CH3: Antigravity's own model keys (agy --model); Default stays the CLI's pick for the account. */
export const GEMINI_VARIANTS:readonly {id:string;label:string;note:string}[]=[{id:'gemini-3.1-pro',label:'Gemini Pro',note:'Long documents and research'},{id:'gemini-3.8-flash',label:'Gemini Flash',note:'Quick'}];
/** Models the owner can pick for a coding app: Claude Code's aliases; Codex's own list for this account (~/.codex/models_cache.json, visible ones only); Gemini Pro/Flash. */
export async function subscriptionVariants(kind:SubscriptionKind,home=os.homedir()):Promise<{id:string;label:string;note?:string}[]>{
 if(kind==='claude')return CLAUDE_VARIANTS;
 if(kind==='gemini')return GEMINI_VARIANTS.map(v=>({...v}));
 try{
  const raw=JSON.parse(await fs.readFile(path.join(home,'.codex','models_cache.json'),'utf8'));const list=Array.isArray(raw?.models)?raw.models:Array.isArray(raw)?raw:[];
  return list.filter((m:any)=>m&&m.visibility==='list'&&typeof m.slug==='string'&&/^[a-z0-9][a-z0-9.-]{0,40}$/.test(m.slug)).slice(0,20)
   .map((m:any)=>({id:m.slug,label:typeof m.display_name==='string'&&m.display_name.trim()?m.display_name.trim().slice(0,40):m.slug}));
 }catch{return [];}
}
let processTracker:SubscriptionProcesses|undefined;
let processesStopping=false;
export function subscriptionProcesses():SubscriptionProcesses{
 if(processesStopping)throw Error('cli_shutting_down');
 if(!processTracker)processTracker=new SubscriptionProcesses(dataPath('subscription-processes'),{pythonPath:process.platform==='darwin'?'/usr/bin/python3':undefined});
 return processTracker;
}
export async function recoverSubscriptionProcesses():Promise<void>{
 // SUB2 (P7): on Windows each reply runs in a job that ends with its leader, so there is no journal to recover.
 if(windowsJobs())return;
 try{await fs.access(dataPath('subscription-processes'));}catch{if(!subscriptionEnabled())return;}
 const result=await subscriptionProcesses().sweepOrphans();
 if(result.skipped)console.warn('[Subscription] Some saved process records could not be safely recovered.');
}
export async function stopSubscriptionProcesses():Promise<void>{
 processesStopping=true;
 if(windowsJobs()){stopWindowsSubscriptions();return;}
 if(processTracker){const result=await processTracker.shutdown();if(result.skipped)console.warn('[Subscription] Some process records need later recovery.');}
}
/** SUB2 (P7): Windows replies run through Job Objects (subscription-launcher-win.ts). */
const windowsJobs=()=>process.platform==='win32'&&storeP7Enabled();
export const subscriptionEnabled=()=>process.env.DPRO_SUBSCRIPTION_CHAT==='1'&&process.env.AGENT_PLAYER_ISOLATED!=='1'&&!processesStopping;
/** Where the CLIs are installed. An app opened from the Dock gets a short PATH, so the usual install folders are searched too (CORE-PICKER-01): Homebrew, npm under fnm/nvm/volta. */
export async function subscriptionSearchDirs(home=os.homedir(),pathEnv=process.env.PATH??''):Promise<string[]>{
 const versions=async(dir:string,tail:string[])=>{try{return (await fs.readdir(dir)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})).map(v=>path.join(dir,v,...tail));}catch{return [];}};
 const dirs=[path.join(home,'.local','bin'),...pathEnv.split(path.delimiter).filter(Boolean),'/opt/homebrew/bin','/usr/local/bin',path.join(home,'.volta','bin'),path.join(home,'.npm-global','bin'),
  ...await versions(path.join(home,'.local','share','fnm','node-versions'),['installation','bin']),...await versions(path.join(home,'.nvm','versions','node'),['bin'])];
 return [...new Set(dirs.filter(d=>path.isAbsolute(d)))];
}
/** Where a chat without a project folder lets a coding app work: one private, empty folder per conversation, outside Girru's data (CORE-PICKER-03). */
export const chatWorkspacesRoot=()=>process.env.DPRO_CHAT_WORKSPACES?path.resolve(process.env.DPRO_CHAT_WORKSPACES):path.join(os.homedir(),'.dpro','chat-workspaces');
const CONVERSATION_ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
export async function chatWorkspace(conversationId:string):Promise<string>{
 if(!CONVERSATION_ID.test(conversationId))throw Error('project_required');
 const dir=path.join(chatWorkspacesRoot(),conversationId.replace(/:/g,'_'));await fs.mkdir(dir,{recursive:true,mode:0o700});return dir;
}
export async function removeChatWorkspace(conversationId:string):Promise<void>{
 if(!CONVERSATION_ID.test(conversationId))return;await fs.rm(path.join(chatWorkspacesRoot(),conversationId.replace(/:/g,'_')),{recursive:true,force:true});
}
export async function subscriptionBinary(kind:SubscriptionKind){
 // SUB2 (P7): on Windows only the program itself (.exe) is started, never a .cmd shim.
 const name=(kind==='gemini'?'agy':kind)+(windowsJobs()?'.exe':'');
 for(const dir of await subscriptionSearchDirs()){const file=path.join(dir,name);try{if((await fs.stat(file)).isFile()){if(!windowsJobs())await fs.access(file,fs.constants.X_OK);return file;}}catch{}}
 return null;
}
/** CHAT-GAPS-01: images a coding app may see — only files of Girru's own chat-images folder, at most 4 (Codex takes them with -i). */
export function chatImageFiles(files:readonly unknown[]|undefined):string[]{
 const base=path.resolve(dataPath('chat-images'))+path.sep;
 return (files??[]).filter((f):f is string=>typeof f==='string'&&path.isAbsolute(f)&&path.resolve(f).startsWith(base)&&/\.(png|jpg|gif|webp)$/.test(f)).slice(0,4).map(f=>path.resolve(f));
}
/** CHAT-GAPS-01: the image files a coding app will see for this chat model. Codex takes them with -i; Claude Code gets them as
 * base64 image blocks in one stream-json user message (only files that read back as a PNG, JPEG, GIF or WebP of at most 5 MB).
 * Antigravity's stream-json input accepts only text blocks (its own error: content block type not supported, only one type), so Gemini sees none. */
export async function chatImagesSeenBy(model:string|undefined,files:readonly unknown[]|undefined):Promise<string[]>{
 if(model?.startsWith('subscription:codex'))return chatImageFiles(files);
 if(!model?.startsWith('subscription:claude'))return [];
 return (await claudeImageBlocks(chatImageFiles(files))).map(b=>b.file);
}
type ClaudeImageBlock={type:'image';source:{type:'base64';media_type:string;data:string}};
/** Claude takes an image of at most 5 MB as base64, so a file is sent only up to 3.75 MB; a bigger one gets the notice. */
export const CLAUDE_IMAGE_RAW_BYTES=Math.floor(5*1024*1024/4)*3;
/** Reads the chat's own image files (chatImageFiles: at most 4, only the images folder) into Claude image blocks; an unreadable or wrong file is left out. */
export async function claudeImageBlocks(files:readonly string[]):Promise<(ClaudeImageBlock&{file:string})[]>{
 const out:(ClaudeImageBlock&{file:string})[]=[];
 for(const file of chatImageFiles(files)){
  try{const bytes=await fs.readFile(file);const type=bytes.length<=CLAUDE_IMAGE_RAW_BYTES?sniffImage(bytes):null;if(type)out.push({file,type:'image',source:{type:'base64',media_type:type,data:bytes.toString('base64')}});}catch{}
 }
 return out;
}
/** The one stream-json user message for Claude Code: the prompt as text, then the images. Only the keys Claude Code accepts on a plain user line. */
export const claudeStreamMessage=(prompt:string,blocks:readonly ClaudeImageBlock[])=>JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text:prompt},...blocks.map(b=>({type:'image',source:{type:'base64',media_type:b.source.media_type,data:b.source.data}}))]},parent_tool_use_id:null})+'\n';
/** stdin budget for a Claude Code turn with images: the 200000-byte prompt (JSON escaping can grow it up to 6x) plus 4 base64 images of at most 5 MB, plus the JSON around them. */
export const CLAUDE_IMAGE_STDIN_BYTES=6*200000+4*Math.ceil(MAX_IMAGE_BYTES/3)*4+4096;
/** The chat's thinking level for a coding app: Quick→low, Deep→high, Normal (or anything else)→the app's own default.
 * Only these two fixed strings can ever reach a CLI argument (codex exec -c model_reasoning_effort, claude --effort, agy --effort). */
const EFFORT:Readonly<Record<string,'low'|'high'>>=Object.freeze({quick:'low',deep:'high'});
export const subscriptionEffort=(thinking:unknown):'low'|'high'|undefined=>typeof thinking==='string'&&Object.hasOwn(EFFORT,thinking)?EFFORT[thinking]:undefined;
/** STORE-MAP-01 P7 (G8): Claude Code's own auto memory is untrusted input; in Girru's runs it stays out of the prompt
 * (it still reaches Girru through the back-flow, as review proposals only). */
export const untrustedMemoryEnv=(kind:SubscriptionKind):Record<string,string>=>kind==='claude'&&storeP7Enabled()?{CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1'}:{};
export function subscriptionArgs(kind:SubscriptionKind,nativeId?:string,variant?:string,appToolsOnly=false,readOnly=false,editsOnly=false,addDirs:readonly string[]=[],images:readonly string[]=[],thinking?:unknown){
 const effort=subscriptionEffort(thinking);
 if(kind==='gemini'){if(nativeId)throw Error('session_missing');return ['--input-format','stream-json','--output-format','stream-json','--mode','plan','--sandbox','--disable-slash-commands','--print-timeout','180s',...(variant&&GEMINI_VARIANTS.some(v=>v.id===variant)?['--model',variant]:[]),...(effort?['--effort',effort]:[])];}
 const args=kind==='claude'?['-p','--output-format','json','--no-session-persistence','--safe-mode','--restricted','--permission-mode','acceptEdits','--permission-prompts','none','--tools','Read,Write,Edit,Glob,Grep','--strict-mcp-config','--mcp-config','{"mcpServers":{}}']:
 ['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','workspace-write','--disable','plugins','--disable','skill_mcp_dependency_install','--json','-'];
 // CHAT-BUILD-01 (K3): a read-only call keeps Codex's shell for reading the project but it may not write anywhere.
 if(readOnly&&kind==='codex'&&!appToolsOnly)args[args.indexOf('--sandbox')+1]='read-only';
 // CHAT-BUILD-01 stage 3 (Mode "Accept edits"): the app may edit files in the chat's folders, never run commands.
 if(editsOnly&&!appToolsOnly){if(kind==='codex')args.splice(1,0,'--disable','shell_tool','--disable','unified_exec','-c','web_search="disabled"');for(const dir of addDirs.slice(0,8))args.splice(kind==='codex'?1:args.length,0,'--add-dir',dir);}
 if(appToolsOnly){if(kind==='claude')args[args.indexOf('--tools')+1]='';else{args[args.indexOf('--sandbox')+1]='read-only';args.splice(1,0,'--disable','shell_tool','--disable','unified_exec','-c','web_search="disabled"');}}
 if(nativeId){if(kind==='claude')args.push('--resume',nativeId,'--fork-session');else args.splice(args.length-1,1,'fork',nativeId,'-');}
 if(variant&&/^[a-z0-9][a-z0-9.-]{0,40}$/.test(variant)){if(kind==='claude')args.push('--model',variant);else args.splice(1,0,'-m',variant);}
 if(kind==='codex')for(const file of chatImageFiles(images))args.splice(1,0,'-i',file);
 // CHAT-GAPS-01: Claude Code takes images only through --input-format stream-json, which needs stream-json output, which needs --verbose in print mode.
 if(kind==='claude'&&chatImageFiles(images).length)args.splice(args.indexOf('--output-format'),2,'--input-format','stream-json','--output-format','stream-json','--verbose');
 if(effort){if(kind==='claude')args.push('--effort',effort);else args.splice(1,0,'-c',`model_reasoning_effort="${effort}"`);}
 return args;
}
export function subscriptionAnswer(kind:SubscriptionKind,stdout:string,streamed=false):string{
 if(kind==='gemini'){
  const rows=stdout.split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));
  const init=rows.find(row=>row.event==='init')?.init;
  const results=rows.filter(row=>row.event==='result');const result=results[0]?.result;
  if(init?.permission_mode!=='request-review'||results.length!==1||result?.status!=='SUCCESS'||result.error||typeof result.response!=='string'||rows.some(row=>row.event==='step_update'&&row.step_update?.step_type==='tool'))throw Error('cli_failed');
  return result.response;
 }
 if(kind==='claude'){let row;if(streamed){const results=stdout.split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line)).filter(r=>r?.type==='result');if(results.length!==1)throw Error('cli_failed');row=results[0];}else row=JSON.parse(stdout);if(row.api_error_code==='oauth_not_allowed_for_organization')throw Error('subscription_org_blocked');if(row.type!=='result'||row.is_error||typeof row.result!=='string')throw Error('cli_failed');return row.result;}
 const rows=stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line));const answers=rows.filter(r=>r.type==='item.completed'&&r.item?.type==='agent_message'&&typeof r.item.text==='string');
 if(!answers.length||rows.some(r=>r.type==='error'||r.type==='turn.failed'))throw Error('cli_failed');return answers.map(r=>r.item.text).join('\n\n');
}
export async function runSubscription(model:string,folder:string,prompt:string,signal:AbortSignal,options:{appToolsOnly?:boolean;readOnly?:boolean;editsOnly?:boolean;addDirs?:readonly string[];images?:readonly string[];thinking?:unknown;agentId?:string|null}={}):Promise<string>{
 if(!subscriptionEnabled()||!subscriptionModel(model))throw Error('cli_disabled');
 const cwd=await fs.realpath(safeChildCwd(folder));if(!(await fs.stat(cwd)).isDirectory()||cwd===os.homedir()||cwd===await fs.realpath(os.homedir()).catch(()=>os.homedir())||cwd===path.parse(cwd).root)throw Error('project_required');
 const kind=model.startsWith('subscription:claude')?'claude':model.startsWith('subscription:gemini')?'gemini':'codex',bin=await subscriptionBinary(kind);
 let nativeId:string|undefined;const opaque=model.split('/')[0].split(':')[2];
 if(opaque){const ref=await findSession(opaque);if(!ref||ref.source!==(kind==='claude'?'claude-code':'codex'))throw Error('session_missing');const session=await readSession(ref);if(!session.cwd||await fs.realpath(session.cwd)!==cwd)throw Error('session_folder_mismatch');nativeId=path.basename(ref.file).match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/)?.[1];if(!nativeId)throw Error('session_missing');}if(!bin)throw Error('cli_missing');if(signal.aborted)throw Error('cancelled');
 if(typeof prompt!=='string'||Buffer.byteLength(prompt,'utf8')>200000)throw Error('cli_input_invalid');
 // Claude Code with images: read them now (a file asked for that cannot be read stops the turn rather than answering without it).
 const imageBlocks=kind==='claude'&&chatImageFiles(options.images).length?await claudeImageBlocks(chatImageFiles(options.images)):[];
 if(imageBlocks.length!==(kind==='claude'?chatImageFiles(options.images).length:0))throw Error('cli_input_invalid');
 const streamed=imageBlocks.length>0,input=streamed?claudeStreamMessage(prompt,imageBlocks):undefined;
 if(input&&Buffer.byteLength(input,'utf8')>CLAUDE_IMAGE_STDIN_BYTES)throw Error('cli_input_invalid');
 const args=subscriptionArgs(kind,nativeId,subscriptionVariant(model),options.appToolsOnly,options.readOnly,options.editsOnly,options.addDirs,kind==='claude'?imageBlocks.map(b=>b.file):options.images,options.thinking);
 const env=minimalChildEnv({NO_COLOR:'1',TERM:'dumb',...untrustedMemoryEnv(kind)});env.PATH=[path.dirname(bin),env.PATH].filter(Boolean).join(path.delimiter);
 // STORE-MAP-01 P6: Girru is the trusted launcher; the coding app's dpro-memory gets this run's session capability (never a folder path).
 const session=storeP6Enabled()?await import('../memory/bridge/service.js').then(m=>m.launchSession(cwd,kind,options.agentId??null)).catch(()=>null):null;if(session)Object.assign(env,session.env);
 const geminiConfig=kind==='gemini'?await geminiReplyConfig():undefined;
 if(geminiConfig){env.AGY_CLI_DISABLE_AUTO_UPDATE='1';env.AGY_CLI_NONINTERACTIVE_HEADLESS='1';}
 let launched;try{const o={cwd:geminiConfig?.dir??cwd,env,...(streamed?{maxInputBytes:CLAUDE_IMAGE_STDIN_BYTES}:{})};launched=windowsJobs()?await launchWindowsSubscription(bin,args,o):await launchTrackedSubscription(subscriptionProcesses(),bin,args,o);}catch(error){await geminiConfig?.cleanup();await session?.end();throw error;}
 const child=launched.child;
 return new Promise((resolve,reject)=>{
  let output='',bytes=0,failed=false;
  const stop=()=>{if(failed)return;failed=true;if(child.connected)child.disconnect();else child.kill('SIGTERM');};
  const timer=setTimeout(stop,240000);signal.addEventListener('abort',stop,{once:true});
  const cleanup=()=>{void geminiConfig?.cleanup().catch(()=>{});void session?.end();clearTimeout(timer);signal.removeEventListener('abort',stop);};
  child.stdout!.on('data',chunk=>{bytes+=chunk.length;if(bytes>2*1024*1024)stop();else output+=chunk.toString();});child.stderr!.resume();
  child.on('error',()=>{cleanup();reject(Error('cli_unavailable'));});
  void launched.completion.then(code=>{
   cleanup();if(failed){reject(Error(signal.aborted?'cancelled':'cli_failed'));return;}
   if(code!==0){try{subscriptionAnswer(kind,output,streamed);}catch(error){if(error instanceof Error&&error.message==='subscription_org_blocked'){reject(error);return;}}reject(Error('cli_failed'));return;}
   try{const answer=subscriptionAnswer(kind,output,streamed).trim();if(!answer)throw Error();resolve(answer);}catch{reject(Error('cli_failed'));}
  });
  if(signal.aborted||processesStopping){stop();return;}
  try{launched.start(kind==='gemini'?JSON.stringify({event:'user',message:{content:'Use no native tools, MCP, files, browser, shell, agents or schedules. Return only the requested text/JSON. Girru executes its own tools separately.\n'+prompt}})+'\n':input??prompt);}catch{stop();cleanup();reject(Error('cli_unavailable'));}
 });
}

/** Antigravity owns account credentials. A fresh empty workspace prevents loading project instructions.
 * Native tools remain governed by Antigravity plan/headless review; only Girru registry tools are requested. */
export async function geminiReplyConfig(root=os.tmpdir(),home=os.homedir()){
 const settings=path.join(home,'.gemini','antigravity-cli','settings.json');
 let config:any={};try{config=JSON.parse(await fs.readFile(settings,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw Error('cli_config_unavailable');}
 if(config.modelProvider||config.toolPermission&&config.toolPermission!=='request-review'&&config.toolPermission!=='strict'||config.permissions?.allow?.length||config.hooks&&Object.keys(config.hooks).length)throw Error('cli_config_unsafe');
 const dir=await fs.mkdtemp(path.join(root,'dpro-antigravity-reply-'));
 return {dir,cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}
