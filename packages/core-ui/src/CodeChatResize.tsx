import {useEffect,useRef,useState} from 'react';

export function codeChatWidth(value:number,available:number){return Math.round(Math.max(280,Math.min(Math.max(280,available-320),value)));}

/** Resizes the existing chat; the native editor observes its actual width. */
export function CodeChatResize({onResize}:{onResize:()=>void}){
 const handle=useRef<HTMLDivElement>(null),dragging=useRef(false);
 const [width,setWidth]=useState(420),[available,setAvailable]=useState(1280);
 const apply=(value:number)=>{const next=codeChatWidth(value,window.innerWidth);setWidth(next);handle.current?.closest<HTMLElement>('.page-chat')?.style.setProperty('--code-chat-width',`${next}px`);};
 useEffect(()=>{const resize=()=>{setAvailable(window.innerWidth);const current=handle.current?.closest<HTMLElement>('.page-chat')?.getBoundingClientRect().width??420;apply(current);};apply(420);setAvailable(window.innerWidth);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
 return <div ref={handle} className="code-chat-resize" role="separator" aria-label="Resize Code chat" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={Math.max(280,available-320)} aria-valuenow={width} tabIndex={0}
  onPointerDown={e=>{onResize();dragging.current=true;e.currentTarget.setPointerCapture(e.pointerId);}}
  onPointerMove={e=>{if(dragging.current)apply(window.innerWidth-e.clientX);}}
  onPointerUp={e=>{dragging.current=false;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}}
  onLostPointerCapture={()=>{dragging.current=false;}}
  onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();onResize();const current=handle.current?.closest<HTMLElement>('.page-chat')?.getBoundingClientRect().width??width;apply(e.key==='Home'?420:e.key==='End'?available-320:current+(e.key==='ArrowLeft'?24:-24));}}/>;
}
