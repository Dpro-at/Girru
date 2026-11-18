const root='/api/mcp-import/';
const record=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x);
const text=(x,n)=>typeof x==='string'&&x.length<=n;
const KEY=/^[a-f0-9]{64}$/;
export function mcpImportPath(path){return ['scan','preview','import','found','found/add','found/hide'].some(a=>path===root+a);}
export function allowedMcpImport(method,path,body){
 if(path===root+'found')return method==='GET'&&body===undefined;
 if(path===root+'found/add')return method==='POST'&&record(body)&&Object.keys(body).sort().join(',')==='keepSecrets,key'&&typeof body.key==='string'&&KEY.test(body.key)&&typeof body.keepSecrets==='boolean';
 if(path===root+'found/hide')return method==='POST'&&record(body)&&Object.keys(body).sort().join(',')==='hidden,key'&&typeof body.key==='string'&&KEY.test(body.key)&&typeof body.hidden==='boolean';
 if(method!=='POST'||!mcpImportPath(path)||!record(body))return false;const action=path.slice(root.length),keys=Object.keys(body).sort().join(',');return action==='scan'?keys==='':keys===(action==='preview'?'scanId,sourceId':'hash,scanId,sourceId')&&uuid(body.scanId)&&uuid(body.sourceId)&&(action==='preview'||typeof body.hash==='string'&&/^[a-f0-9]{64}$/.test(body.hash));}
const STATES=['new','added','manual','hidden'];
const src=s=>({origin:s.origin.slice(0,80),file:typeof s.file==='string'?s.file.slice(0,2048):'',key:typeof s.key==='string'?s.key.slice(0,200):'',project:typeof s.project==='string'?s.project.slice(0,2048):null,appId:typeof s.appId==='string'?s.appId.slice(0,128):null,appName:typeof s.appName==='string'?s.appName.slice(0,100):null,issue:typeof s.issue==='string'?s.issue.slice(0,80):null});
/** MCP-ONE-01 "Found, not added": rows with their sources; names of secrets only. */
function foundView(b){
 if(!Array.isArray(b.rows)||b.rows.length>1000||!Array.isArray(b.girru)||!Number.isSafeInteger(b.skipped))throw Error('protocol');
 const rows=b.rows.filter(r=>record(r)&&typeof r.key==='string'&&KEY.test(r.key)&&text(r.name,100)&&STATES.includes(r.state)&&Array.isArray(r.sources)).map(r=>({key:r.key,name:r.name,transport:['stdio','http','sse'].includes(r.transport)?r.transport:null,target:typeof r.target==='string'?r.target.slice(0,2000):null,
  secretNames:Array.isArray(r.secretNames)?r.secretNames.filter(n=>text(n,128)).slice(0,32):[],sources:r.sources.filter(s=>record(s)&&typeof s.origin==='string').slice(0,20).map(src),state:r.state,serverId:uuid(r.serverId)?r.serverId:null,issue:typeof r.issue==='string'?r.issue.slice(0,80):null}));
 const girru=b.girru.filter(g=>record(g)&&text(g.name,40)&&text(g.title,80)&&Array.isArray(g.apps)).slice(0,10).map(g=>({name:g.name,title:g.title,apps:g.apps.filter(a=>text(a,80)).slice(0,10)}));
 return {rows,girru,skipped:b.skipped};
}
export function mcpImportResponse(path,status,body){
 if(status!==200)return record(body)&&['forbidden','invalid_input','scan_not_found','source_not_found','preview_changed','name_conflict','unsupported_configuration','inline_secret_requires_manual_setup','url_credentials_require_manual_setup','import_unavailable','source_unavailable','invalid_configuration','unsupported_toml'].includes(body.code)?{code:body.code}:null;
 if(!record(body))throw Error('protocol');
 if(path===root+'found')return foundView(body);
 if(path===root+'found/hide'){if(body.ok!==true)throw Error('protocol');return {ok:true};}
 if(path===root+'found/add'){if(!uuid(body.id)||typeof body.duplicate!=='boolean')throw Error('protocol');return {id:body.id,duplicate:body.duplicate};}
 if(path===root+'scan'){
  if(!uuid(body.id)||!Number.isSafeInteger(body.skipped)||!Array.isArray(body.sources)||body.sources.length>500||!body.sources.every(s=>record(s)&&uuid(s.id)&&text(s.name,100)&&text(s.origin,80)&&typeof s.supported==='boolean'&&(s.issue===null||text(s.issue,80))))throw Error('protocol');
  return {id:body.id,skipped:body.skipped,sources:body.sources.map(s=>({id:s.id,name:s.name,origin:s.origin,supported:s.supported,issue:s.issue}))};
 }
 if(path===root+'import'){if(!uuid(body.id)||typeof body.duplicate!=='boolean')throw Error('protocol');return {id:body.id,duplicate:body.duplicate};}
 if(!text(body.name,24)||!['stdio','http','sse'].includes(body.transport)||!(body.command===null||text(body.command,1024))||!(body.url===null||text(body.url,2048))||!Array.isArray(body.args)||body.args.length>64||!body.args.every(a=>text(a,4096))||typeof body.allowRemote!=='boolean'||!text(body.hash,64)||!/^[a-f0-9]{64}$/.test(body.hash)||!(body.existingId===null||uuid(body.existingId)))throw Error('protocol');
 for(const key of ['envNames','headerNames'])if(!Array.isArray(body[key])||body[key].length>32||!body[key].every(s=>text(s,64)))throw Error('protocol');
 return {startupTimeoutMs:Number.isInteger(body.startupTimeoutMs)&&body.startupTimeoutMs>=1000&&body.startupTimeoutMs<=120000?body.startupTimeoutMs:null,name:body.name,transport:body.transport,command:body.command,args:body.args,url:body.url,allowRemote:body.allowRemote,hash:body.hash,existingId:body.existingId,envNames:body.envNames,headerNames:body.headerNames};
}
