import type {StudioAccount,StudioController,StudioOptions,StudioPost,StudioTheme} from 'agent-connect-dpro/studio';
export const SOCIAL_PLATFORMS:readonly string[];
export function socialAccounts(result:unknown):StudioAccount[];
export interface DraftStore { read():StudioPost[];save(post:StudioPost):Promise<StudioPost>;remove(id:string):Promise<void>;restore(post:StudioPost):Promise<StudioPost> }
export function draftStore(storage:Pick<Storage,'getItem'|'setItem'>,userId:string,connectionId:string):DraftStore;
export function studioOptions(input:{accounts:StudioAccount[];store?:DraftStore;theme?:StudioTheme;accountsAvailable?:boolean}):StudioOptions;
export function mountMarketingSocial(host:HTMLElement,input:{mount:(host:HTMLElement,options:StudioOptions)=>Promise<StudioController>;accounts:StudioAccount[];store?:DraftStore;theme?:StudioTheme;accountsAvailable?:boolean}):Promise<StudioController>;
