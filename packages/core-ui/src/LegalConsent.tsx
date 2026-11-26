import {useEffect,useRef,useState} from 'react';
import {canAgreeToPolicy,type LegalPolicy} from './legal-policy-contract.js';
export interface LegalConsentState {status:'loading'|'ready'|'failed';policy?:LegalPolicy}
export function LegalConsent({state,onAgree,onCancel,onRetry}:{state:LegalConsentState;onAgree:()=>void;onCancel:()=>void;onRetry:()=>void}){
 const reader=useRef<HTMLDivElement>(null),heading=useRef<HTMLHeadingElement>(null);
 const [readToEnd,setReadToEnd]=useState(false),[checked,setChecked]=useState(false);
 const checkEnd=()=>{const node=reader.current;if(state.status==='ready'&&node&&node.scrollHeight-node.scrollTop-node.clientHeight<=3)setReadToEnd(true);};
 useEffect(()=>{setReadToEnd(false);setChecked(false);if(reader.current)reader.current.scrollTop=0;heading.current?.focus();const observer=new ResizeObserver(checkEnd);if(reader.current)observer.observe(reader.current);checkEnd();return()=>observer.disconnect();},[state.status,state.policy?.version,state.policy?.contentSha256]);
 const ready=state.status==='ready'&&!!state.policy;
 return <section className="legal-consent setup-pane" aria-labelledby="legal-consent-title" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();onCancel();}}}>
  <h1 id="legal-consent-title" ref={heading} tabIndex={-1}>Before you continue</h1>
  <p id="legal-read-help">Read the Terms of Use and Privacy Policy, then confirm below. Google sign-in has not started.</p>
  <div className="legal-consent-reader" ref={reader} tabIndex={0} role="region" aria-label="Terms of Use and Privacy Policy" aria-describedby="legal-read-help" aria-busy={state.status==='loading'} onScroll={checkEnd}>
   {state.status==='loading'&&<p role="status">Loading the current policies…</p>}
   {state.status==='failed'&&<p role="alert">The current policies could not be verified. Try loading them again to continue.</p>}
   {ready&&(['terms','privacy'] as const).map(key=><section key={key}><h2>{state.policy!.documents[key].title}</h2>{state.policy!.documents[key].sections.map((section,index)=><section key={index}><h3>{section.title}</h3>{section.paragraphs.map((text,i)=><p key={i}>{text}</p>)}</section>)}</section>)}
   {ready&&<p className="legal-text-end">End of both documents.</p>}
  </div>
  <p className="fine-print" role="status" aria-live="polite">{ready?(readToEnd?'End reached. Confirm that you agree to continue.':'Scroll to the end of both documents. Use the arrow keys, Page Down or End when the text is focused.'):state.status==='loading'?'Checking the published version…':'Agreement remains disabled.'}</p>
  <label className="legal-consent-check"><input type="checkbox" checked={checked} disabled={!ready} onChange={e=>setChecked(e.target.checked)}/><span>I have read and agree to the Terms of Use and Privacy Policy.</span></label>
  <div className="legal-consent-actions"><button type="button" className="primary" disabled={!ready||!canAgreeToPolicy(readToEnd,checked)} onClick={onAgree}>Agree and continue</button><button type="button" onClick={onCancel}>Cancel</button>{state.status==='failed'&&<button type="button" onClick={onRetry}>Try again</button>}</div>
 </section>;
}
