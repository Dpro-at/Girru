import {logAudit} from '../../services/audit-logger.js';
import {personalityPreview} from '../../services/personality-preview.js';
import {randomUUID} from 'node:crypto';
import {sql,one,run,all,lockName} from '../../repositories/sql-steps.js';
import type {FastifyInstance} from 'fastify';
import {actorOf} from '../../auth/auth-gate.js';
import {requireOwner,ScopeError} from '../../repositories/scope.js';
import {PersonalityLibrary,LibraryError} from '../../services/personality-library.js';
import {blend,validateProfile} from '../../services/personality-library-profile.js';
import {storeP4Enabled} from '../../services/store-p4.js';
import {writePersonalityView} from '../../services/personality-record.js';
/** STORE-MAP-01 P4 (T7): after a library change the PERSONALITY.md view follows the record (it did not before). */
async function refreshViews(r:any,url:string){
 if(!storeP4Enabled())return;
 const agentId=(r.params as {agentId?:string}).agentId;
 const ids=agentId?[agentId]:url==='/api/personality-library/:id'?(await sql().read(all<{agent_id:string}>('SELECT agent_id FROM agent_personality_links WHERE personality_id=?',(r.params as {id:string}).id))).map(x=>x.agent_id):[];
 for(const id of ids)await writePersonalityView(id).catch(()=>{});
}
export async function personalityLibraryRoutes(app:FastifyInstance){
 const store=new PersonalityLibrary();
 const previews=new Set<string>();
 const owner=(r:any)=>{const a=requireOwner(actorOf(r));if(a.kind!=='user'||!a.userId)throw new ScopeError(403,'Forbidden');return a.userId;};
 const opts={config:{access:'owner' as const},bodyLimit:48000}; // a blend body carries two full profiles
 const fail=(reply:any,e:unknown)=>reply.code(e instanceof ScopeError?e.status:e instanceof LibraryError?e.status:503).send({code:e instanceof ScopeError?'forbidden':e instanceof LibraryError?e.code:'library_unavailable'});
 const route=(method:'GET'|'POST'|'PUT',url:string,action:(r:any,actor:string)=>Promise<unknown>)=>app.route({method,url,...opts,handler:async(r,reply)=>{try{const actor=owner(r);const result=await action(r,actor);if(method!=='GET')await refreshViews(r,url);if(method!=='GET')logAudit({event_type:'data.update',event_category:'data_modification',severity:'info',user_id:actor,resource_type:'personality',resource_id:(r.params as {id?:string;agentId?:string}).id??(r.params as {agentId?:string}).agentId??'library',action:url,success:true});return result;}catch(e){return fail(reply,e);}}});
 route('GET','/api/personality-library',async()=>{await store.initialize();return {personalities:await store.list()};});
 route('GET','/api/personality-library/team',async()=>store.team());
 route('POST','/api/personality-library/blend',async r=>{const b=r.body;if(!b||Object.keys(b).some(k=>!['a','b','weight'].includes(k)))throw new LibraryError('invalid_input');return {profile:blend(validateProfile(b.a),validateProfile(b.b),b.weight)};});
 route('GET','/api/personality-library/assigned/:agentId',async r=>({assignment:await store.assignment(r.params.agentId)}));
 route('POST','/api/personality-library/assigned/:agentId/mode',async r=>store.mode(r.params.agentId,r.body));
 route('POST','/api/personality-library/assigned/:agentId/tune',async(r,a)=>store.tune(a,r.params.agentId,r.body));
 route('POST','/api/personality-library/assigned/:agentId',async(r,a)=>store.assign(a,r.params.agentId,r.body));
 route('POST','/api/personality-library/:id/try',async(r,actor)=>{const b=r.body;if(!b||Object.keys(b).some(k=>!['profile','prompt'].includes(k)))throw new LibraryError('invalid_input');await store.read(r.params.id);if(previews.has(actor))throw new LibraryError('preview_busy',429);previews.add(actor);try{return await personalityPreview(b.profile,b.prompt);}finally{previews.delete(actor);}});
 route('GET','/api/personality-library/:id/exams',async r=>{await store.read(r.params.id);return {exams:await sql().read(all('SELECT revision,score,answers_json,ratings_json,created_at FROM personality_exam_runs WHERE personality_id=? ORDER BY created_at DESC LIMIT 100',r.params.id))};});
 route('POST','/api/personality-library/:id/exams',async(r,actor)=>{const b=r.body;
  if(!b||Object.keys(b).some(k=>!['revision','answers','ratings'].includes(k))||!Array.isArray(b.answers)||b.answers.length!==3||!b.answers.every((x:unknown)=>typeof x==='string'&&!!x.trim()&&x.length<=4000)||!Array.isArray(b.ratings)||b.ratings.length!==3||!b.ratings.every((x:unknown)=>Number.isInteger(x)&&Number(x)>=0&&Number(x)<=4))throw new LibraryError('invalid_input');
  await sql().tx(function*(){yield* lockName('personality-library');const e=yield* one<{revision:number;profile_json:string}>('SELECT revision,profile_json FROM personality_library WHERE id=? AND archived=0',r.params.id);if(!e||e.revision!==b.revision)throw new LibraryError('version_conflict',409);yield* run('INSERT INTO personality_exam_runs(id,personality_id,revision,profile_json,answers_json,ratings_json,score,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',randomUUID(),r.params.id,b.revision,e.profile_json,JSON.stringify(b.answers),JSON.stringify(b.ratings),Math.round(b.ratings.reduce((a:number,n:number)=>a+n,0)/12*100),actor,new Date().toISOString());},{immediate:true});
  return {exams:await sql().read(all('SELECT revision,score,answers_json,ratings_json,created_at FROM personality_exam_runs WHERE personality_id=? ORDER BY created_at DESC LIMIT 100',r.params.id))};
 });
 route('GET','/api/personality-library/:id',async r=>store.read(r.params.id));
 route('GET','/api/personality-library/:id/versions',async r=>({versions:await store.versions(r.params.id)}));
 route('POST','/api/personality-library/:id/preview',async r=>store.preview(r.params.id,r.body));
 route('POST','/api/personality-library/:id/archive',async r=>store.archive(r.params.id,r.body));
 route('PUT','/api/personality-library/:id',async(r,a)=>store.save(a,r.params.id,r.body));
}
