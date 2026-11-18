/** A one-shot target-owner intent; approval tickets are never replayed by the due worker. */
import {z} from 'zod';
const time=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const executionTiming=z.discriminatedUnion('mode',[z.object({mode:z.literal('immediate')}).strict(),z.object({mode:z.literal('scheduled'),executeAt:time,latestStartAt:time,timeZone:z.string().min(1).max(100)}).strict()]);
export type ExecutionTiming=z.infer<typeof executionTiming>;
export function readExecutionTiming(raw:unknown,now=Date.now(),allowPast=false):ExecutionTiming{const timing=executionTiming.parse(raw??{mode:'immediate'});if(timing.mode==='scheduled'){try{new Intl.DateTimeFormat('en',{timeZone:timing.timeZone});}catch{throw Error('computer_schedule_timezone_invalid');}if(timing.latestStartAt<timing.executeAt||timing.latestStartAt>timing.executeAt+1800000||!allowPast&&(timing.executeAt<now+1000||timing.executeAt>now+30*86400000))throw Error('computer_schedule_time_invalid');}return timing;}
export const scheduledBackgroundEnabled=()=>!['off','0','false'].includes(process.env.AGENT_PLAYER_BACKGROUND??'on');
