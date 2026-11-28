import {useCallback,useEffect,useRef,useState} from 'react';
import type {KeyboardEvent} from 'react';
import type {SessionClient} from './session';
import {UiIcon} from './ui-icons';
import type {UiIconName} from './ui-icons';
import {Sheet} from './desktop-ui';

type Kind='daily'|'manual'|'before-update'|'before-restore';
export type Backup={id:string;kind:Kind;at:string;checked:boolean;size:number;parts:{data:boolean;audit:boolean;keys:boolean};keepUntil:string|null};
export type DestType='folder'|'sftp'|'webdav'|'s3'|'gdrive'|'dropbox'|'onedrive';
export type DestStatus={lastPushAt:string|null;lastOkAt:string|null;lastError:string|null;lastErrorAt:string|null;lastVerifiedAt:string|null;backups:number};
export type Destination={id:string;type:DestType;label:string;folder:string;config:Record<string,string>;enabled:boolean;createdAt:string;status:DestStatus};
/** Types the owner can add today; the rest (cloud) are shown but not yet selectable. */
const DEST_READY:DestType[]=['folder','sftp','webdav','s3'];
/** Direct (self-hosted) places, then cloud places that wait on Girru Connect sign-in. */
const DEST_DIRECT:DestType[]=['folder','sftp','webdav','s3'];
const DEST_CLOUD:DestType[]=['gdrive','dropbox','onedrive'];
const DEST_LABELS:Record<DestType,string>={folder:'External drive or NAS folder',sftp:'SFTP server',webdav:'WebDAV',s3:'S3-compatible storage',gdrive:'Google Drive',dropbox:'Dropbox',onedrive:'OneDrive'};
const DEST_ICON:Record<DestType,UiIconName>={folder:'folder',sftp:'server',webdav:'globe',s3:'box',gdrive:'globe',dropbox:'globe',onedrive:'globe'};
/** A short, human line for where a place is, from its non-secret settings only. */
function placeLocation(d:Destination):string{
 const c=d.config||{};
 if(d.type==='folder')return home(d.folder||c.folder||'');
 if(d.type==='sftp')return `${c.username?c.username+'@':''}${c.host||''}${c.port&&c.port!=='22'?':'+c.port:''}${c.path?'/'+c.path:''}`;
 if(d.type==='webdav')return c.url||'';
 if(d.type==='s3')return `${c.bucket||''}${c.endpoint?' · '+c.endpoint.replace(/^https?:\/\//,''):''}`;
 return DEST_LABELS[d.type];
}
export type BackupStatus={available:true;folder:string;cloud:boolean;defaultFolder:string;runsAt:string;keeps:{days:number;sundays:number;beforeUpdateDays:number;min:number;max:number;presets:number[]};running:boolean;last:Backup|null;next:string;lastError:{message:string;at:string}|null;lastRestore:{id:string;at:string;ok:boolean;error?:string}|null;backups:Backup[]}|{available:false;reason:string};

