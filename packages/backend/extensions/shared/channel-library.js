/** Provider constructors are supplied by the enabled Store app; this module loads no provider code. */
export {CHANNEL_CATALOG,channelInfo} from './channel-catalog.js';
let installed=()=>false,registered=false,retired=false;
function unavailable(){throw Error('Add Agent Connect from the Girru Store and restart Girru.');}
export let ChannelConnector=unavailable,TelegramTransport=unavailable,DiscordTransport=unavailable;
export const channelLibraryAvailable=()=>registered&&!retired&&installed();
export function retireChannelLibrary(){retired=true;registered=false;}
export function registerChannelLibrary(sdk,isInstalled){
 if(!sdk||!['ChannelConnector','TelegramTransport','DiscordTransport','PythonTransport'].every(k=>typeof sdk[k]==='function')||!Array.isArray(sdk.CHANNEL_CATALOG)||sdk.CHANNEL_CATALOG.length!==33||typeof isInstalled!=='function'||!isInstalled())throw Error('Incompatible Agent Connect package.');
 ChannelConnector=sdk.ChannelConnector;TelegramTransport=sdk.TelegramTransport;DiscordTransport=sdk.DiscordTransport;installed=isInstalled;registered=true;retired=false;
}
