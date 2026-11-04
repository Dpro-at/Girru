import {createHash} from 'node:crypto';
import {addonCatalogue} from './addon-catalogue.js';
import {searchMarketplace,checkForUpdates,installExtension,uninstallExtension,getExtensionDetails} from './extension-marketplace.js';
import {readStoreRepo,type RepoRead,type StoreRuntime} from './store-repo.js';
import {CODE_ITEM,codeStoreActive,codeBundled,installedCodeRuntime,runtimePlatform,startCodeInstall,removeCodeRuntime,type RuntimeFetch} from './code-runtime.js';
import {existsSync} from 'node:fs';
import {backendPath} from '../config/backend-root.js';
import {COMPANY_SPECIALTIES} from './company-specialties.js';
import {installedApps,startAdd,removeApp,type AddJob} from './store-install.js';
import {parseStoreIndex,STORE_CATEGORIES,type CatalogueSource,type StoreIndex,type StoreManifest,type StoreCategoryId} from './store-index.js';

/**
 * Store config (STORE-UI-01). The featured app is a config value, not a
 * guess: Girru picks it here (or GIRRU_STORE_FEATURED) until the store
 * repository's index.json carries it. Ratings, reviews, install counts and
 * prices have no real source yet, so the index has no fields for them and
 * every item is free (SA4 decisions 1, 2 and 4 are still open).
 */
export const STORE_CONFIG={featured:process.env.GIRRU_STORE_FEATURED||'girru:genvr'};

/** The apps that come with Girru, as store manifests (the same apps as My apps). */
const INCLUDED:ReadonlyArray<StoreManifest>=([
 {id:'girru:genvr',name:'GenVR',icon:'globe',category:'worlds',summary:'3D worlds for your agents.',description:'Give your agents a place to live and work: build 3D spaces, walk through them with your team and publish them when you are ready. Uses your GenVR account connection.',permissions:['Uses your GenVR account once you connect it','Publishing a world always waits for your OK']},
 {id:'girru:trading',name:'Trading',icon:'chart',category:'trading',summary:'Practice trading with an agent team.',description:'Paper practice with fictional money and prices: your agents research, propose and keep a journal while nothing real is bought or sold.',permissions:['Practice money only; live orders are not connected','Setting up practice waits for your OK']},
 {id:'girru:terminal',name:'Terminal',icon:'terminal',category:'developer',summary:'Your shell next to your agents.',description:'Command sessions on this computer, beside your chats. Agents only run commands you allow.',permissions:['Uses your computer account when you start a shell']},
 {id:'girru:code',name:'Code',icon:'code',category:'developer',summary:'The project editor beside your chats.',description:'Open a project folder and edit it next to your chats, in the Girru desktop app.',permissions:['Opens only in the Girru desktop app that has the editor','Edits files in the project folder you open']},
] as const).map(x=>({...x,kind:'app' as const,source:'girru' as const,maker:'Girru',verified:true,version:null,updated:null,permissions:[...x.permissions],worksWith:[],languages:[]}));
const INCLUDED_APP:Record<string,string>={'girru:genvr':'genvr','girru:trading':'trading','girru:terminal':'terminal','girru:code':'code'};
/** The id of the app a Girru item opens (for the window's Open button). */
export const includedApp=(id:string)=>INCLUDED_APP[id]??null;

const slugOf=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,64);
const SPECIALTY_SLUGS=new Set((COMPANY_SPECIALTIES as ReadonlyArray<{name:string;department:string}>).flatMap(s=>[slugOf(s.name),slugOf(`${s.name}-${s.department}`)]));
/** A store skill or specialty that ships inside this Girru (its folder, or its name in the company list). */
function comesWithGirru(x:StoreManifest):boolean{
 const id=x.id.slice(6);
 return x.kind==='skill'?/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)&&existsSync(backendPath('skills',id,'SKILL.md')):x.kind==='specialty'?SPECIALTY_SLUGS.has(id):false;
}
const category=(x:unknown):StoreCategoryId=>{const v=typeof x==='string'?x.trim().toLowerCase():'';return STORE_CATEGORIES.find(c=>c.id===v||c.title.toLowerCase()===v)?.id??'more';};