const DAY=86_400_000;
const time=(d:Date)=>d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
/** "Today 03:00", "Yesterday 03:00", "Oct 26". */
export function backupWhen(at:string,now=new Date()){
 const d=new Date(at),start=new Date(now);start.setHours(0,0,0,0);
 if(d>=start)return `Today ${time(d)}`;
 if(d.getTime()>=start.getTime()-DAY)return `Yesterday ${time(d)}`;
 return d.toLocaleDateString(undefined,{month:'short',day:'numeric',...(d.getFullYear()!==now.getFullYear()?{year:'numeric'}:{})});
}
const lower=(t:string)=>t.charAt(0).toLowerCase()+t.slice(1);
/** When the next one runs: "now", "today 03:00", "tomorrow 03:00". */
export function nextWhen(at:string,now=new Date()){
 const d=new Date(at);if(d<=now)return 'now';
 const start=new Date(now);start.setHours(0,0,0,0);
 if(d.getTime()<start.getTime()+DAY)return `today ${time(d)}`;
 if(d.getTime()<start.getTime()+2*DAY)return `tomorrow ${time(d)}`;
 return d.toLocaleDateString(undefined,{month:'short',day:'numeric'});
}
export function backupKind(b:Backup,now=new Date()){
 if(b.kind==='before-update')return 'before an update';
 if(b.kind==='before-restore')return 'before a restore';
 if(b.kind==='manual')return 'by you';
 return new Date(b.at).getDay()===0&&now.getTime()-new Date(b.at).getTime()>14*DAY?'Sunday':'automatic';
}
const size=(n:number)=>n>=1e9?`${(n/1e9).toFixed(1)} GB`:n>=1e6?`${Math.round(n/1e6)} MB`:`${Math.max(1,Math.round(n/1e3))} KB`;
const day=(at:string)=>new Date(at).toLocaleDateString(undefined,{month:'short',day:'numeric'});
const home=(p:string)=>p.replace(/^\/Users\/[^/]+/,'~').replace(/^\/home\/[^/]+/,'~');
const err=(r:{status:number;body:unknown},fallback:string)=>{const b=r.body as {error?:string}|null;return b&&typeof b.error==='string'?b.error:fallback;};

/**
 * Settings › Backups (BACKUP-01, board Backup1): the daily backup at 03:00 and before
 * every update. One main button (Back up now), the list, the selected backup on the
 * right, and Restore — the one action that asks, because it replaces your data.
 */
