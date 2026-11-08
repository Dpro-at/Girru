export interface ComputerOverview {testOnly:boolean;configured?:boolean;configuration?:{configured?:boolean;started?:boolean;approvedInterfaces?:{host:string;port:number}[];approvedDirectEndpoints?:string[];recoveryAvailable?:boolean;membership?:{generation:number}};pairing?:{requests:ComputerPairing[];joins:ComputerPairing[]};productionEnrollment:{enabled:false;reason:string};self:{id:string;name:string}|null;devices:{id:string;name:string;publicKey?:string;epoch?:number;state:string;lastSeenAt:number|null;path:'direct'|'relay'|'waiting';capacity:{limit:3;active:number}|null}[];attempts:ComputerAttempt[];dispatchOptions:{id:string;label:string;agentBinding:string;modelBinding:string}[]}
export interface ComputerAttempt {sourceSessionId?:string|null;sourceCardId?:string|null;taskId:string;attemptId:string;sourceDevice:string;targetDevice:string;sourceName:string;targetName:string;state:string;statusLabel:string;detail:string;sessionId:string|null;runId:string|null;approvalId:string|null}
export function computerRoute(path:string):boolean;
export function allowedComputer(method:string,path:string,body?:unknown):boolean;
export function computerResponse(path:string,status:number,body:unknown):unknown;

export interface ComputerPairing {id:string;name:string|null;peerId:string|null;checkCode:string|null;expiresAt:number;state:string}