/** Today's source: the local catalogues on this computer. Reading never downloads or installs. */
export function localCatalogue(options:{home?:string;repo?:()=>Promise<RepoRead>}={}):LocalCatalogue{
 let limited:string[]=[],have:Have={installed:new Set(),present:new Set()},asOf:string|null=null,addable=new Set<string>(),code:StoreRuntime|null=null;
 return {
  addable:()=>addable,
  codeRuntime:()=>code,
  limited:()=>limited,
  have:()=>have,
  asOf:()=>asOf,
  async read(ownerId){
   limited=[];have={installed:new Set(),present:new Set()};asOf=null;
   const items:StoreManifest[]=[...INCLUDED];
   // APPS-06: the Girru Store repository. Its words win for the apps that come with Girru;
   // anything else it lists is shown as "store:<id>" (adding those comes with real installs).
   const repo=await (options.repo??readStoreRepo)().catch(():RepoRead=>({index:null,asOf:null,fresh:false}));
   asOf=repo.asOf;if(!repo.fresh)limited.push('store');
   code=repo.runtimes?.[CODE_ITEM]??null;
   const added=await installedApps();
   for(const [id,x] of Object.entries(added))if(x.source==='store')have.installed.add('store:'+id);
   addable=new Set(Object.keys(repo.packages??{}).map(k=>'store:'+k.slice(6)));
   for(const r of repo.index?.items??[]){
    const at=items.findIndex(x=>x.id===r.id);
    if(at>=0)items[at]={...items[at],summary:r.summary||items[at].summary,description:r.description||items[at].description,icon:r.icon??items[at].icon,version:r.id===CODE_ITEM&&code?code.version:r.version,updated:r.updated,category:r.category,permissions:r.permissions.length?r.permissions:items[at].permissions,worksWith:r.worksWith,languages:r.languages};
    // Skills and specialties that come with Girru are already here; anything else waits for its package.
    else items.push(comesWithGirru(r)?r:{...r,id:'store:'+r.id.slice(6)});
   }
   try{
    const {extensions}=await searchMarketplace({userId:ownerId,limit:200,offset:0});
    for(const x of extensions){if(x.installed)have.installed.add('registry:'+x.id);items.push({id:'registry:'+x.id,kind:'app',source:'girru',name:x.name||'Unnamed app',summary:(x.description??'').split(/(?<=\.)\s/)[0]??'',description:x.description??'',icon:null,maker:x.author||'',verified:x.verified===true,version:x.version||null,updated:x.updated_at?String(x.updated_at).slice(0,10):null,category:category(x.category),permissions:x.permissions??[],worksWith:[],languages:[]});}
   }catch{limited.push('registry');}
   const addons=await addonCatalogue(options.home);
   for(const x of addons.items){if(x.present)have.present.add(x.source+':'+x.id);items.push({id:x.source+':'+x.id,kind:'app',source:x.source,name:x.name,summary:x.description.split(/(?<=\.)\s/)[0]??'',description:x.description,icon:null,maker:x.publisher,verified:false,version:null,updated:null,category:'developer',permissions:[],worksWith:[],languages:[]});}
   const of=(source:string)=>items.filter(x=>x.source===source).slice(0,8).map(x=>x.id);
   return parseStoreIndex({schema:1,featured:STORE_CONFIG.featured,collections:[
    {id:'made-by-girru',title:'Made by Girru',items:[...INCLUDED.map(x=>x.id),...items.filter(x=>x.id.startsWith('store:')&&x.maker==='Girru').map(x=>x.id)]},
    {id:'new',title:'New in the store',items:items.filter(x=>x.id.startsWith('store:')).sort((a,b)=>(b.updated??'').localeCompare(a.updated??'')).slice(0,12).map(x=>x.id)},
    {id:'registry',title:'From Girru’s registry',items:items.filter(x=>x.id.startsWith('registry:')).slice(0,8).map(x=>x.id)},
    {id:'claude-code',title:'Claude Code add-ons',items:of('claude-code')},
    {id:'codex',title:'Codex add-ons',items:of('codex')},
   ].filter(c=>c.items.length),items});
  },
 };
}

