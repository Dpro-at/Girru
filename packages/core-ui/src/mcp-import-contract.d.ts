export function mcpImportPath(path:string):boolean;
export function allowedMcpImport(method:string,path:string,body?:unknown):boolean;
export function mcpImportResponse(path:string,status:number,body:unknown):unknown;
/** MCP-ONE-01: a server found in another app or a Store app, merged by program or address. */
export type FoundSource={origin:string;file:string;key:string;project:string|null;appId:string|null;appName:string|null;issue:string|null};
export type FoundRow={key:string;name:string;transport:'stdio'|'http'|'sse'|null;target:string|null;secretNames:string[];sources:FoundSource[];state:'new'|'added'|'manual'|'hidden';serverId:string|null;issue:string|null};
export type FoundList={rows:FoundRow[];girru:{name:string;title:string;apps:string[]}[];skipped:number};
