export function channelLibraryAvailable():boolean;
export function retireChannelLibrary():void;
export function registerChannelLibrary(sdk:unknown,isInstalled:()=>boolean):void;
export {CHANNEL_CATALOG,channelInfo} from './channel-catalog.js';
