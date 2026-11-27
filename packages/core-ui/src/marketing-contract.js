const PREFIX='/api/ext/seo/marketing/';
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const only=(v,keys)=>object(v)&&Object.keys(v).every(k=>keys.includes(k));
export const marketingRoute=path=>typeof path==='string'&&path.startsWith(PREFIX);
export function allowedMarketing(method,path,body){
 if(method==='GET'&&[PREFIX+'status',PREFIX+'tools'].includes(path))return body===undefined;
 if(method!=='POST')return false;
 if(path===PREFIX+'authorize')return only(body,['publishing'])&&body.publishing===false;
 if(path!==PREFIX+'read'||!only(body,['tool','arguments'])||!object(body.arguments))return false;
 if(['marketing_list_sites','marketing_social_accounts'].includes(body.tool))return Object.keys(body.arguments).length===0;
 return ['marketing_site_stats','marketing_site_keywords'].includes(body.tool)&&only(body.arguments,['domain','days'])&&typeof body.arguments.domain==='string'&&body.arguments.domain.length>0&&body.arguments.domain.length<=255&&Number.isInteger(body.arguments.days)&&body.arguments.days>=1&&body.arguments.days<=90;
}
function clean(value,depth=0){
 if(depth>12)throw Error('Marketing response too deep');
 if(value===null||typeof value==='boolean'||typeof value==='string'||typeof value==='number'&&Number.isFinite(value))return value;
 if(Array.isArray(value)){if(value.length>10000)throw Error('Marketing response too large');return value.map(x=>clean(x,depth+1));}
 if(!object(value))throw Error('Invalid Marketing data');
 return Object.fromEntries(Object.entries(value).filter(([key])=>!/(?:token|secret|credential|authorization|cookie)|^__proto__$|^constructor$|^prototype$/i.test(key)).map(([key,v])=>[key,clean(v,depth+1)]));
}
export function marketingResponse(path,status,body){
 if(status>=400)return {code:'marketing_unavailable'};
 if(!object(body)||JSON.stringify(body).length>4000000)throw Error('Invalid Marketing response');
 if(path===PREFIX+'status')return {connected:body.connected===true,scopes:Array.isArray(body.scopes)?body.scopes.filter(x=>typeof x==='string'&&/^read:[a-z]+$/.test(x)):[],...(typeof body.connectionId==='string'&&/^[A-Za-z0-9_-]{20,80}$/.test(body.connectionId)?{connectionId:body.connectionId}:{})};
 if(path===PREFIX+'authorize'){if(typeof body.authorizationUrl!=='string'||body.authorizationUrl.length>2048)throw Error('Invalid connection URL');return {authorizationUrl:body.authorizationUrl};}
 if(path===PREFIX+'tools'){if(!Array.isArray(body.tools)||body.tools.length>200)throw Error('Invalid tools');return {tools:body.tools.filter(t=>object(t)&&typeof t.name==='string').map(t=>({name:t.name.slice(0,128),description:typeof t.description==='string'?t.description.slice(0,2000):''}))};}
 if(path!==PREFIX+'read'||!Array.isArray(body.content)||body.content.length>20)throw Error('Invalid Marketing result');
 if(body.isError)return {isError:true,content:[{type:'text',text:'marketing_read_unavailable'}]};
 return {content:body.content.filter(x=>object(x)&&x.type==='text'&&typeof x.text==='string').map(x=>({type:'text',text:JSON.stringify(clean(JSON.parse(x.text)))}))};
}
