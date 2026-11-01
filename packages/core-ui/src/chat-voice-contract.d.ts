export const CHAT_VOICE_PATH: string;
export function allowedChatVoice(method:string,path:string,body?:unknown):boolean;
export function chatVoiceResponse(status:number,body:unknown):unknown;

export function voiceTurnKey(turn:{role:string;runId:string|null;key:string}):string;

export function takeVoiceReply(turn:{role:string;status:string;runId:string|null;key:string},seen:Set<string>,pending:Set<string>,enabled:boolean):boolean;
