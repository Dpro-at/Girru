import {createPortal} from 'react-dom';
import {AgentRules} from './AgentRules';
import {LibraryPlaces} from './LibrarySection';
import type {LibraryPlace} from './LibrarySection';
import type {RuleAgent} from './agent-rules';
import type {SessionClient} from './session';

/** A second entry to the same persisted rules, using the original editor and permissions. */
export function RulesLibrary({client,active,sidebarSlot,agents,onOpen}:{client:SessionClient;active:boolean;sidebarSlot:HTMLElement|null;agents:readonly RuleAgent[];onOpen:(place:LibraryPlace)=>void}){
 const nav=<LibraryPlaces selected="rules" canManageRules onOpen={onOpen}/>;
 return <section className="agents-destination" aria-label="Library rules">
  {sidebarSlot?(active?createPortal(nav,sidebarSlot):null):nav}
  <AgentRules client={client} active={active} agents={agents}/>
 </section>;
}
