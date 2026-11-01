import type {SessionClient} from './session';
import type {UiIconName} from './ui-icons';
import {DEFAULT_FOOTER,FOOTER_PATH,footerPrefs} from './footer-contract.js';
import type {FooterSectionId,FooterValue} from './footer-contract.js';

export type FooterSection=FooterSectionId;
export type FooterPrefs=FooterValue;
type State=Readonly<{prefs:FooterPrefs;undo:FooterPrefs|null;notice:string}>;

/** One name and icon per section, the same in the footer, its menu and Settings. */
export const footerSections:Record<FooterSection,{label:string;icon:UiIconName}>={chat:{label:'Chat',icon:'message'},agents:{label:'Agents',icon:'users'},library:{label:'Library',icon:'book'},board:{label:'Board',icon:'board'},memory:{label:'Memory',icon:'database'},approvals:{label:'Approvals',icon:'shield'},store:{label:'Store',icon:'store'},genvr:{label:'GenVR',icon:'globe'},terminal:{label:'Terminal',icon:'terminal'},code:{label:'Code',icon:'code'},browser:{label:'Browser',icon:'globe'},skills:{label:'Skills',icon:'star'},personalities:{label:'Personalities',icon:'smile'},specialties:{label:'Specialties',icon:'layers'}};
export const usualFooter=():FooterPrefs=>footerPrefs(DEFAULT_FOOTER) as FooterPrefs;

/**
 * The footer choices (SH3). Changes show at once and save in the background;
 * the last one can be undone. Read again when the window comes back, so a
 * change an agent made through MCP shows up.
 */
export class FooterController{
 #state:State={prefs:usualFooter(),undo:null,notice:''};
 #listeners=new Set<()=>void>();
 #seq=0;
 constructor(private client:SessionClient){}
 subscribe=(l:()=>void)=>{this.#listeners.add(l);return()=>{this.#listeners.delete(l);};};
 getSnapshot=()=>this.#state;
 #publish(next:Partial<State>){this.#state={...this.#state,...next};for(const l of this.#listeners)l();}
 async load(){const seq=++this.#seq;try{const r=await this.client.request({method:'GET',path:FOOTER_PATH} as never);if(seq===this.#seq&&r.status===200)this.#publish({prefs:(r.body as {footer:FooterPrefs}).footer});}catch{/* the usual footer stays */}}
 /** Shows the change now; on failure goes back and says so. */
 async change(change:Partial<FooterPrefs>,notice:string){
  const before=this.#state.prefs,seq=++this.#seq;
  this.#publish({prefs:footerPrefs({...before,...change}) as FooterPrefs,undo:before,notice});
  try{const r=await this.client.request({method:'PUT',path:FOOTER_PATH,body:change} as never);if(r.status!==200)throw Error();if(seq===this.#seq)this.#publish({prefs:(r.body as {footer:FooterPrefs}).footer});}
  catch{if(seq===this.#seq)this.#publish({prefs:before,undo:null,notice:'The footer change was not saved.'});}
 }
 toggle(id:FooterSection){const {hidden}=this.#state.prefs,on=hidden.includes(id);void this.change({hidden:on?hidden.filter(x=>x!==id):[...hidden,id]},`${footerSections[id].label} ${on?'shown':'hidden'}`);}
 move(id:FooterSection,before:FooterSection|null){if(id===before)return;const order=this.#state.prefs.order.filter(x=>x!==id),at=before?order.indexOf(before):order.length;order.splice(at<0?order.length:at,0,id);void this.change({order},`${footerSections[id].label} moved`);}
 restore(){const u=usualFooter();void this.change({order:u.order,hidden:u.hidden,iconsOnly:u.iconsOnly,approvalsWhenWaiting:u.approvalsWhenWaiting},'The usual footer is back');}
 undo(){const u=this.#state.undo;if(!u)return;void this.change({order:u.order,hidden:u.hidden,iconsOnly:u.iconsOnly,approvalsWhenWaiting:u.approvalsWhenWaiting},'Undone').then(()=>this.#publish({undo:null}));}
 clearNotice(){if(this.#state.notice)this.#publish({notice:''});}
}

const shared=new WeakMap<SessionClient,FooterController>();
/** One controller per signed-in client, shared by the footer and Settings. */
export function footerFor(client:SessionClient){let c=shared.get(client);if(!c){c=new FooterController(client);shared.set(client,c);}return c;}