type Have={installed:Set<string>;present:Set<string>};
/** A source that also knows what this owner already has (installed registry apps, add-ons present on this computer). */
export type LocalCatalogue=CatalogueSource&{limited:()=>string[];have:()=>Have;asOf?:()=>string|null;addable?:()=>Set<string>;codeRuntime?:()=>StoreRuntime|null};

/**
 * CODE-STORE-01: in the desktop app Code is a Store app. It reads as included when the app
 * has it inside or it is installed (with the Store's newer version as its update), as
 * available when the Store has it for this computer, and as elsewhere when it has none.
 */
function codeState(runtime:StoreRuntime|null):{state:StoreState;update:string|null}{
 if(!codeStoreActive()||codeBundled())return {state:'included',update:null};
 const platform=runtimePlatform(),archive=runtime&&platform?runtime.archives[platform]:undefined,installed=installedCodeRuntime();
 // Added from the Store: "installed" (it opens like an app that comes with Girru, and it can be removed).
 if(installed)return {state:'installed',update:archive&&runtime!.version!==installed.version?runtime!.version:null};
 return {state:archive?'available':'elsewhere',update:null};
}

export type StoreState='included'|'installed'|'available'|'elsewhere';
export type StoreEntry=StoreManifest&{state:StoreState;present:boolean;update:string|null;hash:string};
/**
 * The hash an Add is bound to: the item and exactly what it asks for. If the
 * listing changes between showing it and adding it, the Add is refused.
 */
export const consentHash=(x:Pick<StoreManifest,'id'|'version'|'permissions'>)=>createHash('sha256').update(JSON.stringify([x.id,x.version,x.permissions])).digest('hex');

/** The index joined with what this owner has: one call for the whole Store window. */
export async function readStore(ownerId:string,source:LocalCatalogue=localCatalogue()){
 const index:StoreIndex=await source.read(ownerId);
 let updates:Awaited<ReturnType<typeof checkForUpdates>>=[];
 try{updates=await checkForUpdates(ownerId);}catch{/* No registry here: no registry updates. */}
 const {installed:registry,present}=source.have();
 const items:StoreEntry[]=index.items.map(x=>{
  const state:StoreState=x.id.startsWith('girru:')?'included':x.id.startsWith('registry:')?(registry.has(x.id)?'installed':'available'):x.id.startsWith('store:')?(registry.has(x.id)?'installed':source.addable?.().has(x.id)?'available':'elsewhere'):'elsewhere';
  if(x.id===CODE_ITEM){const c=codeState(source.codeRuntime?.()??null);return {...x,state:c.state,present:c.state==='included'||c.state==='installed',update:c.update,hash:consentHash(x)};}
  const update=updates.find(u=>'registry:'+u.extension_id===x.id)?.latest_version??null;
  return {...x,state,present:state==='included'||state==='installed'||present.has(x.id),update:state==='installed'?update:null,hash:consentHash(x)};
 });
 return {schema:index.schema,featured:index.featured,collections:index.collections,// The category row is fixed (SA1 v2); More shows only when something is in it.
 categories:STORE_CATEGORIES.filter(c=>c.id!=='more'||items.some(x=>x.category===c.id)).map(c=>({...c})),items,limited:source.limited(),storeAsOf:source.asOf?.()??null};
}

export type StoreChange={ok:true;state:StoreState|'adding';job?:string;copy?:string|null;restart?:'auto'|'manual'}|{ok:false;code:'not_found'|'not_installable'|'changed'|'refused'|'has_data';message:string;data?:Array<{table:string;rows:number}>};
const registryId=(id:string)=>id.startsWith('registry:')?id.slice(9):null;
const refuseOther=(id:string):StoreChange=>({ok:false,code:'not_installable',message:id.startsWith('girru:')?'It comes with Girru. It is already in My apps.':id.startsWith('store:')?'This app has nothing to add yet.':'Add it in that coding app itself. Girru does not copy its keys.'});

