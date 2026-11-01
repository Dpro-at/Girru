import { changeMeetingAttendance } from '../../services/meeting-attendance.js';
import type { FastifyInstance } from 'fastify';
import { authorizeActiveRoleAsync } from '../../auth/route-guards.js';
import { BoardError } from '../../services/task-board.js';
import { MeetingError, approveMeeting, changeMeetingState, createMeeting, getMeeting, meetingDepartments, meetingLock, meetingRoster, meetingsFor, nextMeetingTurn, proposeMeetingReview, saveMeetingDecisions, type StartMeetingTurn } from '../../services/meetings.js';
import { startTurn } from './chat-conversations.js';
export async function meetingRoutes(app: FastifyInstance, options: { startTurn?: StartMeetingTurn } = {}) {
 app.route({ method: ['GET','POST','PUT'], url: '/api/meetings', config: { access: 'owner' }, handler: async (request,reply) => {
  const owner=await authorizeActiveRoleAsync(request,reply,['owner']);if(!owner)return reply;
  try { if(request.method==='POST')return reply.code(201).send({meeting:await createMeeting(owner,request.body)});if(request.method!=='GET')return reply.code(405).send({code:'invalid_meeting'});const b=request.query as Record<string,string>;if(Object.keys(b).some(k=>k!=='conversationId'))throw new MeetingError(400,'invalid_meeting','Unknown query');return await meetingsFor(owner,b.conversationId); }catch(e){return fail(e,reply);}
 }});
 app.get('/api/meetings/departments',{config:{access:'owner'}},async(request,reply)=>{const owner=await authorizeActiveRoleAsync(request,reply,['owner']);if(!owner)return reply;return meetingDepartments();});
 app.get('/api/meetings/roster',{config:{access:'owner'}},async(request,reply)=>{const owner=await authorizeActiveRoleAsync(request,reply,['owner']);if(!owner)return reply;try{return await meetingRoster(owner,request.query as Record<string,string>);}catch(e){return fail(e,reply);}});
 app.get<{Params:{id:string}}>('/api/meetings/:id',{config:{access:'owner'}},async(request,reply)=>{const owner=await authorizeActiveRoleAsync(request,reply,['owner']);if(!owner)return reply;try{return {meeting:await getMeeting(owner,request.params.id)};}catch(e){return fail(e,reply);}});
 for(const action of ['state','turns','review','approve','decisions','attendance'])app.route<{Params:{id:string}}>({method:action==='decisions'?'PUT':'POST',url:'/api/meetings/:id/'+action,config:{access:'owner'},handler:async(request,reply)=>{
  const owner=await authorizeActiveRoleAsync(request,reply,['owner']);if(!owner)return reply;
  try{return await meetingLock(request.params.id,async()=>{
   const id=request.params.id;
   if(action==='turns')return reply.code(202).send(await nextMeetingTurn(owner,id,request.body,options.startTurn??startTurn));
   if(action==='attendance')return await changeMeetingAttendance(owner,id,request.body);
   if(action==='state')return {meeting:await changeMeetingState(owner,id,request.body)};
   if(action==='decisions')return {meeting:await saveMeetingDecisions(owner,id,request.body)};
   if(action==='approve')return {meeting:await approveMeeting(owner,id,request.body)};
   if(request.body!=null&&(typeof request.body!=='object'||Array.isArray(request.body)||Object.keys(request.body as object).length))throw new MeetingError(400,'invalid_meeting','No review fields accepted');
   return {meeting:await proposeMeetingReview(owner,id)};
  });}catch(e){return fail(e,reply);}
 }});
}
function fail(error:unknown,reply:any){if(error instanceof MeetingError||error instanceof BoardError)return reply.code(error.status).send({code:error.code,error:error.message});throw error;}
