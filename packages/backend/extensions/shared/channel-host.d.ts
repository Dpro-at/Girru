export function channelRuntimeState(id:string):string;
export function refreshChannel(id:string):void;
export function isNativeChannel(id:string):boolean;
export function stopChannel(id:string):Promise<void>;
export function sendChannel(id:string,destination:string,text:string):Promise<{id:string}>;
export function registerChannelRoutes(fastify:unknown,api:unknown,id:string,options?:Record<string,unknown>):Promise<void>;

export function stopAllChannels():Promise<void>;
