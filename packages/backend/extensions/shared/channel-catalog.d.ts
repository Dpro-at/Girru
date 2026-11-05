export interface ChannelDefinition { id:string; label:string; runtime:'node'|'python'; requiredEnv:string[]; prerequisites:string; maxTextLength:number }
export const CHANNEL_CATALOG:readonly ChannelDefinition[];
export function channelInfo(id:string):ChannelDefinition;
