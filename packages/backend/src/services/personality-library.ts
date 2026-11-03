import {createHash} from 'node:crypto';
import {all,one,run,sql,lockName,type Step} from '../repositories/sql-steps.js';
import {appendVersion,currentPersonalityStep,putPersonalityTextStep,type PersonalityVersion} from './personality-store.js';
import {storeP4Enabled} from './store-p4.js';
import {TRAIT_NAMES,traitsToBehavior,type Traits} from './personality.js';
import {LibraryError,STARTERS,validateProfile,profileInstructions,type Profile} from './personality-library-profile.js';
export {LibraryError};
const idOk=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v);
const canonical=(v:any):string=>JSON.stringify(v&&typeof v==='object'?(Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))]))):v);
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const check=(v:unknown):Record<string,any>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new LibraryError('invalid_input');return v;};
const only=(v:Record<string,any>,keys:string[])=>{if(Object.keys(v).some(k=>!keys.includes(k)))throw new LibraryError('invalid_input');};
export type LibraryEntry={id:string;revision:number;profile:Profile;archived:boolean};
type Row={id:string;revision:number;profile_json:string;archived:number};
type Link={agent_id:string;personality_id:string;revision:number;profile_json:string;applied_version:number;linked:number};
function* readStep(id:string,includeArchived=false):Step<LibraryEntry>{
 if(!idOk(id))throw new LibraryError('invalid_id');
 const row=yield* one<Row>('SELECT * FROM personality_library WHERE id=?',id);
 if(!row||row.archived&&!includeArchived)throw new LibraryError('not_found',404);
 return {id,revision:row.revision,profile:validateProfile(JSON.parse(row.profile_json)),archived:!!row.archived};
}
export function* seedLibraryStep():Step<void>{
 for(const item of STARTERS){
  const result=yield* run('INSERT INTO personality_library(id,revision,profile_json) VALUES(?,1,?) ON CONFLICT(id) DO NOTHING',item.id,JSON.stringify(item.profile));
  if(result.changes)yield* run('INSERT INTO personality_library_versions(personality_id,revision,profile_json,created_by,created_at) VALUES(?,1,?,?,?)',item.id,JSON.stringify(item.profile),'system',new Date().toISOString());
 }
}
function* snapshot(id:string):Step<any[]>{
 const links=yield* all<Link>('SELECT * FROM agent_personality_links WHERE personality_id=? ORDER BY agent_id',id);
 const rows=[];
 for(const link of links){
  const current=yield* currentPersonalityStep(link.agent_id,{lock:true});if(!current)continue;
  const agent=yield* one<{name:string}>('SELECT name FROM agents_config WHERE id=?',link.agent_id);
  const style=yield* one<{profile_json:string|null}>('SELECT profile_json FROM agent_personality_profile_versions WHERE agent_id=? AND version=?',link.agent_id,current.version);
  rows.push({link,current,style:style?.profile_json??null,name:agent?.name??link.agent_id});
 }
 return rows;
}
function plan(current:PersonalityVersion,old:Profile,next:Profile){
 const traits={...next.traits};
 // Keep local overrides and locks; updating a shared profile never resets either.
 for(const k of TRAIT_NAMES)if(current.lockedTraits.includes(k)||current.traits[k]!==old.traits[k])traits[k]=current.traits[k];
 return {traits,dialect:current.dialect===old.dialect?next.dialect:current.dialect};
}
function impact(entry:LibraryEntry,profile:Profile,rows:any[]){
 const agents=rows.map(({link,current,name})=>({id:link.agent_id,name,version:current.version,linked:!!link.linked,locked:current.locked,lockedTraits:current.lockedTraits,changes:link.linked&&!current.locked?plan(current,JSON.parse(link.profile_json),profile):null}));
 return {id:entry.id,revision:entry.revision,profile,agents,confirmation:hash({entry,profile,rows})};
}
export class PersonalityLibrary {
 async initialize(){await sql().tx(function*(){yield* lockName('personality-library');yield* seedLibraryStep();},{immediate:true});}
 async list(){return sql().tx(function*(){const rows=yield* all<Row>('SELECT * FROM personality_library ORDER BY id');const links=yield* all<{personality_id:string;id:string;name:string}>('SELECT l.personality_id,a.id,a.name FROM agent_personality_links l JOIN agents_config a ON a.id=l.agent_id ORDER BY a.name,a.id');const starters=new Set((yield* all<{personality_id:string}>("SELECT personality_id FROM personality_library_versions WHERE revision=1 AND created_by='system'")).map(x=>x.personality_id));
  // `starter`: shipped with Girru (first version written by the seed); everything else was made by the owner. `agents` names who uses it, for faces in the list.
  return rows.map(r=>{const agents=links.filter(l=>l.personality_id===r.id).map(l=>({id:l.id,name:String(l.name??l.id).slice(0,100)}));return {id:r.id,revision:r.revision,profile:validateProfile(JSON.parse(r.profile_json)),archived:!!r.archived,usedBy:agents.length,starter:starters.has(r.id),agents:agents.slice(0,200)};});});}
 async read(id:string){return sql().read(readStep(id));}
 async versions(id:string){return sql().read((function*(){yield* readStep(id,true);return yield* all<{revision:number;profile_json:string;created_at:string}>('SELECT revision,profile_json,created_at FROM personality_library_versions WHERE personality_id=? ORDER BY revision DESC',id);})());}
 async preview(id:string,raw:unknown){const input=check(raw);only(input,['revision','profile']);const p=validateProfile(input.profile);return sql().tx(function*(){yield* lockName('personality-library');yield* seedLibraryStep();const e=yield* readStep(id);if(e.revision!==input.revision)throw new LibraryError('version_conflict',409);return impact(e,p,yield* snapshot(id));},{immediate:true});}
 async save(actor:string,id:string,raw:unknown){
  const input=check(raw);only(input,['revision','profile','confirmation']);const p=validateProfile(input.profile);
  if(!idOk(id)||['team','blend','assigned'].includes(id)||!Number.isSafeInteger(input.revision)||input.revision<0)throw new LibraryError('invalid_input');
  return sql().tx(function*(){
   yield* lockName('personality-library');yield* seedLibraryStep();
   const exists=yield* one<Row>('SELECT * FROM personality_library WHERE id=?',id);
   if(!exists){if(input.revision!==0)throw new LibraryError('version_conflict',409);yield* run('INSERT INTO personality_library(id,revision,profile_json) VALUES(?,1,?)',id,JSON.stringify(p));}
   else{
    const e=yield* readStep(id);if(e.revision!==input.revision)throw new LibraryError('version_conflict',409);
    const rows=yield* snapshot(id),review=impact(e,p,rows);
    if(rows.some(r=>r.link.linked)&&input.confirmation!==review.confirmation)throw new LibraryError('review_required',409);
    for(const {link,current} of rows){
     if(!link.linked||current.locked)continue;
     const change=plan(current,JSON.parse(link.profile_json),p);
     const v=yield* appendVersion(link.agent_id,actor,{...current,...change,source:'owner',basedOnVersion:current.version||null,note:`Library update: ${p.name}`,preset:null});
     const snapshot=yield* one<{profile_json:string|null}>('SELECT profile_json FROM agent_personality_profile_versions WHERE agent_id=? AND version=?',link.agent_id,current.version);
     const prior=snapshot?.profile_json?validateProfile(JSON.parse(snapshot.profile_json)):null,old=validateProfile(JSON.parse(link.profile_json));
     const effective={...p,traits:change.traits,dialect:change.dialect};
     if(prior)for(const field of ['temperament','pace','formality','humour','seniority','principles'] as const)if(canonical(prior[field])!==canonical(old[field]))(effective as any)[field]=prior[field];
     yield* run('UPDATE agent_personality_profile_versions SET profile_json=? WHERE agent_id=? AND version=?',JSON.stringify(effective),link.agent_id,v.version);
     yield* run('UPDATE agent_personality_links SET revision=?,profile_json=?,applied_version=? WHERE agent_id=?',e.revision+1,JSON.stringify(p),v.version,link.agent_id);
    }
    yield* run('UPDATE personality_library SET revision=?,profile_json=? WHERE id=?',e.revision+1,JSON.stringify(p),id);
   }
   const revision=(exists?.revision??0)+1;
   yield* run('INSERT INTO personality_library_versions(personality_id,revision,profile_json,created_by,created_at) VALUES(?,?,?,?,?)',id,revision,JSON.stringify(p),actor,new Date().toISOString());
   return yield* readStep(id);
  },{immediate:true});
 }
 async assignment(agentId:string){return sql().tx(function*(){if(!idOk(agentId))throw new LibraryError('invalid_id');const l=yield* one<Link>('SELECT * FROM agent_personality_links WHERE agent_id=?',agentId);if(!l)return null;const current=yield* currentPersonalityStep(agentId);if(!current)return null;const style=yield* one<{profile_json:string|null}>('SELECT profile_json FROM agent_personality_profile_versions WHERE agent_id=? AND version=?',agentId,current.version);const profile=validateProfile(JSON.parse(style?.profile_json??l.profile_json));return {id:l.personality_id,revision:l.revision,linked:!!l.linked,profile:{...profile,traits:current.traits,dialect:current.dialect}};});}

