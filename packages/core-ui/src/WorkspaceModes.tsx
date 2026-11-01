import { useEffect, useRef, useState } from 'react';
import { validWorkspaceState } from './workspace-modes';
import type { WorkspaceMode, WorkspaceModeState } from './workspace-modes';

export function editorBounds() {
  const right=document.querySelector('.app-shell[data-section="code"] .page-chat')?.getBoundingClientRect().width||0;
  return {right,top:Math.max(32,Math.min(160,document.querySelector('.titlebar')?.getBoundingClientRect().bottom||48)),bottom:Math.max(0,Math.min(96,document.querySelector('.app-shell > footer')?.getBoundingClientRect().height||32))};
}

/** Native capability only: ordinary browser and remote-server clients remain unchanged. */
export function useNabuAvailability() {
  const [available,setAvailable]=useState(false);
  const bridge=typeof window==='undefined'?undefined:window.dproApp?.nabu;
  useEffect(()=>{
    if(!bridge)return;
    let active=true;
    const update=(value:unknown)=>{if(active&&validWorkspaceState(value))setAvailable(value.available);};
    const unsubscribe=bridge.onState(update);
    void bridge.status().then(update).catch(()=>{});
    return()=>{active=false;unsubscribe();};
  },[bridge]);
  return available;
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
