export const VOICE_LIBRARY_PATH:string;
export const VOICE_LANGUAGES:string[];
export function allowedVoiceLibrary(method:string,path:string,body?:unknown):boolean;
export function voiceLibraryResponse(status:number,body:unknown):unknown;