export function SettingsBackups({client,active=true}:{client:SessionClient;active?:boolean}){
 const [status,setStatus]=useState<BackupStatus|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const [selected,setSelected]=useState(''),[sheet,setSheet]=useState<null|'restore'|'delete'|'folder'|'retention'|'addplace'>(null),[restarting,setRestarting]=useState<null|boolean>(null);
 const [dests,setDests]=useState<Destination[]>([]),[busyPlace,setBusyPlace]=useState('');
 const list=useRef<HTMLDivElement>(null);
 const load=useCallback(async()=>{
  const r=await client.request({method:'GET',path:'/api/backups'});
  if(r.status!==200){setError('The backups could not be read.');return;}
  const s=r.body as BackupStatus;setStatus(s);setError('');
  if(s.available)setSelected(old=>s.backups.some(b=>b.id===old)?old:s.backups[0]?.id??'');
  const d=await client.request({method:'GET',path:'/api/backups/destinations'});
  if(d.status===200)setDests((d.body as {destinations:Destination[]}).destinations??[]);
 },[client]);
 useEffect(()=>{if(active)void load();},[active,load]);
 useEffect(()=>{if(!notice)return;const t=window.setTimeout(()=>setNotice(''),6000);return()=>window.clearTimeout(t);},[notice]);
 const backUp=async()=>{
  if(busy)return;setBusy(true);setNotice('');setError('');
  try{const r=await client.request({method:'POST',path:'/api/backups',body:{}});if(r.status!==200){setError(err(r,'The backup could not be made.'));return;}const b=(r.body as {backup:Backup}).backup;setNotice(b.checked?'Backed up and checked.':'Backed up, but a part did not pass its check.');setSelected(b.id);await load();}
  finally{setBusy(false);}
 };
 if(error&&!status)return <p role="alert">{error}</p>;
 if(!status)return <p role="status">Loading backups…</p>;
 if(!status.available)return <div className="backups" role="region" aria-label="Backups"><header className="settings-page-head"><h2 className="settings-page-title">Backups</h2><p className="settings-page-desc">{status.reason}.</p></header></div>;
 const s=status,b=s.backups.find(x=>x.id===selected)??null,now=new Date();
 const restore=async()=>{
  if(!b||busy)return;setBusy(true);setError('');
  try{const r=await client.request({method:'POST',path:`/api/backups/${encodeURIComponent(b.id)}/restore`});setSheet(null);if(r.status!==200){setError(err(r,'The restore could not start.'));return;}setRestarting((r.body as {restarting:boolean}).restarting);}
  finally{setBusy(false);}
 };
 const remove=async()=>{
  if(!b||busy)return;setBusy(true);setError('');
  try{const r=await client.request({method:'DELETE',path:`/api/backups/${encodeURIComponent(b.id)}`});setSheet(null);if(r.status!==200){setError(err(r,'The backup could not be deleted.'));return;}setNotice('Backup deleted.');await load();}
  finally{setBusy(false);}
 };
 const show=()=>{if(b)void client.request({method:'POST',path:`/api/backups/${encodeURIComponent(b.id)}/show`});};
 const pushPlace=async(id:string)=>{
  if(busyPlace)return;setBusyPlace(id);setError('');setNotice('');
  try{const r=await client.request({method:'POST',path:`/api/backups/destinations/${encodeURIComponent(id)}/push`});if(r.status!==200){setError(err(r,'The backup could not be sent to that place.'));}else{setNotice('Backup sent and checked at the place.');}await load();}
  finally{setBusyPlace('');}
 };
 const removePlace=async(id:string)=>{
  if(busyPlace)return;setBusyPlace(id);setError('');
  try{const r=await client.request({method:'DELETE',path:`/api/backups/destinations/${encodeURIComponent(id)}`});if(r.status!==200){setError(err(r,'That place could not be removed.'));return;}setNotice('Place removed. The backups already on it stay.');await load();}
  finally{setBusyPlace('');}
 };
 const onListKey=(e:KeyboardEvent)=>{
  const i=s.backups.findIndex(x=>x.id===selected);
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const n=s.backups[Math.min(s.backups.length-1,Math.max(0,i+(e.key==='ArrowDown'?1:-1)))];if(n){setSelected(n.id);list.current?.querySelector<HTMLElement>(`[data-id="${n.id}"]`)?.focus();}}
  if((e.key==='Delete'||e.key==='Backspace')&&b){e.preventDefault();setSheet('delete');}
 };
 if(restarting!==null)return <div className="backups" role="region" aria-label="Backups"><div className="backups-restarting" role="status"><UiIcon name="undo" size={22}/><strong>Putting the backup in place…</strong><p>{restarting?'Girru stops, puts the backup in place and starts again. Then you sign in again.':'Girru puts the backup in place the next time it starts. Start Girru again to finish.'}</p></div></div>;
 const part=(icon:UiIconName,label:string,ok:boolean)=><li><UiIcon name={icon} size={13}/><span>{label}</span><small data-ok={ok||undefined}>{ok?'checked':'not checked'}</small></li>;
 return <div className="backups" role="region" aria-label="Backups">
  <header className="settings-page-head backups-head"><div><h2 className="settings-page-title">Backups</h2><p className="settings-page-desc">Your data, saved every day by itself.</p></div>
   <button type="button" className="primary" disabled={busy||s.running} onClick={()=>void backUp()} title="Back up now"><UiIcon name="shield" size={14}/>{busy||s.running?'Backing up…':'Back up now'}</button></header>
  {s.lastError&&<p className="backups-alert" role="alert"><UiIcon name="alert" size={14}/>The last backup failed ({backupWhen(s.lastError.at,now)}): {s.lastError.message}. Girru tries again within the hour, or back up now.</p>}
  {s.lastRestore&&!s.lastRestore.ok&&<p className="backups-alert" role="alert"><UiIcon name="alert" size={14}/>The last restore did not finish: {s.lastRestore.error}. Your data is in the backup made just before it.</p>}
  {error&&<p className="backups-alert" role="alert">{error}</p>}
  {notice&&<p role="status" className="backups-notice">{notice}</p>}
  <div className="backups-props">
   <div className="backups-prop"><UiIcon name="refresh" size={14}/><span>Runs</span><strong>Every day {s.runsAt} · and before every update</strong></div>
   <button type="button" className="backups-prop" onClick={()=>setSheet('folder')} title="Change where backups are kept"><UiIcon name="folder" size={14}/><span>Kept in</span><strong>{home(s.folder)} <small>· only you can open it</small></strong><UiIcon name="chevron" size={12}/></button>
   {s.cloud&&<p className="backups-alert" role="alert"><UiIcon name="alert" size={14}/>This folder syncs to the cloud. Backups hold the keys to your saved secrets; choose a folder on this computer.</p>}
   <button type="button" className="backups-prop" onClick={()=>setSheet('retention')} title="Change how long backups are kept"><UiIcon name="history" size={14}/><span>Keeps</span><strong>{s.keeps.days} days + {s.keeps.sundays} Sundays</strong><UiIcon name="chevron" size={12}/></button>
  </div>
  <section className="backups-places" aria-label="Where backups go">
   <header className="backups-places-head"><h3>Where backups go</h3><button type="button" className="tool" onClick={()=>setSheet('addplace')} title="Add a place"><UiIcon name="plus" size={15}/>Add a place</button></header>
   <p className="fine-print">Your data is always kept in the folder above. Add other places — an external drive, a NAS, an SFTP or WebDAV server, or S3-compatible storage — for an off-site copy. Backups are encrypted on this computer before they leave, so the place only ever holds scrambled data, and each place’s sign-in is kept in your vault.</p>
   <ul className="backups-places-list">
    <li className="backups-place"><UiIcon name="folder" size={15}/><div className="backups-place-main"><strong>This computer</strong><small>{home(s.folder)} · always on</small></div><small className="backups-place-state" data-ok>baseline</small></li>
    {dests.map(d=><li key={d.id} className="backups-place"><UiIcon name={DEST_ICON[d.type]} size={15}/>
     <div className="backups-place-main"><strong>{d.label}</strong><small>{placeLocation(d)}{d.status.lastOkAt?` · last sent ${lower(backupWhen(d.status.lastOkAt,now))}`:' · not sent yet'}{d.status.lastVerifiedAt?', checked':''}</small>{d.status.lastError&&<small className="backups-place-err"><UiIcon name="alert" size={12}/>{d.status.lastError}</small>}</div>
     <div className="backups-place-actions">
      <button type="button" disabled={!!busyPlace} onClick={()=>void pushPlace(d.id)} title="Send the latest backup to this place">{busyPlace===d.id?'Sending…':'Send now'}</button>
      <button type="button" className="tool" disabled={!!busyPlace} onClick={()=>void removePlace(d.id)} title="Remove this place" aria-label="Remove this place"><UiIcon name="trash" size={14}/></button>
     </div></li>)}
   </ul>
  </section>
  <div className="backups-panes">
   <div className="backups-list" ref={list} role="listbox" aria-label="Backups list" onKeyDown={onListKey}>
    {!s.backups.length?<div className="backups-empty"><UiIcon name="shield" size={24}/><p>No backup yet. Back up now, or Girru makes the first one at {s.runsAt}.</p></div>
     :s.backups.map(x=><button key={x.id} type="button" role="option" data-id={x.id} aria-selected={x.id===selected} tabIndex={x.id===selected?0:-1} className="backups-row" onClick={()=>setSelected(x.id)} onDoubleClick={()=>{setSelected(x.id);setSheet('restore');}}>
      <UiIcon name={x.checked?'shield':'alert'} size={14}/><strong>{backupWhen(x.at,now)}</strong><span>{backupKind(x,now)}</span><small>{size(x.size)}</small></button>)}
    {s.backups.length>0&&<p className="fine-print backups-foot">Last backup: {lower(backupWhen(s.backups[0].at,now))}{s.backups[0].checked?', checked':''}. Next: {nextWhen(s.next,now)}.</p>}
   </div>
   <aside className="backups-inspector" aria-label="Selected backup">
    {!b?<p className="fine-print">Choose a backup to see what is in it.</p>:<>
     <small className="backups-kind">Backup · {backupKind(b,now)}</small>
     <h3>{backupWhen(b.at,now)}</h3>
     <ul className="backups-parts">{part('database','Your data (agents, chats, tasks, memory)',b.parts.data)}{part('shield','The audit log',b.parts.audit)}{part('key','The keys that unlock your saved secrets',b.parts.keys)}</ul>
     <p className="fine-print">{size(b.size)}{b.keepUntil?` · kept until ${day(b.keepUntil)}`:' · kept as a Sunday backup'} · made while Girru was running (a consistent copy).</p>
     <div className="backups-actions">
      <button type="button" disabled={!b.checked||busy} onClick={()=>setSheet('restore')} title={b.checked?'Restore this backup':'This backup did not pass its check'}><UiIcon name="undo" size={14}/>Restore…</button>
      <button type="button" className="tool" onClick={show} title="Show in Finder" aria-label="Show in Finder"><UiIcon name="folder" size={15}/></button>
      <details className="st-menu"><summary className="tool" title="More" aria-label="More"><UiIcon name="more" size={15}/></summary><div role="menu"><button type="button" role="menuitem" onClick={e=>{(e.currentTarget.closest('details') as HTMLDetailsElement).open=false;setSheet('delete');}}><UiIcon name="trash" size={14}/>Delete this backup…</button></div></details>
     </div>
     <p className="fine-print backups-note">Restore puts your data back as it was at this time. Girru first backs up today, so a restore can be undone.</p>
    </>}
   </aside>
  </div>
  {sheet==='restore'&&b&&<Sheet title={`Restore the backup from ${lower(backupWhen(b.at,now))}?`} onClose={()=>setSheet(null)} actions={<><button type="button" onClick={()=>setSheet(null)}>Cancel</button><button type="button" className="primary" disabled={busy} onClick={()=>void restore()}><UiIcon name="undo" size={14}/>{busy?'Backing up…':'Back up and restore'}</button></>}>
   <p>Your data goes back to how it was then. Anything made after that (chats, tasks, memory) leaves your data — it stays in a backup Girru makes right now, so you can bring it back.</p>
   <ul className="backups-steps"><li>Girru backs up now.</li><li>Girru stops, puts this backup in place, and starts again.</li><li>You sign in again.</li></ul>
  </Sheet>}
  {sheet==='delete'&&b&&<Sheet title="Delete this backup?" onClose={()=>setSheet(null)} actions={<><button type="button" onClick={()=>setSheet(null)}>Cancel</button><button type="button" className="primary danger" disabled={busy} onClick={()=>void remove()}>Delete</button></>}>
   <p>The backup from {lower(backupWhen(b.at,now))} is deleted for good. Your data and the other backups stay.</p>
  </Sheet>}
  {sheet==='folder'&&<FolderSheet client={client} status={s} onClose={()=>setSheet(null)} onSaved={async()=>{setSheet(null);setNotice('New backups go to the new folder. The old ones stay where they are.');await load();}}/>}
  {sheet==='retention'&&<RetentionSheet client={client} status={s} onClose={()=>setSheet(null)} onSaved={async(days)=>{setSheet(null);setNotice(`Backups are now kept for ${days} days. Older ones are removed, but never your last ${Math.max(3,s.keeps.min)}.`);await load();}}/>}
  {sheet==='addplace'&&<AddPlaceSheet client={client} onClose={()=>setSheet(null)} onSaved={async(label)=>{setSheet(null);setNotice(`Added “${label}”. Use “Send now” to copy your latest backup there.`);await load();}}/>}
 </div>;
}

