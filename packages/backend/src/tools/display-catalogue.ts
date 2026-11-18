import type {Tool} from './types.js';
import {displayCatalogue,validateDisplayDocument} from '../services/display-documents.js';
/** This tool neither reads stored owner data nor runs component actions. */
export const displayCatalogueTool:Tool={name:'display_catalogue',description:'Read the versioned display component catalogue or validate a supplied document without rendering, fetching providers, saving reports or executing actions. Uses the same pure contract as chat/report/avatar views. Explicit tool grants still apply.',input_schema:{type:'object',properties:{action:{type:'string',enum:['list','validate']},document:{type:'object'},text:{type:'string'}},required:['action'],additionalProperties:false},async execute(p){
 if(Object.keys(p).some(k=>!['action','document','text'].includes(k)))return {content:[{type:'text',text:'invalid_input'}],error:'invalid_input'};
 const data=p.action==='list'?displayCatalogue():p.action==='validate'&&((p.document!==undefined)!==(p.text!==undefined))?validateDisplayDocument(p.document??p.text):null;
 if(!data)return {content:[{type:'text',text:'invalid_input'}],error:'invalid_input'};
 return {content:[{type:'text',text:JSON.stringify(data)}],data};
}};
