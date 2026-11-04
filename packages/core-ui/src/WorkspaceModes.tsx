import { useEffect, useRef, useState } from 'react';
import { validWorkspaceState } from './workspace-modes';
import type { WorkspaceMode, WorkspaceModeState } from './workspace-modes';

export function editorBounds() {
  const right=document.querySelector('.app-shell[data-section="code"] .page-chat')?.getBoundingClientRect().width||0;
  return {right,top:Math.max(32,Math.min(160,document.querySelector('.titlebar')?.getBoundingClientRect().bottom||48)),bottom:Math.max(0,Math.min(96,document.querySelector('.app-shell > footer')?.getBoundingClientRect().height||32))};
}

/** Native capability only: ordinary browser and remote-server clients remain unchanged. */
export function useNabuAvailability() { return useNabuRuntime().available; }

/**
 * CODE-STORE-01: whether Code opens here, and whether the desktop app has no Code yet
 * (then the footer, ⌘K and Open in Code lead to Code's page in the Store). While Code is
 * missing the bridge is asked again every few seconds, so an install from the Store shows at once.
 */
export function useNabuRuntime() {
  const [state,setState]=useState({available:false,missing:false});
  const bridge=typeof window==='undefined'?undefined:window.dproApp?.nabu;
  useEffect(()=>{
    if(!bridge)return;
    let active=true,timer:ReturnType<typeof setTimeout>|undefined;
    const update=(value:unknown)=>{
      if(!active||!validWorkspaceState(value))return;
      const next={available:value.available,missing:!value.available&&value.runtime==='missing'};
      setState(s=>s.available===next.available&&s.missing===next.missing?s:next);
      clearTimeout(timer);
      // Asked again: every 4 s while Code is missing (an install shows at once), every 10 s otherwise (a removal shows too).
      timer=setTimeout(ask,next.missing?4000:10000);
    };
    const ask=()=>{void bridge.status().then(update).catch(()=>{});};
    const unsubscribe=bridge.onState(update);
    ask();
    return()=>{active=false;clearTimeout(timer);unsubscribe();};
  },[bridge]);
  return state;
}

export function WorkspaceModes({onModeChange}:{onModeChange:(mode:WorkspaceMode)=>void}) {
  const [state, setState] = useState<WorkspaceModeState | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const bridge = typeof window==='undefined'?undefined:window.dproApp?.nabu;
  const previousMode=useRef<WorkspaceMode>('chat');
  const onMode=useRef(onModeChange);onMode.current=onModeChange;
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const update = (value: unknown) => {
      if (!active || !validWorkspaceState(value)) return;
      setState(value);
      if(previousMode.current!==value.mode){previousMode.current=value.mode;onMode.current(value.mode);}
    };
    const unsubscribe = bridge.onState(update);
    void bridge.status().then(update).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  useEffect(() => {
    const header = ref.current?.closest('header') || document.querySelector<HTMLElement>('.titlebar');
    if (!header || !bridge) return;
    header.dataset.nabuMode = state?.mode || 'chat';
    const measure = () => {const {top,bottom,right}=editorBounds();bridge.layout(top,bottom,right);};
    measure();
    const observer = new ResizeObserver(measure); observer.observe(header);
    const footer=document.querySelector('.app-shell > footer');if(footer)observer.observe(footer);
    const chat=document.querySelector('.page-chat');if(chat)observer.observe(chat);
    return () => { observer.disconnect(); delete header.dataset.nabuMode; };
  }, [bridge, state?.available, state?.mode]);
  if (!bridge || !state?.available) return null;
  return <div className="workspace-modes" ref={ref}>
    <span role={state.error ? 'alert' : 'status'} className="workspace-mode-notice">{state.error || (state.busy ? 'Opening editor…' : '')}</span>
  </div>;
}
