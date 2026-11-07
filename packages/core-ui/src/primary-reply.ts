import type {SessionClient} from './session';
export type PrimaryAgent={id:string;name:string;version:number;model:string;provider:string;isPrimary:boolean};
export type ReplyModel={id:string;name?:string;label?:string;provider:string};
export function primaryReplyModels(models:ReplyModel[]){return models.filter(m=>m.provider==='local'||m.provider==='ollama'||(m.provider==='subscription'&&/^subscription:(claude|codex|gemini)$/.test(m.id)));}
export async function savePrimaryReply(client:SessionClient,agent:PrimaryAgent,models:ReplyModel[],chosen:string):Promise<PrimaryAgent>{
 const model=primaryReplyModels(models).find(m=>m.id===chosen);if(!model)throw Error('source_unavailable');
 const r=await client.request({method:'PUT',path:`/api/agents/${encodeURIComponent(agent.id)}`,body:{expectedVersion:agent.version,modelSelection:model.id}} as never);
 if(r.status!==200)throw Error('source_not_saved');return (r.body as {agent:PrimaryAgent}).agent;
}