/**
 * Add a place backups are copied to (BACKUP-02 slices 3–4). A folder on an
 * external drive or a NAS, an SFTP server, a WebDAV share, or S3-compatible
 * storage. Each place’s sign-in is sent once to be kept in the vault and is
 * never shown again. The cloud providers are shown but wait on Girru Connect —
 * nothing there is faked.
 */
function AddPlaceSheet({client,onClose,onSaved}:{client:SessionClient;onClose:()=>void;onSaved:(label:string)=>void}){
 const [type,setType]=useState<DestType>('folder'),[label,setLabel]=useState('');
 const [f,setF]=useState<Record<string,string>>({port:'22',region:'us-east-1'});
 const [auth,setAuth]=useState<'password'|'key'>('password');
 const [error,setError]=useState(''),[busy,setBusy]=useState(false);
 const v=(k:string)=>f[k]??'';
 const set=(k:string)=>(e:{target:{value:string}})=>setF(s=>({...s,[k]:e.target.value}));
 const ready=DEST_READY.includes(type);
 const canSave=ready&&(
  type==='folder'?!!v('folder').trim():
  type==='sftp'?!!v('host').trim()&&!!v('username').trim()&&(auth==='password'?!!v('password'):!!v('privateKey')):
  type==='webdav'?!!v('url').trim()&&!!v('username').trim()&&!!v('password'):
  type==='s3'?!!v('endpoint').trim()&&!!v('bucket').trim()&&!!v('accessKeyId').trim()&&!!v('secretAccessKey'):false);
 const save=async()=>{
  if(!canSave)return;setBusy(true);setError('');
  const b:Record<string,unknown>={type};
  if(label.trim())b.label=label.trim();
  if(type==='folder')b.folder=v('folder').trim();
  if(type==='sftp'){b.host=v('host').trim();b.username=v('username').trim();if(v('port').trim())b.port=v('port').trim();if(v('path').trim())b.path=v('path').trim();if(auth==='password')b.password=v('password');else{b.privateKey=v('privateKey');if(v('passphrase'))b.passphrase=v('passphrase');}}
  if(type==='webdav'){b.url=v('url').trim();b.username=v('username').trim();b.password=v('password');}
  if(type==='s3'){b.endpoint=v('endpoint').trim();b.bucket=v('bucket').trim();if(v('region').trim())b.region=v('region').trim();if(v('prefix').trim())b.prefix=v('prefix').trim();b.accessKeyId=v('accessKeyId').trim();b.secretAccessKey=v('secretAccessKey');}
  try{const r=await client.request({method:'POST',path:'/api/backups/destinations',body:b});if(r.status!==200){setError(err(r,'That place could not be added.'));return;}onSaved((r.body as {destination:Destination}).destination.label);}
  finally{setBusy(false);}
 };
 const field=(k:string,span:string,props:Record<string,unknown>={})=><label className="backups-field"><span>{span}</span><input value={v(k)} onChange={set(k)} spellCheck={false} {...props}/></label>;
 return <Sheet title="Add a place for backups" onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={busy||!canSave} onClick={()=>void save()}>{busy?'Adding…':'Add place'}</button></>}>
  <div className="backups-place-types" role="radiogroup" aria-label="Kind of place">
   {DEST_DIRECT.map(t=><button key={t} type="button" role="radio" aria-checked={type===t} className="backups-type" onClick={()=>setType(t)}>{DEST_LABELS[t]}</button>)}
  </div>
  <p className="fine-print backups-cloud-note">Cloud places — {DEST_CLOUD.map(t=>DEST_LABELS[t]).join(', ')} — arrive with Girru Connect sign-in. Your data is encrypted here first, and the sign-in stays on this computer.</p>
  {type==='folder'&&<>
   {field('folder','Folder',{autoFocus:true,placeholder:'/Volumes/My Drive/Girru','aria-label':'Destination folder',onKeyDown:(e:KeyboardEvent)=>{if(e.key==='Enter')void save();}})}
   <p className="fine-print">A folder on an external drive or a mounted network share. Because the copy is encrypted here first, a cloud-synced folder is fine too.</p>
  </>}
  {type==='sftp'&&<>
   {field('host','Host',{autoFocus:true,placeholder:'backup.example.com','aria-label':'SFTP host'})}
   {field('port','Port',{type:'number',min:1,max:65535,'aria-label':'SFTP port'})}
   {field('username','User',{placeholder:'girru','aria-label':'SFTP user'})}
   {field('path','Folder on the server (optional)',{placeholder:'backups','aria-label':'Remote folder'})}
   <div className="backups-place-types" role="radiogroup" aria-label="How to sign in">
    <button type="button" role="radio" aria-checked={auth==='password'} className="backups-type" onClick={()=>setAuth('password')}>Password</button>
    <button type="button" role="radio" aria-checked={auth==='key'} className="backups-type" onClick={()=>setAuth('key')}>Private key</button>
   </div>
   {auth==='password'?field('password','Password',{type:'password','aria-label':'SFTP password',autoComplete:'off'}):<>
    <label className="backups-field"><span>Private key</span><textarea value={v('privateKey')} onChange={set('privateKey')} rows={4} spellCheck={false} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" aria-label="SFTP private key"/></label>
    {field('passphrase','Key passphrase (optional)',{type:'password','aria-label':'Key passphrase',autoComplete:'off'})}
   </>}
   <p className="fine-print">The first connection pins the server’s host key, so a swapped server is refused later. Your sign-in is kept in the vault, not here.</p>
  </>}
  {type==='webdav'&&<>
   {field('url','Address',{autoFocus:true,placeholder:'https://dav.example.com/remote.php/dav/files/me','aria-label':'WebDAV address'})}
   {field('username','User',{'aria-label':'WebDAV user'})}
   {field('password','Password',{type:'password','aria-label':'WebDAV password',autoComplete:'off'})}
   <p className="fine-print">An https address (http only to a computer on your own network). The sign-in is kept in the vault.</p>
  </>}
  {type==='s3'&&<>
   {field('endpoint','Endpoint',{autoFocus:true,placeholder:'https://s3.eu-central-1.amazonaws.com','aria-label':'S3 endpoint'})}
   {field('bucket','Bucket',{placeholder:'my-backups','aria-label':'S3 bucket'})}
   {field('region','Region',{placeholder:'us-east-1','aria-label':'S3 region'})}
   {field('prefix','Folder in the bucket (optional)',{placeholder:'girru','aria-label':'S3 prefix'})}
   {field('accessKeyId','Access key ID',{'aria-label':'S3 access key id',autoComplete:'off'})}
   {field('secretAccessKey','Secret key',{type:'password','aria-label':'S3 secret key',autoComplete:'off'})}
   <p className="fine-print">Works with S3, MinIO, Backblaze B2, Wasabi and the like. The secret key is kept in the vault.</p>
  </>}
  <label className="backups-field"><span>Name (optional)</span><input value={label} onChange={e=>setLabel(e.target.value)} placeholder={DEST_LABELS[type]} aria-label="Place name"/></label>
  {error&&<p className="backups-alert" role="alert">{error}</p>}
 </Sheet>;
}

