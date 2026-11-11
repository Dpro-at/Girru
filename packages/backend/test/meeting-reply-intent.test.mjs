import test from 'node:test';import assert from 'node:assert/strict';
import {meetingAudience,meetingGroupInvitation} from '../src/services/meeting-reply-intent.ts';
const people=[{id:'main',name:'Main',department:'management',role:'main'},{id:'dev',name:'Devin',department:'development',role:'manager',specialties:['Developer']},{id:'market',name:'Marin',department:'marketing',role:'manager',specialties:['Accountant']}];
test('everyday collective invitations are explicit and need no model classifier',()=>{
 for(const text of ['الكل هنا؟','هل الجميع موجودين؟','وينكم؟','شنو رأيكم بالخطة؟','شو رأيكم؟','شرايكم؟','is everyone here?','what do you all think about the plan?'])assert.equal(meetingGroupInvitation(text),true,text);
 for(const text of ['وينك؟','شنو رايك؟','لخص التقرير','قال الكل هنا','هل تعرف عدد الموجودين؟','كم واحد هنا','لا تردوا الكل هنا','مو الكل موجودين','if is everyone here','"الكل هنا"','> شنو رايكم','```الكل هنا```'])assert.equal(meetingGroupInvitation(text),false,text);
});
test('department and job invitations select only actual present matches and keep singular ambiguity',()=>{
 for(const text of ['قسم التسويق شنو رايكم؟','التسويق جاهزين؟','marketing department please reply','خلي قسم التسويق يردون','شنو رايكم يا قسم التسويق؟'])assert.deepEqual(meetingAudience(text,people).ids,['market'],text);
 assert.deepEqual(meetingAudience('مدراء قسم التطوير جاهزين؟',people).ids,['dev']);
 assert.deepEqual(meetingAudience('المدراء شنو رايكم؟',people).ids,['dev','market']);
 assert.equal(meetingAudience('المدير موجود؟',people).ambiguous.length,2);
 assert.deepEqual(meetingAudience('المحاسب موجود؟',people).ids,['market']);
 assert.deepEqual(meetingAudience('خلي المحاسبين يردون',people).ids,['market']);
 assert.equal(meetingAudience('Accountant please reply',[...people,{id:'second',name:'Other',department:'finance',specialties:['Accountant']}]).ambiguous.length,2);
 assert.deepEqual(meetingAudience('قسم المبيعات جاهزين؟',people).ids,[]);
 for(const text of ['اشرح تقرير قسم التسويق','قسم التسويق لا تردون','قال المحاسب موجود','"المحاسب موجود"'])assert.equal(meetingAudience(text,people),null,text);
});
