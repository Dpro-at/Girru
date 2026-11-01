import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { UiIcon } from './ui-icons';

/** The call owns the main stage; the same saved conversation lives in a resizable side panel. */
export function MeetingPanels({ active, onStage, children }: { active: boolean; onStage: (element: HTMLDivElement | null) => void; children: ReactNode }) {
 const root = useRef<HTMLDivElement>(null), dragging = useRef(false), showButton = useRef<HTMLButtonElement>(null);
 const [width, setWidth] = useState(360), [available, setAvailable] = useState(1000), [open, setOpen] = useState(true);
 const hide = () => { setOpen(false); requestAnimationFrame(() => showButton.current?.focus()); };
 const narrow = available < 800, maximum = Math.max(280, Math.min(560, available - 420)), actualWidth = Math.min(width, maximum);
 useEffect(() => { const element = root.current; if (!element) return; const update = () => setAvailable(element.clientWidth); update(); const observer = new ResizeObserver(update); observer.observe(element); return () => observer.disconnect(); }, []);
 useEffect(() => { if (active) setOpen(!narrow); }, [active, narrow]);
 return <div ref={root} className="meeting-panels" data-call={active || undefined} data-chat={open ? 'open' : 'closed'} data-narrow={narrow || undefined} style={{ '--meeting-chat-width': `${actualWidth}px` } as CSSProperties}>
  <div className="meeting-stage" ref={onStage} hidden={!active}/>
  {active && open && !narrow && <div className="meeting-chat-resize" role="separator" aria-label="Resize meeting chat" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={maximum} aria-valuenow={actualWidth} tabIndex={0}
   onPointerDown={e => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerUp={e => { dragging.current = false; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onLostPointerCapture={() => { dragging.current = false; }}
   onPointerMove={e => { if (!dragging.current || !root.current) return; const rect = root.current.getBoundingClientRect(), rtl = getComputedStyle(root.current).direction === 'rtl'; setWidth(Math.max(280, Math.min(maximum, rtl ? e.clientX - rect.left : rect.right - e.clientX))); }}
   onKeyDown={e => { if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return; e.preventDefault(); const rtl = root.current && getComputedStyle(root.current).direction === 'rtl'; setWidth(e.key === 'Home' ? 280 : e.key === 'End' ? maximum : Math.max(280, Math.min(maximum, actualWidth + (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft') ? 24 : -24)))); }}/>}
  <section className="meeting-discussion" aria-label={active ? 'Meeting chat' : 'Chat'} hidden={active && !open} onKeyDown={e => { if (active && narrow && e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); hide(); } }}>
   {active && <header className="meeting-chat-heading"><b>Meeting chat</b><button type="button" className="tool" aria-label="Hide meeting chat" title="Give the meeting the full window" onClick={hide}><UiIcon name="close" size={14}/></button></header>}
   {children}
  </section>
  {active && !open && <button type="button" className="meeting-show-chat" ref={showButton} onClick={() => setOpen(true)} aria-label="Show meeting chat"><UiIcon name="message" size={15}/><span>Chat</span></button>}
 </div>;
}
