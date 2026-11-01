import {useEffect,useRef,useState} from 'react';
import type {CodeReview} from './workspace-modes';

/** Only the saved approval card owns the authenticated decision; Code never receives session access. */
export function NativeFileReview({value,onDecision}:{value:CodeReview;onDecision:(decision:'approve'|'deny')=>void}){
 const decision=useRef(onDecision);decision.current=onDecision;
 const [opened,setOpened]=useState(false);
 const open=async()=>{try{setOpened(await window.dproApp?.nabu?.review?.(value)===true);}catch{setOpened(false);}};
 useEffect(()=>{const bridge=window.dproApp?.nabu;const unsubscribe=bridge?.onReviewDecision?.(event=>{if(event.id===value.id)decision.current(event.decision);});void open();return()=>{unsubscribe?.();void bridge?.clearReview?.(value.id);};},[value.id,value.path,value.before,value.after]);
 return <p className="moment-line">{opened?'File change is waiting in Code.':'Review this file change in Code.'} <button type="button" className="link-button" onClick={()=>void open()}>Open comparison</button></p>;
}
