export const BROWSER_APP_PATH: '/api/browser/app';
export function allowedBrowserApp(method:string,path:string,body?:unknown):boolean;
export function browserAppResponse(status:number,body:unknown):Record<string,unknown>;

export function browserAddress(value:unknown):string|null;
