import {useEffect,useRef,useState} from 'react';
import {UiIcon} from './ui-icons';
import {orientedViewport,validViewport,type BrowserViewport,type DevicePreset} from './browser-devices';
const icons={phone:'device-phone',foldable:'device-foldable',tablet:'device-tablet',laptop:'laptop',desktop:'device-desktop',tv:'device-tv'} as const;
export function BrowserDeviceMenu({presets,selected,viewport,onChoose}:{presets:DevicePreset[];selected:string;viewport:BrowserViewport|null;onChoose:(id:string,viewport:BrowserViewport|null)=>Promise<void>}){
 const root=useRef<HTMLDetailsElement>(null),search=useRef<HTMLInputElement>(null);
 const [query,setQuery]=useState(''),[width,setWidth]=useState(390),[height,setHeight]=useState(844),[mobile,setMobile]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const preset=presets.find(p=>p.id===selected),current=viewport||preset||{width,height,mobile};
 useEffect(()=>{if(viewport){setWidth(viewport.width);setHeight(viewport.height);setMobile(viewport.mobile);}},[viewport?.width,viewport?.height,viewport?.mobile,selected]);
 useEffect(()=>{const close=(e:PointerEvent)=>{if(root.current?.open&&!root.current.contains(e.target as Node))root.current.open=false;};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[]);
 const choose=async(id:string,value:BrowserViewport|null)=>{if(busy)return;setBusy(true);setError('');try{await onChoose(id,value);}catch{setError('This size could not be applied. Try again.');}finally{setBusy(false);}};
 const visible=presets.filter(p=>(p.name+' '+p.group+' '+p.width+'x'+p.height).toLowerCase().includes(query.trim().toLowerCase().replace(/ × /g,'x'))),groups=[...new Set(visible.map(p=>p.group))];
 const orientation=async(portrait:boolean)=>choose(selected==='fit'?'custom':selected,orientedViewport(current,portrait));
 return <details ref={root} className="browser-device" onToggle={event=>{if(event.target===root.current&&root.current?.open)search.current?.focus();}} onKeyDown={e=>{if(e.key==='Escape'&&root.current?.open){e.stopPropagation();root.current.open=false;root.current.querySelector('summary')?.focus();}}}>
  <summary className="tool" aria-label="Device sizes" title={`Device size: ${selected==='fit'?'Fit window':preset?.name||'Custom size'}`}><UiIcon name="devices" size={18}/></summary>
  <div className="browser-device-panel" role="dialog" aria-label="Device size">
   <header>Device</header><div className="browser-device-search"><UiIcon name="search" size={14}/><input ref={search} value={query} onChange={e=>setQuery(e.target.value)} placeholder="Find a device" aria-label="Find a device"/></div>
   <div className="browser-device-list"><button disabled={busy} className="browser-device-option" aria-pressed={selected==='fit'} onClick={()=>void choose('fit',null)}><UiIcon name="screen" size={19}/><span>Fit window</span>{selected==='fit'&&<UiIcon name="check" size={15}/>}</button>
    {!presets.length&&<p role="status">Loading device sizes…</p>}{groups.map(group=><section key={group} aria-label={group}><h3>{group}</h3>{visible.filter(p=>p.group===group).map(p=><button disabled={busy} key={p.id} className="browser-device-option" aria-pressed={selected===p.id} title={`${p.name} · ${p.width} × ${p.height}`} onClick={()=>void choose(p.id,{width:p.width,height:p.height,mobile:p.mobile})}><UiIcon name={icons[p.kind]} size={19}/><span>{p.name}<small>{p.width.toLocaleString()} × {p.height.toLocaleString()}</small></span>{selected===p.id&&<UiIcon name="check" size={15}/>}</button>)}</section>)}{presets.length>0&&!visible.length&&<p role="status">No matching devices. Use a custom size below.</p>}
   </div>
   <div className="browser-device-orientation"><span>Orientation</span><div role="group" aria-label="Orientation"><button disabled={busy} aria-pressed={current.height>=current.width} onClick={()=>void orientation(true)}><UiIcon name="device-phone" size={15}/>Portrait</button><button disabled={busy} aria-pressed={current.width>current.height} onClick={()=>void orientation(false)}><UiIcon name="device-landscape" size={15}/>Landscape</button></div></div>
   <details className="browser-device-custom"><summary>Custom size</summary><div className="browser-custom-dimensions"><label>Width<input type="number" min={240} max={8192} value={width} onChange={e=>setWidth(Number(e.target.value))}/></label><label>Height<input type="number" min={240} max={8192} value={height} onChange={e=>setHeight(Number(e.target.value))}/></label></div><label className="browser-mobile-layout"><input type="checkbox" checked={mobile} onChange={e=>setMobile(e.target.checked)}/>Mobile layout and touch</label><button disabled={busy} onClick={()=>{if(!validViewport(width,height)){setError('Choose whole-number sizes between 240 and 8192 pixels.');return;}void choose('custom',{width,height,mobile});}}>Apply size</button></details>
   {error&&<p role="alert">{error}</p>}
  </div>
 </details>;
}
