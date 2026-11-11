import {CronTime} from 'cron';
export type ReportCadence={every:'daily'|'weekly'|'monthly'|'yearly';at:string;timezone:string;weekday?:number;day?:number;month?:number};
export function reportCalendar(input:unknown):ReportCadence{
 const v=input as Record<string,unknown>;
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['every','at','timezone','weekday','day','month'].includes(k))||!['daily','weekly','monthly','yearly'].includes(String(v.every))||typeof v.at!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.at)||typeof v.timezone!=='string'||v.timezone.length>100)throw Error('invalid_report_calendar');
 try{new Intl.DateTimeFormat('en',{timeZone:v.timezone}).format(new Date(0));}catch{throw Error('invalid_report_timezone');}
 const integer=(x:unknown,min:number,max:number)=>Number.isInteger(x)&&Number(x)>=min&&Number(x)<=max;
 if(v.every==='weekly'?!integer(v.weekday,0,6):v.weekday!==undefined)throw Error('invalid_report_weekday');
 if(['monthly','yearly'].includes(String(v.every))?!integer(v.day,1,31):v.day!==undefined)throw Error('invalid_report_day');
 if(v.every==='yearly'?!integer(v.month,1,12):v.month!==undefined)throw Error('invalid_report_month');
 if(v.every==='yearly'&&Number(v.day)>(Number(v.month)===2?29:[4,6,9,11].includes(Number(v.month))?30:31))throw Error('invalid_report_day');
 return v as ReportCadence;
}
/** Existing cron calendar semantics: invalid month days are skipped, never silently clamped. */
export function nextReportOccurrence(value:ReportCadence,from:Date):Date{
 const c=reportCalendar(value),[hour,minute]=c.at.split(':').map(Number);
 const expression=`${minute} ${hour} ${c.every==='monthly'||c.every==='yearly'?c.day:'*'} ${c.every==='yearly'?c.month:'*'} ${c.every==='weekly'?c.weekday:'*'}`;
 return new CronTime(expression,c.timezone).getNextDateFrom(from,c.timezone).toJSDate();
}
