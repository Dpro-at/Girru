import {useEffect,useState,useSyncExternalStore} from 'react';
import type {SessionClient} from './session';
import {UiIcon} from './ui-icons';
import {PreferenceGroup,PreferenceRow} from './Preferences';
import {footerFor,footerSections} from './footer-prefs';
import {useNabuRuntime} from './WorkspaceModes';
import type {FooterSection} from './footer-prefs';

const ownerOnly:ReadonlyArray<FooterSection>=['library','computers','terminal','code','skills','personalities','specialties'];

/** SH3b: Settings › General › Footer. Tick to show, drag to reorder; saves at once. */
export function FooterSettings({client}:{client:SessionClient}){
 const controller=footerFor(client),{prefs}=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot),[dragging,setDragging]=useState<FooterSection|null>(null);
 useEffect(()=>{void controller.load();},[controller]);
 const owner=client.getSnapshot().user?.role==='owner',guest=client.getSnapshot().user?.role==='guest';
 const nabu=useNabuRuntime(),editor=nabu.available||nabu.missing; // CODE-STORE-01: a missing Code is still offered (it opens the Store)
 const rows=prefs.order.filter(id=>(owner||!ownerOnly.includes(id))&&!(guest&&id==='approvals')&&(id!=='code'||editor));
 return <PreferenceGroup title="Footer" note="Hidden sections stay in ⌘K. Settings always stays in the footer.">
  <div className="footer-settings">
   <ol aria-label="Footer sections">{rows.map(id=>{const on=!prefs.hidden.includes(id),s=footerSections[id];return <li key={id} data-off={!on||undefined} data-dragging={dragging===id||undefined} draggable
     onDragStart={e=>{setDragging(id);e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',id);}} onDragEnd={()=>setDragging(null)}
     onDragOver={e=>{if(dragging&&dragging!==id)e.preventDefault();}} onDrop={e=>{e.preventDefault();if(dragging)controller.move(dragging,id);setDragging(null);}}>
     <span className="grip" title="Drag to reorder" aria-hidden="true"><UiIcon name="grip" size={14}/></span>
     <input type="checkbox" id={`footer-${id}`} checked={on} onChange={()=>controller.toggle(id)}/>
     <UiIcon name={s.icon} size={15}/><label className="footer-name" htmlFor={`footer-${id}`}>{s.label}</label>
     {id==='approvals'&&on&&prefs.approvalsWhenWaiting&&<small>Comes back when something waits</small>}{!on&&<small>{id==='genvr'||id==='terminal'||id==='code'?'Hidden · still in ⌘K · can be pinned from Apps':'Hidden · still in ⌘K'}</small>}
    </li>;})}</ol>
  </div>
  <PreferenceRow title="Show" icon="sliders"><span role="radiogroup" aria-label="Footer shows" className="perm-seg"><button type="button" role="radio" aria-checked={!prefs.iconsOnly} onClick={()=>prefs.iconsOnly&&void controller.change({iconsOnly:false},'Names shown')}>Icons and names</button><button type="button" role="radio" aria-checked={prefs.iconsOnly} onClick={()=>!prefs.iconsOnly&&void controller.change({iconsOnly:true},'Icons only')}>Icons only</button></span></PreferenceRow>
  {!guest&&<PreferenceRow title="Bring Approvals back when something waits" description="Only when Approvals is hidden." icon="shield"><input type="checkbox" role="switch" aria-label="Bring Approvals back when something waits" checked={prefs.approvalsWhenWaiting} onChange={e=>void controller.change({approvalsWhenWaiting:e.target.checked},e.target.checked?'Approvals comes back when something waits':'Approvals stays hidden')}/></PreferenceRow>}
  <div className="footer-row"><span/><button type="button" onClick={()=>controller.restore()}>Restore the usual footer</button></div>
 </PreferenceGroup>;
}
