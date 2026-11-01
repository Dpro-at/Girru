import {createPortal} from 'react-dom';
import {UiIcon} from './ui-icons';
import type {UiIconName} from './ui-icons';

export type LibraryPlace='personalities'|'specialties'|'skills'|'rules';
/** Shared Library destinations; protected rules remain owner-only. */
export const LIBRARY_PLACES:ReadonlyArray<{id:LibraryPlace;label:string;icon:UiIconName;words:string}>=[
 {id:'personalities',label:'Personalities',icon:'smile',words:'How an agent talks and behaves.'},
 {id:'specialties',label:'Specialties',icon:'layers',words:'The jobs an agent can do, with their instructions.'},
 {id:'skills',label:'Skills',icon:'star',words:'Guides an agent follows for one kind of work.'},
 {id:'rules',label:'Rules',icon:'scale',words:'Instructions your agents follow before every task.'},
];

export const libraryPlaces=(canManageRules=false)=>LIBRARY_PLACES.filter(place=>canManageRules||place.id!=='rules');
export function LibraryPlaces({onOpen,selected,canManageRules=false}:{onOpen:(place:LibraryPlace)=>void;selected?:LibraryPlace;canManageRules?:boolean}){
 return <nav className="dk-sidebar library-places" aria-label="Library places">
  <p className="section-label dk-label"><span>Library</span></p>
  {libraryPlaces(canManageRules).map(p=><button key={p.id} type="button" className="nav-item dk-place" aria-current={selected===p.id?'page':undefined} title={`Open ${p.label}`} onClick={()=>onOpen(p.id)}><UiIcon name={p.icon} size={15}/><span className="dk-place-name">{p.label}</span><UiIcon name="chevron" size={11}/></button>)}
 </nav>;
}
/** Library destinations share their names, icons and navigation. */
export function LibrarySection({active,sidebarSlot,onOpen,canManageRules=false}:{active:boolean;sidebarSlot?:HTMLElement|null;onOpen:(place:LibraryPlace)=>void;canManageRules?:boolean}){
 const nav=<LibraryPlaces onOpen={onOpen} canManageRules={canManageRules}/>;
 return <section className="library-section" aria-label="Library" data-inline-sidebar={!sidebarSlot||undefined}>
  {sidebarSlot?(active?createPortal(nav,sidebarSlot):null):nav}
  <div className="library-main">
   <header className="library-head"><h2>Library</h2><p>What your agents are built from. Open one to change it; the agent page links here too.</p></header>
   <div className="library-tiles">{libraryPlaces(canManageRules).map(p=><button key={p.id} type="button" className="library-tile" onClick={()=>onOpen(p.id)}><span className="library-tile-icon" aria-hidden="true"><UiIcon name={p.icon} size={24}/></span><span className="library-tile-name">{p.label}</span><small>{p.words}</small></button>)}</div>
  </div>
 </section>;
}
