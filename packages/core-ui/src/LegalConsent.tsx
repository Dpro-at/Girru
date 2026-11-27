import {useEffect,useRef,useState} from 'react';
import {canAgreeToPolicy,type LegalPolicy} from './legal-policy-contract.js';
export interface LegalConsentState {status:'loading'|'ready'|'failed';policy?:LegalPolicy}
export function LegalConsent({state,onAgree,onCancel,onRetry}:{state:LegalConsentState;onAgree:()=>void;onCancel:()=>void;onRetry:()=>void}){
 const reader=useRef<HTMLDivElement>(null),heading=useRef<HTMLHeadingElement>(null);
 const [readToEnd,setReadToEnd]=useState(false),[checked,setChecked]=useState(false),[showCue,setShowCue]=useState(false);
 const sync=()=>{const node=reader.current;if(!node)return;const scrollable=node.scrollHeight-node.clientHeight>4,atEnd=node.scrollHeight-node.scrollTop-node.clientHeight<=3;if(state.status==='ready'&&(!scrollable||atEnd))setReadToEnd(true);setShowCue(state.status==='ready'&&scrollable&&node.scrollTop<=8&&!atEnd);};
 useEffect(()=>{setReadToEnd(false);setChecked(false);setShowCue(false);if(reader.current)reader.current.scrollTop=0;heading.current?.focus();const observer=new ResizeObserver(sync);if(reader.current)observer.observe(reader.current);sync();return()=>observer.disconnect();},[state.status,state.policy?.version,state.policy?.contentSha256]);
 const scrollDown=()=>{const node=reader.current;if(node)node.scrollBy({top:node.clientHeight*0.85,behavior:'smooth'});};
 const ready=state.status==='ready'&&!!state.policy;
 return <section className="legal-consent setup-pane" aria-labelledby="legal-consent-title" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();onCancel();}}}>
  <h1 id="legal-consent-title" ref={heading} tabIndex={-1}>Before you continue</h1>
  <p id="legal-read-help">Read the Terms of Use and Privacy Policy, then confirm below. Google sign-in has not started.</p>
  <div className="legal-consent-reader-wrap">
   <div className="legal-consent-reader" ref={reader} tabIndex={0} role="region" aria-label="Terms of Use and Privacy Policy" aria-describedby="legal-read-help" aria-busy={state.status==='loading'} onScroll={sync}>
    {state.status==='loading'&&<p role="status">Loading the current policies…</p>}
    {state.status==='failed'&&<p role="alert">The current policies could not be verified. Try loading them again to continue.</p>}
    {ready&&(['terms','privacy'] as const).map(key=><section key={key}><h2>{state.policy!.documents[key].title}</h2>{state.policy!.documents[key].sections.map((section,index)=><section key={index}><h3>{section.title}</h3>{section.paragraphs.map((text,i)=><p key={i}>{text}</p>)}</section>)}</section>)}
    {ready&&<p className="legal-text-end">End of both documents.</p>}
   </div>
   {showCue&&<button type="button" className="legal-scroll-cue" aria-label="Scroll down to read the rest" onClick={scrollDown}>Scroll down<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>}
  </div>
  <p className="fine-print" role="status" aria-live="polite">{ready?(readToEnd?'End reached. Confirm that you agree to continue.':'Scroll to the end of both documents, or use the arrow keys, Page Down or End.'):state.status==='loading'?'Checking the published version…':'Agreement remains disabled.'}</p>
  <label className="legal-consent-check"><input type="checkbox" checked={checked} disabled={!ready} onChange={e=>setChecked(e.target.checked)}/><span>I have read and agree to the Terms of Use and Privacy Policy.</span></label>
  <div className="legal-consent-actions"><button type="button" className="primary" disabled={!ready||!canAgreeToPolicy(readToEnd,checked)} onClick={onAgree}>Agree and continue</button><button type="button" onClick={onCancel}>Cancel</button>{state.status==='failed'&&<button type="button" onClick={onRetry}>Try again</button>}</div>
 </section>;
}
