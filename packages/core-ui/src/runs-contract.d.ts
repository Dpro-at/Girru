export function runsRoute(path:string):{kind:'list'|'item'|'stop'|'retry'|'schedules'|'scheduleRuns';id?:string}|null;
export function allowedRuns(method:string,path:string,body?:unknown):boolean;
export function runsResponse(path:string,status:number,body:unknown):unknown;
