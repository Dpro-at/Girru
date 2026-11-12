export const GENVR_BYTES:number;
export const GENVR_PATH:string;
export const GENVR_RUNTIME:'/api/genvr/runtime';
export function genvrId(value:unknown):value is string;
export function validStudioProject(value:unknown):boolean;
export function genvrRoute(path:string):boolean;
export function allowedGenVR(method:string,path:string,body?:unknown):boolean;
export function genvrResponse(path:string,status:number,body:unknown):unknown;

export const GENVR_AGENTS:string;
export function validGenVRTeam(value:unknown):boolean;

export function genvrMarket(path:string):boolean;
export const STUDIO_TICKET_PATH:'/api/genvr/studio-library-ticket';

/** GENVR-WORLD-01 P1: world folder/project, who answers, and the Studio chat's model turn. */
export const GENVR_WORLD:RegExp;
export const GENVR_WORLD_OF_CHAT:RegExp;
export const WORLD_TURN_BYTES:number;
export function worldRoute(path:string):boolean;
export function validWorldTurn(body:unknown):boolean;
export const WORLD_READ_TOOLS:ReadonlySet<string>;
export function changesWorld(name:string):boolean;
export const GENVR_PUBLISH_PAGE: string;