/**
 * How long backups are kept (BACKUP-02 D4): the owner picks 3, 7 or 14 days, or a
 * custom number. The oldest beyond the window are removed automatically, but never
 * the newest few, so a restore is always there.
 */
function RetentionSheet({client,status,onClose,onSaved}:{client:SessionClient;status:Extract<BackupStatus,{available:true}>;onClose:()=>void;onSaved:(days:number)=>void}){
 const min=Math.max(3,status.keeps.min),max=status.keeps.max||3650,presets=status.keeps.presets.length?status.keeps.presets:[3,7,14];
 const [days,setDays]=useState(status.keeps.days),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const clamped=Number.isFinite(days)?Math.round(days):min;
 const valid=Number.isInteger(clamped)&&clamped>=min&&clamped<=max;
 const save=async()=>{
  if(!valid){setError(`Choose between ${min} and ${max} days.`);return;}
  setBusy(true);setError('');
  try{const r=await client.request({method:'PUT',path:'/api/backups/retention',body:{keepDays:clamped}});if(r.status!==200){setError(err(r,'That could not be saved.'));return;}onSaved((r.body as {keepDays:number}).keepDays);}
  finally{setBusy(false);}
 };
 return <Sheet title="How long to keep backups" onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={busy||!valid} onClick={()=>void save()}>{busy?'Saving…':'Save'}</button></>}>
  <div className="backups-keepfor" role="group" aria-label="Keep backups for">
   {presets.map(p=><button key={p} type="button" className="backups-chip" aria-pressed={clamped===p} onClick={()=>setDays(p)}>{p} days</button>)}
  </div>
  <label className="backups-field"><span>Or a custom number of days</span><input type="number" min={min} max={max} value={Number.isFinite(days)?days:''} onChange={e=>setDays(e.target.value===''?NaN:Number(e.target.value))} onKeyDown={e=>{if(e.key==='Enter')void save();}} aria-label="Days to keep backups"/></label>
  <p className="fine-print">Backups older than this are removed on their own. Your newest {min} backups are always kept, and backups made before an update stay for {status.keeps.beforeUpdateDays} days.</p>
  {error&&<p className="backups-alert" role="alert">{error}</p>}
 </Sheet>;
}

