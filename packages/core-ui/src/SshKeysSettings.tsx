// SSH-KEYS-01 (board SK1): Settings › Security › SSH keys. A quiet list of the keys on this computer,
// the selected key's facts beside it. Only public facts are shown and only the public key can be copied;
// a private key file is never opened (the backend only checks that it is there).
import {useEffect,useRef,useState} from 'react';
import type {KeyboardEvent as ReactKeyboardEvent} from 'react';
import type {SessionClient} from './session';
import type {SshKey} from './ssh-keys-contract.js';
import {UiIcon} from './ui-icons';
import {ContextMenu,IconButton,Notice,useMenu,type MenuItem} from './desktop-ui';
import {canRevealFolder,revealFolder} from './chat-actions';

const typeWords=(k:SshKey)=>!k.type?'No public key':k.type==='ssh-ed25519'?'Ed25519':k.type==='ssh-rsa'?'RSA':k.type.startsWith('ecdsa')?'ECDSA':k.type.startsWith('sk-')?'Security key':k.type;
const short=(k:SshKey)=>!k.type?'—':k.type==='ssh-ed25519'?'ED':k.type==='ssh-rsa'?'RSA':k.type.startsWith('sk-')?'SK':'EC';

export function SshKeysSettings({client,active=true}:{client:SessionClient;active?:boolean}){
 const [keys,setKeys]=useState<SshKey[]|null>(null),[failed,setFailed]=useState(false),[selected,setSelected]=useState(''),[tick,setTick]=useState(0);
 const [toast,setToast]=useState<{id:number;text:string;undo:boolean}|null>(null),list=useRef<HTMLUListElement>(null),{menu,at,close}=useMenu();
 useEffect(()=>{if(!active)return;let live=true;setFailed(false);void client.request({method:'GET',path:'/api/security/ssh-keys'} as never).then(r=>{if(!live)return;if(r.status!==200)throw Error();const k=(r.body as {keys:SshKey[]}).keys;setKeys(k);setSelected(s=>s&&k.some(x=>x.id===s)?s:k[0]?.id??'');}).catch(()=>{if(live)setFailed(true);});return()=>{live=false;};},[client,active,tick]);
 const key=keys?.find(k=>k.id===selected);
 const say=(text:string)=>setToast({id:Date.now(),text,undo:false});
 const copyPublic=async(k:SshKey)=>{try{const r=await client.request({method:'GET',path:`/api/security/ssh-keys/${k.id}/public`} as never);if(r.status!==200)throw Error();await navigator.clipboard.writeText((r.body as {publicKey:string}).publicKey);say('Public key copied. The private key stays in its file.');}catch{say('The public key could not be copied.');}};
 const copyPrint=async(k:SshKey)=>{if(!k.fingerprint)return;try{await navigator.clipboard.writeText(k.fingerprint);say('Fingerprint copied.');}catch{say('The fingerprint could not be copied.');}};
 const reveal=canRevealFolder(),finder=typeof navigator!=='undefined'&&/Win/i.test(navigator.userAgent)?'Show in Explorer':'Show in Finder';
 const actions=(k:SshKey):MenuItem[]=>[{label:'Copy public key',icon:'copy',shortcut:'⌘C',run:()=>void copyPublic(k),disabled:!k.hasPublic},{label:'Copy fingerprint',icon:'copy',run:()=>void copyPrint(k),disabled:!k.fingerprint},...(reveal?['sep' as const,{label:finder,icon:'folder' as const,run:()=>revealFolder(k.folder)}]:[])];
 const move=(e:ReactKeyboardEvent<HTMLButtonElement>,k:SshKey)=>{
  if(e.key==='ContextMenu'||e.shiftKey&&e.key==='F10'){at(e,actions(k));return;}
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='c'&&k.hasPublic){e.preventDefault();void copyPublic(k);return;}
  if(!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;e.preventDefault();const rows=[...(list.current?.querySelectorAll<HTMLButtonElement>('.ssh-row')??[])],i=rows.indexOf(e.currentTarget),next=e.key==='Home'?0:e.key==='End'?rows.length-1:(i+(e.key==='ArrowDown'?1:-1)+rows.length)%rows.length;rows[next]?.focus();rows[next]?.click();
 };
 return <div className="ssh-keys">
  <div className="ssh-list-pane">
   <div className="ssh-list-head"><span>{keys?`${keys.length} ${keys.length===1?'key':'keys'} in ~/.ssh`:'Keys in ~/.ssh'}</span><IconButton icon="refresh" label="Look again" onClick={()=>setTick(n=>n+1)}/></div>
   {failed?<div className="dk-empty"><p>The keys could not be read.</p><button type="button" onClick={()=>setTick(n=>n+1)}>Try again</button></div>
   :!keys?<p className="dk-empty" role="status">Looking…</p>
   :!keys.length?<div className="dk-empty"><UiIcon name="key" size={24}/><p>No SSH keys on this computer yet. Keys you make with ssh-keygen show here by themselves.</p></div>
   :<ul className="ssh-rows" ref={list} aria-label="SSH keys">{keys.map(k=><li key={k.id}><button type="button" className="ssh-row" aria-pressed={selected===k.id} onKeyDown={e=>move(e,k)} onClick={()=>setSelected(k.id)} onContextMenu={e=>{setSelected(k.id);at(e,actions(k));}}>
    <span className="ssh-type" data-type={short(k)} aria-hidden="true">{short(k)}</span>
    <span className="ssh-row-text"><strong>{k.name}</strong><small dir="ltr">{k.fingerprint?`${k.fingerprint.slice(0,19)}…`:'Private key only'}{k.comment?` · ${k.comment}`:''}</small></span>
    {k.hosts.length>0&&<small className="ssh-hosts-count">{k.hosts.length} {k.hosts.length===1?'host':'hosts'}</small>}
   </button></li>)}</ul>}
  </div>
  <aside className="ssh-inspector" aria-label="Selected SSH key">{!key?<div className="dk-empty"><UiIcon name="key" size={24}/><p>Select a key to see it.</p></div>:<div className="dk-insp">
   <div className="dk-insp-head"><span className="ssh-type ssh-type-big" data-type={short(key)} aria-hidden="true">{short(key)}</span><div><h3>{key.name}</h3><p className="fine-print">{typeWords(key)}{key.bits?` · ${key.bits} bits`:''}</p></div><span className="dk-insp-icons"><IconButton icon="more" label={`More actions for ${key.name}`} onClick={e=>at(e,actions(key))}/></span></div>
   {key.hasPublic?<button type="button" className="primary ssh-copy" onClick={()=>void copyPublic(key)}><UiIcon name="copy" size={14}/>Copy public key</button>
   :<p className="mcp-next" data-tone="warn">This key has no public half next to it, so there is nothing to copy. Make one with <code>ssh-keygen -y</code> if you need it.</p>}
   <dl className="mcp-facts">
    <div><dt>Fingerprint</dt><dd><code dir="ltr">{key.fingerprint??'—'}</code>{key.fingerprint&&<IconButton icon="copy" label="Copy fingerprint" onClick={()=>void copyPrint(key)}/>}</dd></div>
    {key.comment&&<div><dt>Comment</dt><dd dir="ltr">{key.comment}</dd></div>}
    <div><dt>Where</dt><dd><span dir="ltr">{key.where}</span>{reveal&&<IconButton icon="folder" label={finder} onClick={()=>revealFolder(key.folder)}/>}</dd></div>
   </dl>
   <section className="mcp-block" aria-label="Used for"><h4>Used for</h4>{key.hosts.length?<ul className="ssh-used">{key.hosts.map(h=><li key={h.alias}><UiIcon name="server" size={13}/><span><strong>{h.alias}</strong>{h.host&&<small dir="ltr">{h.host}</small>}</span></li>)}</ul>:<p className="fine-print">No host in ~/.ssh/config names this key.</p>}</section>
   <p className="fine-print"><UiIcon name="lock" size={12}/> The private key stays in its file. Girru never opens it.</p>
  </div>}</aside>
  <ContextMenu menu={menu} onClose={close}/>
  <Notice toast={toast} onUndo={()=>{}} onDone={id=>setToast(t=>t?.id===id?null:t)}/>
 </div>;
}