 async assign(actor:string,agentId:string,raw:unknown){
  const input=check(raw);only(input,['id','revision','expectedVersion','linked']);
  if(!idOk(agentId)||!idOk(input.id)||!Number.isSafeInteger(input.expectedVersion)||typeof input.linked!=='boolean')throw new LibraryError('invalid_input');
  return sql().tx(function*(){yield* lockName('personality-library');yield* seedLibraryStep();const e=yield* readStep(input.id);if(e.revision!==input.revision)throw new LibraryError('version_conflict',409);
   const current=yield* currentPersonalityStep(agentId,{lock:true});if(!current)throw new LibraryError('not_found',404);
   if(current.locked)throw new LibraryError('personality_locked',409);if(current.version!==input.expectedVersion)throw new LibraryError('version_conflict',409);
   const traits={...e.profile.traits};for(const k of current.lockedTraits)traits[k]=current.traits[k];
   const v=yield* appendVersion(agentId,actor,{...current,traits,dialect:e.profile.dialect,preset:null,source:'owner',basedOnVersion:current.version||null,note:`Assigned ${e.profile.name}`});
   yield* writeLink(agentId,e,v.version,input.linked);return {version:v.version};
  },{immediate:true});
 }
 async mode(agentId:string,raw:unknown){const input=check(raw);only(input,['linked','expectedVersion']);if(!idOk(agentId)||typeof input.linked!=='boolean'||!Number.isSafeInteger(input.expectedVersion))throw new LibraryError('invalid_input');return sql().tx(function*(){yield* lockName('personality-library');yield* seedLibraryStep();const current=yield* currentPersonalityStep(agentId,{lock:true});if(!current)throw new LibraryError('not_found',404);if(current.locked)throw new LibraryError('personality_locked',409);if(current.version!==input.expectedVersion)throw new LibraryError('version_conflict',409);const changed=yield* run('UPDATE agent_personality_links SET linked=? WHERE agent_id=?',input.linked?1:0,agentId);if(!changed.changes)throw new LibraryError('not_found',404);return {version:current.version};},{immediate:true});}
 async tune(actor:string,agentId:string,raw:unknown){
  const input=check(raw);only(input,['profile','expectedVersion']);const profile=validateProfile(input.profile);
  if(!idOk(agentId)||!Number.isSafeInteger(input.expectedVersion))throw new LibraryError('invalid_input');
  return sql().tx(function*(){yield* lockName('personality-library');yield* seedLibraryStep();const current=yield* currentPersonalityStep(agentId,{lock:true});if(!current)throw new LibraryError('not_found',404);if(current.locked)throw new LibraryError('personality_locked',409);if(current.version!==input.expectedVersion)throw new LibraryError('version_conflict',409);
   const traits={...profile.traits};for(const k of current.lockedTraits)traits[k]=current.traits[k];
   const v=yield* appendVersion(agentId,actor,{...current,traits,dialect:profile.dialect,preset:null,source:'owner',basedOnVersion:current.version||null,note:'Individual personality preferences'});
   yield* run('UPDATE agent_personality_profile_versions SET profile_json=? WHERE agent_id=? AND version=?',JSON.stringify({...profile,traits}),agentId,v.version);return {version:v.version};
  },{immediate:true});
 }
 async archive(id:string,raw:unknown){const input=check(raw);only(input,['revision','archived']);if(typeof input.archived!=='boolean')throw new LibraryError('invalid_input');return sql().tx(function*(){yield* lockName('personality-library');yield* seedLibraryStep();const e=yield* readStep(id,true);if(input.revision!==e.revision)throw new LibraryError('version_conflict',409);yield* run('UPDATE personality_library SET archived=? WHERE id=?',input.archived?1:0,id);return {archived:input.archived};},{immediate:true});}
 async team(){return sql().tx(function*(){const agents=yield* all<{id:string;name:string;department:string|null}>('SELECT id,name,department FROM agents_config ORDER BY name');const out=[];for(const agent of agents){const p=yield* currentPersonalityStep(agent.id);const link=yield* one<{personality_id:string;linked:number}>('SELECT personality_id,linked FROM agent_personality_links WHERE agent_id=?',agent.id);if(p)out.push({...agent,traits:p.traits,locked:p.locked,version:p.version,personalityId:link?.personality_id??null,linked:!!link?.linked});}return {agents:out,gaps:[!out.some(a=>a.traits.thoroughness>=75&&a.traits.caution>=65)?'No careful reviewer':null,!out.some(a=>a.traits.creativity>=75)?'No strong creative explorer':null,!out.some(a=>a.traits.warmth>=75)?'No especially warm communicator':null].filter(Boolean)};});}
}
function* writeLink(agentId:string,e:LibraryEntry,version:number,linked:boolean):Step<void>{yield* run('UPDATE agent_personality_profile_versions SET profile_json=? WHERE agent_id=? AND version=?',JSON.stringify(e.profile),agentId,version);yield* run('INSERT INTO agent_personality_links(agent_id,personality_id,revision,profile_json,applied_version,linked) VALUES(?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET personality_id=excluded.personality_id,revision=excluded.revision,profile_json=excluded.profile_json,applied_version=excluded.applied_version,linked=excluded.linked',agentId,e.id,e.revision,JSON.stringify(e.profile),version,linked?1:0);}
/** Called in the hire transaction: selection and first version commit together. */
export function* seedLibraryPersonality(agentId:string,actor:string,raw:unknown):Step<void>{
 const input=check(raw);only(input,['id','revision']);yield* lockName('personality-library');yield* seedLibraryStep();const e=yield* readStep(input.id);if(input.revision!==e.revision)throw new LibraryError('version_conflict',409);
 const current=yield* currentPersonalityStep(agentId,{lock:true});if(!current||current.version!==0)throw new LibraryError('version_conflict',409);
 const v=yield* appendVersion(agentId,actor,{traits:e.profile.traits,dialect:e.profile.dialect,preset:null,locked:false,lockedTraits:[],source:'seed',basedOnVersion:null,note:`Library: ${e.profile.name}`,textHash:storeP4Enabled()?yield* putPersonalityTextStep(''):undefined});yield* writeLink(agentId,e,v.version,true);
}
/** The snapshot supplies style; current per-agent traits always remain authoritative. */
export async function libraryBehavior(agentId:string){
 const current=await sql().read(currentPersonalityStep(agentId));if(!current)return null;
 const behavior=traitsToBehavior(current.traits,current.dialect);
 const snapshot=await sql().read(one<{profile_json:string|null}>('SELECT profile_json FROM agent_personality_profile_versions WHERE agent_id=? AND version=?',agentId,current.version));
 if(snapshot?.profile_json){
  const saved=validateProfile(JSON.parse(snapshot.profile_json));
  // The effective version includes local overrides; the library snapshot alone may be older.
  const effective={...saved,traits:current.traits,dialect:current.dialect};
  behavior.promptBlock+='\n## Effective personality profile\nDescriptive owner-assigned settings; trait scores are 0–100. They never grant tools or override approval policy.\n<effective-personality>\n'+JSON.stringify(effective)+'\n</effective-personality>\n'+profileInstructions(effective);
 }
 return behavior;
}
