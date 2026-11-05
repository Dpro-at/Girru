const route=/^\/api\/store\/apps\/(call-center|trading|browser)\/(status|activation)$/;
export const hostAppRoute=path=>typeof path==='string'?route.exec(path):null;
export function allowedHostApp(method,path,body){const r=hostAppRoute(path);return !!r&&(r[2]==='status'?method==='GET'&&body===undefined:method==='POST'&&!!body&&Object.getPrototypeOf(body)===Object.prototype&&Object.keys(body).length===1&&Object.hasOwn(body,'enabled')&&typeof body.enabled==='boolean');}
export function hostAppResponse(path,status,body){const r=hostAppRoute(path);if(!r)throw Error('protocol');if(status!==200)return {code:['app_not_ready','invalid_app_activation'].includes(body?.code)?body.code:'app_unavailable'};
 if(r[2]==='activation'){if(body?.ok!==true||typeof body.enabled!=='boolean'||!['auto','manual'].includes(body.restart))throw Error('protocol');return {ok:true,enabled:body.enabled,restart:body.restart};}
 if(!body||body.id!==r[1]||!['installed','enabled','ready','needsRestart'].every(k=>typeof body[k]==='boolean')||body.clientHash!==null&&!/^[a-f0-9]{64}$/.test(body.clientHash))throw Error('protocol');
 return {id:body.id,installed:body.installed,enabled:body.enabled,ready:body.ready,needsRestart:body.needsRestart,clientHash:body.clientHash};
}
