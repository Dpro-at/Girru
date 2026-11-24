import {useEffect,useRef,useState} from 'react';
import type {SessionClient} from './session';
import {PreferenceGroup} from './Preferences';

/**
 * Linking Google to the local account: a fresh Google identity in the browser, then the current local password
 * (and the authenticator code when two-step sign-in is on). Shared by Settings › Account and the Computers page,
 * so a computer is added with the same Google sign-in and is never asked to sign in a second time.
 */
export function useGoogleLink(client:SessionClient,onLinked?:()=>void){
 const [linked,setLinked]=useState<boolean|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[password,setPassword]=useState(''),[code,setCode]=useState(''),[challenge,setChallenge]=useState<{challenge:string;nonce:string}|null>(null),[ready,setReady]=useState(false);
 const flow=useRef<{flowId:string;clientNonce:string}|null>(null),generation=useRef(0),linkedNow=useRef(onLinked);linkedNow.current=onLinked;
 const request=async(op:string,body?:unknown)=>client.request({method:body?'POST':'GET',path:'/api/auth/google/link'+op,...(body?{body}:{})} as never);
 useEffect(()=>{let active=true;void request('').then(r=>{if(active&&r.status===200)setLinked((r.body as any).linked===true);}).catch(()=>{});return()=>{active=false;generation.current++;const f=flow.current;flow.current=null;if(f)void request('/cancel',f).catch(()=>{});};},[client]);
 const finish=async()=>{const f=flow.current;if(!f||!password)return;setBusy(true);setNotice('');const submitted=password;setPassword('');try{const r=await request('/finish',{...f,password:submitted,...(challenge?{verification:{...challenge,code}}:{})}),b=r.body as any;setCode('');if(r.status===200&&b.linked===true){flow.current=null;setReady(false);setLinked(true);setChallenge(null);setNotice('Google sign-in is linked to this account.');linkedNow.current?.();}else if(r.status===200&&b.verificationRequired===true){setChallenge({challenge:b.challenge,nonce:b.nonce});setNotice('Confirm your password and authenticator code to link this identity.');}else if(r.status===401&&b?.code==='invalid_credentials'){setNotice(challenge?'That password or authenticator code is not right. Try again.':'That password is not right. Try again.');}else{flow.current=null;setReady(false);setChallenge(null);setNotice('Linking was refused. Start again after checking your account.');}}catch{setNotice('Linking could not be completed.');}finally{setBusy(false);}};
 const start=async()=>{const gen=++generation.current;setBusy(true);setReady(false);setNotice('Continue in your browser.');const bytes=crypto.getRandomValues(new Uint8Array(32)),clientNonce=btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');try{const r=await request('/start',{clientNonce});if(r.status!==200)throw Error();const f={flowId:(r.body as any).flowId,clientNonce};flow.current=f;for(let i=0;i<240;i++){if(gen!==generation.current)return;const status=await request('/status',f),b=status.body as any;if(status.status!==200||b.state==='failed')throw Error();if(b.state==='ready'){setReady(true);setNotice('Google identity verified. Confirm your current local password to allow linking.');return;}await new Promise(resolve=>setTimeout(resolve,1000));}throw Error();}catch{setNotice('Google identity is unavailable. Nothing was linked.');flow.current=null;}finally{if(gen===generation.current)setBusy(false);}};
 const cancel=()=>{generation.current++;const f=flow.current;flow.current=null;setBusy(false);setReady(false);setPassword('');setCode('');setChallenge(null);setNotice('');if(f)void request('/cancel',f).catch(()=>{});};
 return {linked,busy,notice,password,setPassword,code,setCode,challenge,started:!!flow.current,ready,start,finish,cancel};
}
export type GoogleLink=ReturnType<typeof useGoogleLink>;

/** The password (and authenticator code) step after Google answered. */
export function GoogleLinkConfirm({link,label='Confirm link'}:{link:GoogleLink;label?:string}){
 return <>{link.notice&&/not right/.test(link.notice)&&<p role="alert">{link.notice}</p>}<form onSubmit={e=>{e.preventDefault();void link.finish();}}><label>Current password<input type="password" autoComplete="current-password" value={link.password} required maxLength={4096} onChange={e=>link.setPassword(e.target.value)}/></label>{link.challenge&&<label>Authenticator code<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required maxLength={6} value={link.code} onChange={e=>link.setCode(e.target.value)}/></label>}<button className="primary" disabled={link.busy}>{label}</button></form></>;
}

/** Settings › Account. Linking requires a fresh Google identity and the current local account credential. */
export function GoogleAccountLink({client}:{client:SessionClient}){
 const link=useGoogleLink(client);
 if(client.getSnapshot().mode!=='live'||client.getSnapshot().user?.role==='guest')return null;
 return <PreferenceGroup title="Google sign-in" note="Google verifies identity and email. Linking does not pair computers or grant task permissions."><div className="preference-row"><div className="preference-label"><strong>{link.linked?'Google is linked':'Add Google sign-in'}</strong><small>Your password and recovery methods remain available.</small></div>{!link.linked&&!link.started&&<button disabled={link.busy} onClick={()=>void link.start()}>Link Google account</button>}</div>{link.started&&!link.busy&&<GoogleLinkConfirm link={link}/>}{link.started&&<button type="button" onClick={link.cancel}>Cancel</button>}{link.notice&&<p role="status">{link.notice}</p>}</PreferenceGroup>;
}