/** Add one registry app, only with the hash of exactly what the owner was shown. */
export async function installFromStore(ownerId:string,id:string,hash:string,options:{restart?:()=>boolean;repo?:()=>Promise<RepoRead>;fetch?:RuntimeFetch}={}):Promise<StoreChange>{
 // CODE-STORE-01: Code (add or update) is a job that downloads its runtime for this computer.
 if(id===CODE_ITEM&&codeStoreActive()&&!codeBundled()){
  const read=options.repo??readStoreRepo,repo=await read();
  const runtime=repo.runtimes?.[CODE_ITEM];
  if(!runtime)return {ok:false,code:'not_found',message:'The Girru Store has no Code for this computer yet.'};
  const item=repo.index?.items.find(i=>i.id===CODE_ITEM),shown=INCLUDED.find(i=>i.id===CODE_ITEM)!;
  if(consentHash({id,version:runtime.version,permissions:item?.permissions.length?item.permissions:shown.permissions})!==hash)return {ok:false,code:'changed',message:'Code changed since you saw it. Read what it asks for again.'};
  const r=await startCodeInstall({repo:async()=>repo,fetch:options.fetch});
  return r.ok?{ok:true,state:'adding',job:r.job.id}:{ok:false,code:r.code,message:r.message};
 }
 // APPS-06: an app from the Girru Store is added by a job the window follows.
 if(id.startsWith('store:')){
  const app=id.slice(6),repo=await (options.repo??readStoreRepo)();
  const x=repo.index?.items.find(i=>i.id==='girru:'+app);
  if(!x||!repo.packages?.['girru:'+app])return {ok:false,code:'not_found',message:'This app is not in the Girru Store any more.'};
  if(consentHash({id,version:x.version,permissions:x.permissions})!==hash)return {ok:false,code:'changed',message:'This app changed since you saw it. Read what it asks for again.'};
  // SA6: never replace a private app that has the same id.
  if((await installedApps())[app]?.source==='private')return {ok:false,code:'refused',message:'You have a private app with the same name. Remove it in My apps first.'};
  const job:AddJob=startAdd(app,{restart:options.restart});
  return {ok:true,state:'adding',job:job.id};
 }
 const ext=registryId(id);if(!ext)return refuseOther(id);
 const x=await getExtensionDetails(ext,ownerId);if(!x||x.status!=='active')return {ok:false,code:'not_found',message:'This app is not in the store any more.'};
 if(consentHash({id,version:x.version||null,permissions:x.permissions??[]})!==hash)return {ok:false,code:'changed',message:'This app changed since you saw it. Read what it asks for again.'};
 const r=await installExtension(ext,ownerId);
 return r.success?{ok:true,state:'installed'}:{ok:false,code:'refused',message:r.error||'It could not be added.'};
}
export async function uninstallFromStore(ownerId:string,id:string,options:{confirm?:boolean;restart?:()=>boolean}={}):Promise<StoreChange>{
 // CODE-STORE-01: removing Code deletes only Girru's own code folder; your projects are never touched.
 if(id===CODE_ITEM&&codeStoreActive()&&!codeBundled()){const r=removeCodeRuntime();return r.ok?{ok:true,state:'available'}:{ok:false,code:r.code==='not_found'?'not_found':'refused',message:r.message};}
 // SA6: a private app (added from a folder) is removed the same way as a Store app.
 if(id.startsWith('store:')||id.startsWith('private:')){
  const r=await removeApp(id.slice(id.indexOf(':')+1),options);
  return r.ok?{ok:true,state:'available',copy:r.copy,restart:r.restart}:r;
 }
 const ext=registryId(id);if(!ext)return refuseOther(id);
 const r=await uninstallExtension(ext,ownerId);
 return r.success?{ok:true,state:'available'}:{ok:false,code:'refused',message:r.error||'It could not be removed.'};
}
