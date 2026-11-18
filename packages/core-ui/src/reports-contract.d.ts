export const REPORTS_PATH:string;
export const BOARD_REPORT_VIEWS:Readonly<Record<'summary'|'tasks'|'progress'|'states'|'completed'|'open'|'overdue',string>>;
export type BoardReportView=keyof typeof BOARD_REPORT_VIEWS;
export function reportsRoute(path:string):boolean;
export function allowedReports(method:string,path:string,body?:unknown):boolean;
export function reportsResponse(path:string,status:number,body:unknown):any;
export type ReportSection={id:string;title:string;size:'compact'|'wide';importance:'low'|'normal'|'high';preferredType:string;boardView?:BoardReportView};
export type ReportDefinition={id:string;title:string;instructions:string;agentId:string;projectId:string|null;revision:number;presentation:{source?:'agent'|'project_tasks';sections:ReportSection[]};status:string;lastError:string|null;conversationId:string|null};
