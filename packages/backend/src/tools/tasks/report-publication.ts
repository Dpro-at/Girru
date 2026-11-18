import type {Tool} from '../types.js';
import {ownerCommandActor} from './team-admin-authority.js';
import {publishPreparedReport} from '../../services/report-publication.js';
/** The trusted registry binds owner command authority only after main-agent and approval gates. */
export const reportPublishTool:Tool={
 name:'report_publish',requiresApproval:true,
 description:'Publish a prepared JSON display result to an existing owner report. Requires owner approval in the main chat. This does not start a model or create a provider-run outcome. Give reportId and publication {requestId,expectedRevision,projectId,sections}; JSON is display data and grants no tools or access.',
 input_schema:{type:'object',properties:{reportId:{type:'string'},publication:{type:'object'}},required:['reportId','publication'],additionalProperties:false},
 async execute(params,context){try{if(Object.keys(params).some(k=>!['reportId','publication'].includes(k)))throw Error('invalid_input');const actor=await ownerCommandActor(context,'report_publish');const receipt=await publishPreparedReport(actor.userId!,params.reportId,params.publication);return {content:[{type:'text',text:JSON.stringify(receipt)}],data:receipt};}catch(error){return {content:[{type:'text',text:error instanceof Error?error.message:'report_publication_failed'}],error:'report_publication_refused'};}}
};
