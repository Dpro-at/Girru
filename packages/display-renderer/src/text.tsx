import type {ReactNode} from 'react';
import {safeDisplayUrl} from './contract';
/** Small display-only Markdown grammar. HTML is always text; no imports or evaluation. */
function inline(text:string):ReactNode[]{
 const result:ReactNode[]=[];const rx=/(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;let at=0,match:RegExpExecArray|null;
 while((match=rx.exec(text))){result.push(text.slice(at,match.index));const key=String(match.index);if(match[2])result.push(<strong key={key}>{match[2]}</strong>);else if(match[3])result.push(<code key={key}>{match[3]}</code>);else{const href=safeDisplayUrl(match[5]);result.push(href?<a key={key} href={href} target="_blank" rel="noopener noreferrer">{match[4]}</a>:<span key={key}>{match[4]}</span>);}at=match.index+match[0].length;}
 result.push(text.slice(at));return result;
}
export function DisplayMarkdown({text}:{text:string}){
 const lines=text.slice(0,8000).split('\n');let code:string[]|null=null;const parts:ReactNode[]=[];
 for(const [i,line] of lines.entries()){if(line.startsWith('```')){if(code){parts.push(<pre key={i}><code>{code.join('\n')}</code></pre>);code=null;}else code=[];continue;}if(code){code.push(line);continue;}if(/^###? /.test(line))parts.push(<h4 key={i}>{inline(line.replace(/^#+ /,''))}</h4>);else if(/^# /.test(line))parts.push(<h3 key={i}>{inline(line.slice(2))}</h3>);else if(/^[-*] /.test(line))parts.push(<ul key={i}><li>{inline(line.slice(2))}</li></ul>);else if(line.trim())parts.push(<p key={i}>{inline(line)}</p>);}
 if(code)parts.push(<pre key="pending">{code.join('\n')}</pre>);return <div className="display-markdown">{parts}</div>;
}
export function mdcAttributes(raw:string):Record<string,unknown>{
 if(raw.trim().startsWith('{')){const p:unknown=JSON.parse(raw);if(p&&typeof p==='object'&&!Array.isArray(p))return p as Record<string,unknown>;throw Error('Invalid attributes');}
 const props:Record<string,unknown>=Object.create(null);const rx=/([A-Za-z][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;let match:RegExpExecArray|null,at=0;
 while((match=rx.exec(raw))){if(raw.slice(at,match.index).trim())throw Error('Invalid attributes');const value=match[2]??match[3]??match[4];props[match[1]]=match[4]!==undefined&&/^(?:true|false)$/.test(value)?value==='true':match[4]!==undefined&&/^-?\d+(?:\.\d+)?$/.test(value)?Number(value):value;at=rx.lastIndex;}
 if(raw.slice(at).trim())throw Error('Invalid attributes');return props;
}
