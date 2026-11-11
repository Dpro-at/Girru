import {useContext,useState,useId,type ReactNode} from 'react';
import {normalizeDisplay,displayTree,COMPONENT_TYPES,safeDisplayUrl,type SpecNode} from './contract';
import {str,num,rows,record,bounded,color} from './utils';
import {SpecTable,XYChart,PieChart} from './charts';
import {Candles,Options,Portfolio,Allocation} from './finance';
import {Tabs,TabContent,Field,Choices,ActionButton,Overlay,Calendar,Carousel,Pagination,CommandSearch,Resizable,Support,DisplayHostContext,type DisplayHost} from './controls';
import {DisplayMarkdown,mdcAttributes} from './text';
import {DISPLAY_CSS,DISPLAY_CONTROL_CSS} from './styles';
export type {DisplayHost,DisplayAction} from './controls';
export {COMPONENT_TYPES};
export function parseSpec(text:string):SpecNode|null{const result=normalizeDisplay(text);return result.ok?displayTree(result.document):null;}
export function DisplayDocumentView({input,host={},surface='chat'}:{input:unknown;host?:DisplayHost;surface?:'chat'|'report'|'avatar'}){
 const normalized=normalizeDisplay(input);if(!normalized.ok)return <p className="display-error" role="status" data-display-error={normalized.error}>This display document is invalid or unsupported.</p>;
 return <DisplayHostContext.Provider value={{...host,readOnly:host.readOnly||surface==='report'}}><style>{DISPLAY_CSS+DISPLAY_CONTROL_CSS}</style><div className="spec display-document" data-display-version="1" data-surface={surface} dir="auto"><SpecPart key={JSON.stringify(normalized.document)} node={displayTree(normalized.document)}/></div></DisplayHostContext.Provider>;
}
export function SpecView({text}:{text:string}){return <DisplayDocumentView input={text}/>;}
export function ReportSpecView({document,title,capturedAt,sourceLabel}:{document:unknown;title:string;capturedAt:string;sourceLabel:string}){return <article className="display-report"><header><h2>{title}</h2><p>Saved report · <time>{capturedAt}</time> · {sourceLabel}</p></header><DisplayDocumentView input={document} surface="report"/></article>;}
export function AvatarSpecView({document,host}:{document:unknown;host?:DisplayHost}){return <DisplayDocumentView input={document} host={host} surface="avatar"/>;}
function SpecPart({node}:{node:SpecNode}){return <Part node={node}/>;}
function Part({node:n}:{node:SpecNode}):ReactNode{
 const host=useContext(DisplayHostContext);const p=n.props,kids=n.children.map(c=><SpecPart key={c.id} node={c}/>);const gap=['sm','lg'].includes(str(p.gap))?str(p.gap):'md';
 switch(n.type){
  case 'Card':return <section className="spec-card">{str(p.title)&&<h4>{str(p.title,160)}</h4>}{str(p.description)&&<p className="spec-muted">{str(p.description)}</p>}{kids}</section>;
  case 'Stack':return <div className="spec-stack" data-dir={p.direction==='horizontal'?'h':'v'} data-gap={gap}>{kids}</div>;
  case 'Grid':return <div className="display-grid" style={{display:'grid',gap:gap==='sm'?8:gap==='lg'?24:16,gridTemplateColumns:`repeat(${Math.round(bounded(p.columns,1,6,2))},minmax(0,1fr))`}}>{kids}</div>;
  case 'Separator':return <hr/>;
  case 'Heading':{const Tag=(['h1','h2','h3','h4'].includes(str(p.level))?str(p.level):'h3') as 'h1'|'h2'|'h3'|'h4';return <Tag className="spec-h">{str(p.text,200)}</Tag>;}
  case 'Text':return <p className={p.muted===true?'spec-text spec-muted':'spec-text'} data-size={str(p.size)}>{str(p.content,8000)}</p>;
  case 'Link':{const href=safeDisplayUrl(p.href);return href?<a className="spec-link" href={href} target="_blank" rel="noopener noreferrer">{str(p.text)||href}</a>:<span>{str(p.text)||'Unavailable link'}</span>;}
  case 'Metric':return <div className="spec-metric"><span className="spec-metric-label">{str(p.label,80)}</span><strong className="spec-metric-value">{str(p.value,80)}</strong>{str(p.detail)&&<span className="spec-metric-detail" data-trend={str(p.trend)}>{str(p.detail)}</span>}</div>;
  case 'Badge':return <span className="spec-badge" data-variant={str(p.variant)}>{str(p.text,80)}</span>;
  case 'Table':return <SpecTable props={p}/>;
  case 'Callout':return <aside className="spec-callout" data-type={str(p.type)||'info'}>{str(p.title)&&<strong>{str(p.title)}</strong>}<p>{str(p.content,2000)}</p></aside>;
  case 'Timeline':return <ol className="spec-timeline">{rows(p.items).slice(0,60).map((r,i)=><li key={i} data-status={str(r.status)}><span className="spec-tl-dot"/><div><strong>{str(r.title)}</strong><time>{str(r.date)}</time><p>{str(r.description,1000)}</p></div></li>)}</ol>;
  case 'Accordion':return <section>{rows(p.items).map((r,i)=><details key={i}><summary>{str(r.title)}</summary><p>{str(r.content,2000)}</p></details>)}</section>;
  case 'BarChart':case 'LineChart':case 'AreaChart':return <XYChart kind={n.type} props={p}/>;
  case 'PieChart':return <PieChart props={p}/>;
  case 'StockCandlestickChart':return <Candles p={p}/>;
  case 'OptionsChainTable':return <Options p={p}/>;
  case 'PortfolioPerformanceChart':return <Portfolio p={p}/>;
  case 'AssetAllocationPie':return <Allocation p={p}/>;
  case 'Tabs':return <Tabs p={p}>{kids}</Tabs>;
  case 'TabContent':return <TabContent p={p}>{kids}</TabContent>;
  case 'Button':return <ActionButton id={n.id} type={n.type} p={p}/>;
  case 'ProgressBar':{const max=num(p.max)??100,value=max>0?Math.max(0,Math.min(100,(num(p.value)??0)/max*100)):0;return <div className="spec-progress"><div className="spec-progress-head"><span>{str(p.label)}</span>{p.showPercent!==false&&<span>{Math.round(value)}%</span>}</div><div className="spec-progress-track" role="progressbar" aria-label={str(p.label)||'Progress'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}><i data-color={str(p.color)} style={{inlineSize:`${value}%`}}/></div></div>;}
  case 'Alert':return <aside role="note" className="spec-callout" data-type={str(p.variant)}><strong>{str(p.title)}</strong><p>{str(p.description)}</p></aside>;
  case 'UserCard':return <section className="display-user" data-size={str(p.size)}><span className="display-initials" aria-hidden="true">{str(p.name).slice(0,2)}</span>{safeDisplayUrl(p.src)&&host.renderMedia?.(safeDisplayUrl(p.src)!,str(p.name))}<strong>{str(p.name)}</strong><p>{str(p.role)}</p><span>{str(p.email)}</span>{str(p.src)&&!host.renderMedia&&<small>External portrait not loaded without a media adapter.</small>}</section>;
  case 'SwitchRow':case 'ToggleButton':case 'InputField':case 'SelectField':case 'TextArea':case 'SliderRow':return <Field kind={n.type} p={p}/>;
  case 'CheckboxList':case 'RadioGroup':case 'ToggleGroup':return <Choices kind={n.type} p={p}/>;
  case 'SkeletonBlock':return <div role="status" aria-label="Loading display"><span className="sr-only">Loading display</span>{Array.from({length:Math.round(bounded(p.lines,1,8,3))},(_,i)=><div key={i} className="display-skeleton" data-kind={str(p.type)}/>)}</div>;
  case 'CalendarView':return <Calendar p={p}/>;
  case 'CollapsibleSection':return <details open={p.defaultOpen===true||undefined}><summary>{str(p.title)}</summary>{kids}</details>;
  case 'ScrollBox':return <div style={{overflow:'auto',maxHeight:bounded(p.maxHeight,80,600,300)}}>{kids}</div>;
  case 'TooltipText':return <span title={str(p.tooltip)} className={p.muted===true?'spec-muted':undefined} tabIndex={0}>{str(p.text)}</span>;
  case 'Breadcrumb':return <nav aria-label="Breadcrumb"><ol className="display-breadcrumb">{rows(p.items).map((r,i)=>{const href=safeDisplayUrl(r.href);return <li key={i}>{href?<a href={href} target="_blank" rel="noopener noreferrer">{str(r.label)}</a>:str(r.label)}</li>;})}</ol></nav>;
  case 'PaginationBar':return <Pagination p={p}/>;
  case 'Carousel':return <Carousel p={p}/>;
  case 'HoverCard':return <details><summary>{str(p.triggerText)||'Details'}</summary><strong>{str(p.title)}</strong><p>{str(p.description)}</p></details>;
  case 'OTPDisplay':return <Otp p={p}/>;
  case 'SidePanel':case 'DrawerCard':case 'DialogCard':case 'AlertDialogCard':return <Overlay kind={n.type} id={n.id} p={p}>{kids}</Overlay>;
  case 'DropdownList':return <details><summary>{str(p.label)||'Options'}</summary><ul>{rows(p.items).map((r,i)=>r.separator?<li key={i}><hr/></li>:<li key={i} aria-disabled={r.disabled===true||undefined}>{str(r.label)} <kbd>{str(r.shortcut)}</kbd></li>)}</ul></details>;
  case 'CommandSearch':return <CommandSearch p={p}/>;
  case 'ResizablePanel':return <Resizable p={p}>{kids}</Resizable>;
  case 'AspectBox':return <div style={{aspectRatio:String(bounded(p.ratio,.25,4,16/9)),backgroundColor:color(p.bg,'transparent'),overflow:'auto'}}><span>{str(p.label)}</span>{kids}</div>;
  case 'JsonViewer':return <details open={p.defaultExpanded===true||undefined}><summary>{str(p.title)||'JSON data'}</summary><pre style={{maxHeight:bounded(p.maxHeight,80,600,300),overflow:'auto'}}>{JSON.stringify(p.data,null,2)}</pre></details>;
  case 'MarkdownBlock':return <DisplayMarkdown text={str(p.content,8000)}/>;
  case 'MDCBlock':return <Mdc text={str(p.content,8000)}/>;
  case 'AvatarCard':return <AvatarCard p={p} content={host.avatar}/>;
  case 'SupportChatBlock':case 'AgentSupportPortal':return <Support type={n.type} id={n.id} p={p}/>;
  case 'WeatherCard':return <section className="display-weather" data-size={str(p.size)}><strong>{str(p.location)}</strong><p>{str(p.temperature)}°{str(p.unit)} · {str(p.condition)}</p><p>Humidity {str(p.humidity)}% · Wind {str(p.wind)}{p.feelsLike!=null?' · Feels like '+str(p.feelsLike)+'°':''}</p>{rows(p.forecast).map((r,i)=><p key={i}>{str(r.day)} · {str(r.condition)} · {str(r.low)}°–{str(r.high)}°</p>)}</section>;
  default:return <aside role="status" className="display-unsupported">Unsupported component: {n.type}</aside>;
 }
}
function Otp({p}:{p:Record<string,unknown>}){const [value,setValue]=useState(str(p.code)),id=useId();return <label htmlFor={id}>{str(p.label)||'Code display'}<input id={id} inputMode="numeric" autoComplete="off" value={value} maxLength={bounded(p.length,1,12,6)} placeholder={str(p.placeholder)} onChange={e=>setValue(e.target.value.replace(/\D/g,''))}/><small>This display does not verify a code or grant approval.</small></label>;}
function Mdc({text}:{text:string}){
 const lines=text.split('\n').slice(0,100);return <div>{lines.map((line,i)=>{const match=/^::([A-Za-z]+)\{(.*)\}$/.exec(line.trim());if(!match)return line.trim()==='::'?null:<DisplayMarkdown key={i} text={line}/>;
  if(['MDCBlock','MarkdownBlock','Tabs','TabContent'].includes(match[1]))return <p key={i}>Unsupported nested directive: {match[1]}</p>;
  try{const input={root:'mdc',elements:{mdc:{type:match[1],props:mdcAttributes(match[2]),children:[]}}};const result=normalizeDisplay(input);return result.ok?<SpecPart key={i} node={displayTree(result.document)}/>:<p key={i}>Invalid component directive.</p>;}catch{return <p key={i}>Invalid component directive.</p>;}
 })}</div>;
}

function AvatarCard({p,content}:{p:Record<string,unknown>;content?:ReactNode}){const [hidden,setHidden]=useState(false);if(hidden)return <button type="button" onClick={()=>setHidden(false)}>Show avatar card</button>;return <section data-size={str(p.size)}><strong>{str(p.title)||'Avatar'}</strong>{content??<p>No avatar attached to this view.</p>}{p.removable===true&&<button type="button" onClick={()=>setHidden(true)}>Hide avatar card</button>}</section>;}
