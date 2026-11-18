export function hostAppRoute(path:string):RegExpExecArray|null;
export function allowedHostApp(method:string,path:string,body?:unknown):boolean;
export function hostAppResponse(path:string,status:number,body:any):any;
