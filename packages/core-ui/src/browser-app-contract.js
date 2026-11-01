export const BROWSER_APP_PATH = '/api/browser/app';
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const number=(x,min,max)=>Number.isFinite(x)&&x>=min&&x<=max;
const web=x=>{try{const u=new URL(x);return typeof x==='string'&&x.length<=4096&&['http:','https:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}};
export function allowedBrowserApp(method,path,body){
 if(path!==BROWSER_APP_PATH)return false;
 if(method==='GET')return body===undefined;
 if(method!=='POST'||!object(body))return false;
 const keys=Object.keys(body),id=body.id===undefined||typeof body.id==='string'&&/^[a-f0-9-]{36}$/.test(body.id),only=names=>id&&keys.every(k=>['action','id',...names].includes(k));
 if(body.action==='respond-prompt')return keys.length===3&&keys.every(k=>['action','prompt','button'].includes(k))&&[body.prompt,body.button].every(x=>typeof x==='string'&&/^[A-Fa-f0-9-]{36}$/.test(x));
 if(['open','state','onboard','prompts'].includes(body.action))return keys.join()==='action';
 if(['back','forward','reload'].includes(body.action))return only([]);
 if(body.action==='new')return only(['url'])&&(body.url===undefined||web(body.url));
 if(['select','close'].includes(body.action))return only(['id'])&&typeof body.id==='string'&&/^[a-f0-9-]{36}$/.test(body.id);
 if(body.action==='navigate')return only(['url'])&&(web(body.url)||body.url==='chrome://extensions/');
 if(body.action==='frame')return only(['after'])&&Number.isSafeInteger(body.after)&&body.after>=0;
 if(body.action==='viewport')return only(['width','height','mobile','reset'])&&(body.reset===true||Number.isInteger(body.width)&&Number.isInteger(body.height)&&number(body.width,240,8192)&&number(body.height,240,8192))&&(body.mobile===undefined||typeof body.mobile==='boolean');
 if(body.action==='input'){
  if(body.kind==='text')return only(['kind','text'])&&typeof body.text==='string'&&body.text.length<=4096;
  if(body.kind==='key')return only(['kind','event','key','code','modifiers','keyCode','text'])&&['keyDown','keyUp'].includes(body.event)&&typeof body.key==='string'&&body.key.length<=60&&typeof body.code==='string'&&body.code.length<=60&&number(body.modifiers,0,15)&&Number.isInteger(body.modifiers)&&number(body.keyCode,0,255)&&Number.isInteger(body.keyCode)&&(body.text===undefined||typeof body.text==='string'&&body.text.length<=8);
  return ['mouse','wheel'].includes(body.kind)&&only(['kind','x','y','event','button','count','deltaX','deltaY'])&&number(body.x,0,1)&&number(body.y,0,1)&&['down','up','move'].includes(body.event)&&['left','middle','right'].includes(body.button)&&number(body.count,0,2)&&(body.kind!=='wheel'||number(body.deltaX,-5000,5000)&&number(body.deltaY,-5000,5000));
 }
 return false;
}
export function browserAppResponse(status,body){
 if(status!==200)return {code:body?.code==='forbidden'?'forbidden':'browser_unavailable'};
 if(Array.isArray(body?.tabs)&&Array.isArray(body?.agents))return {active:typeof body.active==='string'?body.active:null,tabs:body.tabs.slice(0,48).filter(x=>object(x)&&typeof x.id==='string').map(x=>({id:x.id,agentId:String(x.agentId),title:String(x.title||'New tab').slice(0,200),url:String(x.url||'').slice(0,4096),viewport:x.viewport?{width:x.viewport.width,height:x.viewport.height,mobile:x.viewport.mobile===true}:null})),agents:body.agents.slice(0,5001).map(x=>({id:String(x.id),name:String(x.name).slice(0,80),department:String(x.department||'').slice(0,80)}))};
 if(Array.isArray(body?.prompts))return {prompts:body.prompts.slice(0,8).filter(p=>object(p)&&typeof p.id==='string'&&/^[A-Fa-f0-9-]{36}$/.test(p.id)&&Array.isArray(p.texts)&&p.texts.length>0&&p.texts.length<=512&&p.texts.every(t=>typeof t==='string'&&t.length<=4096)&&Array.isArray(p.actions)&&p.actions.length>0&&p.actions.length<=16&&p.actions.every(a=>object(a)&&typeof a.id==='string'&&/^[A-Fa-f0-9-]{36}$/.test(a.id)&&typeof a.label==='string'&&a.label.length>0&&a.label.length<=4096&&typeof a.enabled==='boolean')).map(p=>({id:p.id,texts:p.texts,actions:p.actions.map(a=>({id:a.id,label:a.label,enabled:a.enabled}))}))};
 if(Number.isSafeInteger(body?.seq))return {seq:body.seq,...(typeof body.image==='string'&&body.image.length<=6000000&&/^[A-Za-z0-9+/]*={0,2}$/.test(body.image)?{image:body.image}:{})};
 if(body?.ok===true)return {ok:true};
 return {available:body?.available===true,running:body?.running===true};
}

export function browserAddress(value){
 if(typeof value!=='string'||!value.trim()||value.length>4096)return null;
 const text=value.trim();
 if(/^https?:\/\//i.test(text))return web(text)?text:null;
 if(/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(text))return web('http://'+text)?'http://'+text:null;
 if(/^[a-z][a-z0-9+.-]*:/i.test(text)&&!/^[-\w.]+:\d+(?:\/|$)/.test(text))return null;
 if(/^[-\w.]+\.[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(text))return web('https://'+text)?'https://'+text:null;
 return 'https://www.google.com/search?q='+encodeURIComponent(text);
}
