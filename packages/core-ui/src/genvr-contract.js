export const GENVR_BYTES=64*1024*1024;
export const GENVR_AGENTS='/api/genvr/agents';
export const validGenVRTeam=value=>Array.isArray(value)&&value.length<=200&&new Set(value.map(a=>a?.id)).size===value.length&&value.every(a=>record(a)&&Object.keys(a).sort().join(',')==='avatar,id'&&genvrId(a.id)&&Number.isInteger(a.avatar)&&a.avatar>=0&&a.avatar<8);
export const GENVR_PATH='/api/genvr/projects';
export const STUDIO_TICKET_PATH='/api/genvr/studio-library-ticket';
export const genvrId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value);
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function validStudioProject(value){return record(value)&&value.format==='genvr-studio'&&value.version===1&&genvrId(value.id)&&typeof value.title==='string'&&value.title.length>0&&value.title.length<=200&&record(value.world)&&record(value.play);}

// GENVR-WORLD-01 P1 (board W1): the world's folder and project, who answers, and the Studio chat's model turn (owner only).
export const GENVR_WORLD=/^\/api\/genvr\/worlds\/([a-zA-Z0-9_-]{1,100})\/(open|agent|turn)$/;
export const WORLD_TURN_BYTES=2*1024*1024;
export const worldRoute=path=>GENVR_WORLD.test(path);
const TOOL_NAME=/^[a-z_]{1,64}$/;
const agentKey=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
const callsOk=calls=>Array.isArray(calls)&&calls.length<=20&&calls.every(c=>record(c)&&Object.keys(c).join()==='function'&&record(c.function)&&Object.keys(c.function).sort().join()==='arguments,name'&&TOOL_NAME.test(c.function.name)&&record(c.function.arguments));
/** The model request the Studio frame sends, as Girru forwards it: Ollama messages and function tools. */
export function validWorldTurn(body){
 if(!record(body)||Object.keys(body).sort().join()!=='messages,tools'||!Array.isArray(body.messages)||!body.messages.length||body.messages.length>200||!Array.isArray(body.tools)||body.tools.length>150)return false;
 if(!body.messages.every(m=>record(m)&&['system','user','assistant','tool'].includes(m.role)&&typeof m.content==='string'&&m.content.length<=100000&&Object.keys(m).every(k=>['role','content','tool_calls','tool_name'].includes(k))&&(m.tool_calls===undefined||m.role==='assistant'&&callsOk(m.tool_calls))&&(m.tool_name===undefined||m.role==='tool'&&TOOL_NAME.test(m.tool_name))))return false;
 if(!body.tools.every(t=>record(t)&&t.type==='function'&&record(t.function)&&TOOL_NAME.test(t.function.name)&&typeof t.function.description==='string'&&record(t.function.parameters)))return false;
 try{return new TextEncoder().encode(JSON.stringify(body)).length<=WORLD_TURN_BYTES;}catch{return false;}
}
function allowedWorld(method,path,body){
 const kind=GENVR_WORLD.exec(path)?.[2];
 if(kind==='open')return method==='POST'&&record(body)&&Object.keys(body).join()==='name'&&typeof body.name==='string'&&body.name.length<=200;
 if(kind==='agent')return method==='PUT'&&record(body)&&Object.keys(body).join()==='agentId'&&agentKey(body.agentId);
 return kind==='turn'&&method==='POST'&&validWorldTurn(body);
}
const answererOk=a=>record(a)&&agentKey(a.id)&&typeof a.name==='string'&&a.name.length<=60&&typeof a.detail==='string'&&a.detail.length<=60&&typeof a.color==='string'&&/^#[0-9a-fA-F]{6}$/.test(a.color);
const answererOf=a=>({id:a.id,name:a.name,detail:a.detail,color:a.color});
function worldResponse(path,status,body){
 const kind=GENVR_WORLD.exec(path)[2];
 if(status!==200)return record(body)&&['invalid_input','not_found','world_not_open','no_agent','model_unavailable','folder_unavailable','forbidden','unavailable'].includes(body.code)?{code:body.code,...(typeof body.message==='string'&&body.message.length<=300?{message:body.message}:{})}:null;
 if(!record(body))throw Error('protocol');
 if(kind==='open'){if(typeof body.folder!=='string'||body.folder.length>500||!(body.chatProjectId===null||agentKey(body.chatProjectId))||!(body.answerer===null||answererOk(body.answerer)))throw Error('protocol');return {folder:body.folder,chatProjectId:body.chatProjectId,answerer:body.answerer&&answererOf(body.answerer)};}
 if(kind==='agent'){if(!answererOk(body.answerer))throw Error('protocol');return {answerer:answererOf(body.answerer)};}
 if(typeof body.content!=='string'||body.content.length>200000||!callsOk(body.tool_calls)||!answererOk(body.answerer))throw Error('protocol');
 return {content:body.content,tool_calls:body.tool_calls.map(c=>({function:{name:c.function.name,arguments:c.function.arguments}})),answerer:answererOf(body.answerer)};
}
/** Studio tools that only read or move avatars: they run at once. Every other tool changes the world and asks first. */
export const WORLD_READ_TOOLS=new Set(['get_resource_controls','get_world_summary','get_game','search_catalog','list_library','get_script_api','get_scripts','get_script_logs','test_script','ask_user','present_avatar','avatar_voice']);
export const changesWorld=name=>!WORLD_READ_TOOLS.has(name);
const marketId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)&&!value.includes('..');
export function genvrMarket(path){if(path==='/api/genvr/market')return true;const match=/^\/api\/genvr\/market(?:\?after=([A-Za-z0-9._-]+)|\/items\/([A-Za-z0-9._-]+))$/.exec(path);return !!match&&marketId(match[1]??match[2]);}
export function genvrRoute(path){return worldRoute(path)||path===STUDIO_TICKET_PATH||path==='/api/genvr/mcp/bootstrap'||genvrMarket(path)||path===GENVR_AGENTS||path===GENVR_PATH||path.startsWith(GENVR_PATH+'/')&&genvrId(path.slice(GENVR_PATH.length+1));}
export function allowedGenVR(method,path,body){if(!genvrRoute(path))return false;if(worldRoute(path))return allowedWorld(method,path,body);if(path===STUDIO_TICKET_PATH)return method==='POST'&&record(body)&&Object.keys(body).length===0;if(path==='/api/genvr/mcp/bootstrap')return method==='POST'&&record(body)&&Object.keys(body).length===0;if(method==='GET')return body===undefined;if(method!=='PUT'||genvrMarket(path)||(path===GENVR_PATH||path===GENVR_AGENTS)||!record(body)||!['project,revision','agents,project,revision'].includes(Object.keys(body).sort().join(','))||(body.agents!==undefined&&!validGenVRTeam(body.agents)))return false;return Number.isSafeInteger(body.revision)&&body.revision>=0&&body.revision<Number.MAX_SAFE_INTEGER&&validStudioProject(body.project)&&body.project.id===path.slice(GENVR_PATH.length+1)&&JSON.stringify(body.project).length<=GENVR_BYTES;}
export function genvrResponse(path,status,body){
 if(!genvrRoute(path))throw Error('protocol');
 if(worldRoute(path))return worldResponse(path,status,body);
 if(status!==200)return record(body)&&['not_found','conflict','invalid_input','unsupported_store','unavailable','market_unavailable','forbidden'].includes(body.code)?{code:body.code}:null;
 if(!record(body))throw Error('protocol');
 if(path===STUDIO_TICKET_PATH){if(typeof body.ticket!=='string'||!/^[a-f0-9]{64}$/.test(body.ticket)||typeof body.expiresAt!=='string'||body.expiresAt.length>40)throw Error('protocol');return {ticket:body.ticket,expiresAt:body.expiresAt};}
 if(path==='/api/genvr/mcp/bootstrap'){if(!['ready','blocked','disabled','unavailable','conflict'].includes(body.status)||!(body.id===null||typeof body.id==='string'&&/^[a-f0-9-]{36}$/.test(body.id)))throw Error('protocol');return {status:body.status,id:body.id};}
 if(genvrMarket(path)){if(path.startsWith('/api/genvr/market/items/')){if(!record(body.asset)||body.asset.id!==path.slice('/api/genvr/market/items/'.length)||!record(body.asset.manifest)||!Array.isArray(body.asset.files))throw Error('protocol');return {asset:body.asset};}if(!Array.isArray(body.items)||body.items.length>200||!(body.next===null||marketId(body.next)))throw Error('protocol');return {items:body.items.map(item=>({manifest:item.manifest,picture:null,caption:item.caption,tags:item.tags})),next:body.next};}
 if(path===GENVR_AGENTS){if(!Array.isArray(body.agents)||body.agents.length>10000||!body.agents.every(a=>record(a)&&genvrId(a.id)&&typeof a.name==='string'&&a.name.length<=200&&(a.avatar===null||Number.isInteger(a.avatar)&&a.avatar>=0&&a.avatar<8)))throw Error('protocol');return {agents:body.agents.map(a=>({id:a.id,name:a.name,avatar:a.avatar}))};}
 if(path===GENVR_PATH){if(!Array.isArray(body.projects)||body.projects.length>1000||!body.projects.every(p=>record(p)&&genvrId(p.id)&&typeof p.title==='string'&&p.title.length<=200))throw Error('protocol');return {projects:body.projects.map(p=>({id:p.id,title:p.title,agentCount:Number.isSafeInteger(p.agentCount)&&p.agentCount>=0?p.agentCount:0}))};}
 if(!Number.isSafeInteger(body.revision)||body.revision<1)throw Error('protocol');
 if(body.saved===true)return {saved:true,revision:body.revision};
 if(!validStudioProject(body.project)||body.project.id!==path.slice(GENVR_PATH.length+1)||JSON.stringify(body.project).length>GENVR_BYTES)throw Error('protocol');
 if(body.agents!==undefined&&!validGenVRTeam(body.agents))throw Error('protocol');
 return {project:body.project,revision:body.revision,agents:body.agents??[]};
}
