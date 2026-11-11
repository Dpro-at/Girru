/** Cheap meeting invitations: no classifier/model call and no inferred attendance. */
import {addressText,type ChatParticipant} from './chat-addressing.js';
import {meetingDepartmentAliases} from './meeting-department-aliases.js';

export function meetingGroupInvitation(message: string): boolean {
 const text=(addressText(message).match(/[\p{L}\p{N}]+/gu)??[]).join(' ');
 // Reports, quoted text, hypotheticals and negative instructions do not invite replies.
 if(/^(?:قال|قالوا|كتب|لخص|اشرح|ترجم|اذا|لو|ماذا لو|بعدين|غدا|لا|مو|مش|ليس|summarize|explain|translate|if|later|tomorrow|not|never|do not|don t)(?: |$)/u.test(text)
   || /(?:^| )(?:لا تردوا|لا تجاوبوا|لا يرد|لا يجاوب|مو الكل|مش الكل|not everyone|do not reply|don t reply)(?: |$)/u.test(text))return false;
 return /^(?:(?:هل|يا جماعة|يا شباب|يا فريق) )?(?:الكل|الجميع|كلكم|كل الفريق)(?: هنا| موجودين| موجود| حاضرين| جاهزين| مستعدين| وينكم| وينهم)(?: |$)/u.test(text)
   || /^(?:(?:يا جماعة|يا شباب|يا فريق) )?(?:وينكم|شنو رايكم|شو رايكم|شرايكم|ايش رايكم|ما رايكم|رايكم)(?: |$)/u.test(text)
   || /^(?:is (?:everyone|everybody) (?:here|there|ready|available)|are (?:you all|all of you) (?:here|there|ready|available)|where (?:is everyone|are you all)|what do (?:you all|all of you) think|(?:everyone|team) what do you think)(?: |$)/u.test(text);
}

export type MeetingAudienceMember=ChatParticipant&{specialties?:string[]};
const normalized=(text:string)=>(addressText(text).match(/[\p{L}\p{N}]+/gu)??[]).map(word=>word.replace(/^ال(?=[\u0600-\u06ff])/u,'')).join(' ');
const roleAliases:Record<string,{singular:string[];plural:string[]}>= {
 main:{singular:['الاساسي','الايجنت الاساسي','الوكيل الاساسي','الرئيسي','main agent','coordinator'],plural:[]},
 manager:{singular:['المدير','مدير','manager'],plural:['المدراء','المديرين','مدراء الاقسام','department heads','managers']},
 specialist:{singular:['المختص','المتخصص','specialist'],plural:['المختصين','المتخصصين','specialists']},
 evaluator:{singular:['المقيم','evaluator'],plural:['المقيمين','evaluators']},
};
/** An explicit department addresses that group; a singular job title must be unambiguous. */
export function meetingAudience(message:string,people:MeetingAudienceMember[]):{ids:string[];ambiguous?:MeetingAudienceMember[]}|null {
 if(/(?:^| )(?:غدا|بعدين|لاحقا|اذا|tomorrow|later|if|لا تردوا|لا تجاوبوا|لا يرد|لا يجاوب|do not reply|don t reply)(?: |$)/u.test(normalized(message)))return null;
 let text=normalized(message).replace(/^(?:خلي |اريد |ابي |يلا |ask )/u,'').replace(/^(?:يا |hey )/u,'');
 const trailing=/^(شنو رايكم|شو رايكم|شرايكم|رايكم) يا (.+)$/u.exec(text);if(trailing)text=trailing[2]+' '+trailing[1];
 // Match only a direct audience followed by a question/invitation, never a report about it.
 const invitation=/^(?:شنو راي(?:كم|ك)|شو راي(?:كم|ك)|راي(?:كم|ك)|شراي(?:كم|ك)|جاهز(?:ين|ون)?|مستعد(?:ين|ون)?|موجود(?:ين)?|هنا|وينك(?:م)?|رد(?:وا)?|جاوب(?:وا)?|يرد(?:ون|وا)?|يجيب(?:ون)?|to reply|what do you think|are you (?:here|ready)|please (?:reply|respond)|reply|respond)(?: |$)/u;
 const addressed=(alias:string)=>{const name=normalized(alias);return !!name&&text.startsWith(name+' ')&&invitation.test(text.slice(name.length+1));};
 for(const [department,aliases] of Object.entries(meetingDepartmentAliases)){
  const heads=['مدراء قسم ','مديري قسم ','مدير قسم '];
  const headAlias=aliases.find(alias=>heads.some(prefix=>addressed(prefix+alias)));
  if(headAlias){const matches=people.filter(p=>p.department?.toLowerCase()===department&&(p.role==='manager'||p.role==='main'));return addressed('مدير قسم '+headAlias)&&matches.length>1?{ids:[],ambiguous:matches}:{ids:matches.map(p=>p.id)};}
  if([department.replace(/[_-]/g,' '),...aliases].some(alias=>addressed('قسم '+alias)||addressed(alias+' department')||addressed(alias))){return {ids:people.filter(p=>p.department?.toLowerCase()===department).map(p=>p.id)};}
 }
 for(const department of new Set(people.map(p=>p.department).filter((d):d is string=>!!d))){if(addressed('قسم '+department)||addressed(department+' department'))return {ids:people.filter(p=>p.department===department).map(p=>p.id)};}
 for(const [role,aliases] of Object.entries(roleAliases)){
  if([...aliases.singular,...aliases.plural].some(addressed)){
   const matches=people.filter(p=>p.role===role),plural=aliases.plural.some(addressed);
   return !plural&&matches.length>1?{ids:[],ambiguous:matches}:{ids:matches.map(p=>p.id)};
  }
 }
 const jobs:Record<string,{singular:string[];plural:string[]}>= {accountant:{singular:['محاسب'],plural:['محاسبين','محاسبون']},developer:{singular:['مبرمج','مطور'],plural:['مبرمجين','مطورين']},designer:{singular:['مصمم'],plural:['مصممين']},marketer:{singular:['مسوق'],plural:['مسوقين']}};
 let plural=false;const matches=people.filter(p=>(p.specialties??[]).some(title=>{const job=jobs[title.toLowerCase()];if(job?.plural.some(addressed)){plural=true;return true;}return [title,...(job?.singular??[])].some(addressed);}));
 if(matches.length)return matches.length>1&&!plural?{ids:[],ambiguous:matches}:{ids:matches.map(p=>p.id)};
 return meetingGroupInvitation(message)?{ids:people.map(p=>p.id)}:null;
}
