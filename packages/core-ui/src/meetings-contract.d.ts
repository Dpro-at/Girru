export type MeetingAgent={id:string;name:string;department:string|null;role:string|null};
export type MeetingDecision={id:string;title:string;description:string;agentId:string|null;department:string|null;dueDate:string|null;enabled:boolean;boardId:string|null;cardId:string|null};
export type MeetingSelection={mode:'all'|'departments'|'agents';departments:string[];agentIds:string[];headsOnly:boolean};
export type MeetingRecord={id:string;conversationId:string;title:string;objective:string;state:'active'|'paused'|'review'|'completed';version:number;count:number;cursor:number;activeRunId:string|null;speaker:MeetingAgent|null;summary:string;selection:MeetingSelection;decisions:MeetingDecision[];reviewReady:boolean};
export function meetingsRoute(path:string):boolean;
export function allowedMeetings(method:string,path:string,body?:unknown):boolean;
export function meetingsResponse(path:string,status:number,body:unknown):unknown;