function FolderSheet({client,status,onClose,onSaved}:{client:SessionClient;status:Extract<BackupStatus,{available:true}>;onClose:()=>void;onSaved:()=>void}){
 const [folder,setFolder]=useState(home(status.folder)),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const cloud=/(Library\/Mobile Documents|iCloud|Dropbox|Google Drive|OneDrive|CloudStorage|Box Sync)/i.test(folder);
 const save=async()=>{setBusy(true);setError('');try{const r=await client.request({method:'PUT',path:'/api/backups/folder',body:{folder}});if(r.status!==200){setError(err(r,'That folder cannot be used.'));return;}onSaved();}finally{setBusy(false);}};
 return <Sheet title="Where backups are kept" onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={busy||!folder.trim()} onClick={()=>void save()}>Use this folder</button></>}>
  <label className="backups-field"><span>Folder</span><input autoFocus value={folder} onChange={e=>setFolder(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void save();}} aria-label="Backup folder" spellCheck={false}/></label>
  <p className="fine-print">A folder on this computer, outside the data folder. Girru makes it if it is not there, and only you can open it.{status.folder!==status.defaultFolder&&<> <button type="button" className="link" onClick={()=>setFolder(home(status.defaultFolder))}>Use the usual folder</button></>}</p>
  {cloud&&<p className="backups-alert" role="alert"><UiIcon name="alert" size={14}/>This folder syncs to the cloud. Backups hold the keys to your saved secrets.</p>}
  {error&&<p className="backups-alert" role="alert">{error}</p>}
 </Sheet>;
}

/** The red dot on Settings in the footer: the owner's last backup failed. Looks every 10 minutes and on focus. */
export function useBackupAlert(client:SessionClient,owner:boolean){
 const [alert,setAlert]=useState(false);
 useEffect(()=>{
  if(!owner){setAlert(false);return;}
  let stopped=false;
  const look=()=>{void client.request({method:'GET',path:'/api/backups'}).then(r=>{if(stopped||r.status!==200)return;const s=r.body as BackupStatus;setAlert(s.available&&(!!s.lastError||(!!s.lastRestore&&!s.lastRestore.ok&&Date.now()-new Date(s.lastRestore.at).getTime()<DAY)));}).catch(()=>{});};
  look();const t=window.setInterval(look,600_000);window.addEventListener('focus',look);
  return()=>{stopped=true;window.clearInterval(t);window.removeEventListener('focus',look);};
 },[client,owner]);
 return alert;
}
