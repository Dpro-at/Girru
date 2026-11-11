/** Host validation shared with channel configuration routes. */
export function isValidEnvironment(channelId: string, environment: unknown): boolean;
export function isValidSettings(channelId: string, settings: unknown): boolean;

export function isValidStateDirectory(value:unknown):boolean;
export function transportOptions(id:string,config?:Record<string,unknown>,env?:Record<string,string|undefined>):Record<string,unknown>;
