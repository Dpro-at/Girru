import {useEffect,useRef,useState} from 'react';
export type NativeBrowserPrompt={id:string;texts:string[];actions:{id:string;label:string;enabled:boolean}[]};
/** Chromium owns the request and its actions; this sheet only presents them. */
export function BrowserNativePrompt({prompt,onRespond}:{prompt:NativeBrowserPrompt;onRespond:(prompt:string,button:string)=>Promise<void>}){
 const dialog=useRef<HTMLDialogElement>(null),heading=useRef<HTMLHeadingElement>(null);
 const [busy,setBusy]=useState(false),[problem,setProblem]=useState('');
 useEffect(()=>{dialog.current?.showModal();heading.current?.focus();return()=>dialog.current?.close();},[]);
 return <dialog ref={dialog} className="browser-native-prompt" aria-labelledby="browser-request-title" onCancel={event=>event.preventDefault()}>
  <header><span>Browser request</span><h2 id="browser-request-title" ref={heading} tabIndex={-1}>{prompt.texts[0]}</h2></header>
  <div className="browser-permission-text">{prompt.texts.slice(1).map((text,index)=><p key={index}>{text}</p>)}</div>
  <p className="fine-print">Review this request from Chromium before continuing.</p>
  {problem&&<p role="alert">{problem}</p>}
  <footer>{prompt.actions.map(action=><button key={action.id} disabled={busy||!action.enabled} onClick={()=>{setBusy(true);setProblem('');void onRespond(prompt.id,action.id).catch(()=>setProblem('This request changed. Review it again.')).finally(()=>setBusy(false));}}>{action.label}</button>)}</footer>
 </dialog>;
}
