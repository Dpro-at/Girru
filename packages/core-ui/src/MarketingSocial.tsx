import {useEffect,useRef,useState} from 'react';
import type {StudioController,StudioAccount} from 'agent-connect-dpro/studio';
import type {SessionClient} from './session';
import {draftStore,mountMarketingSocial,socialAccounts} from './marketing-social.mjs';
export function MarketingSocial({client,status}:{client:SessionClient;status:{scopes?:string[];connectionId?:string}}){
 const host=useRef<HTMLDivElement>(null),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let cancelled=false;let current:StudioController|undefined;let observer:MutationObserver|undefined;
  (async()=>{setNotice('');let accounts:StudioAccount[]=[];let accountsAvailable=false;let store;try{store=draftStore(localStorage,client.getSnapshot().user!.id,status.connectionId!);}catch{/* Saving remains unavailable without a connection-scoped draft store. */}
   if(status.scopes?.includes('read:social')){try{setBusy(true);const response=await client.request({method:'POST',path:'/api/ext/seo/marketing/read',body:{tool:'marketing_social_accounts',arguments:{}}});if(response.status!==200)throw Error();accounts=socialAccounts(response.body);accountsAvailable=true;}catch{if(!cancelled)setNotice('Social account access is unavailable. Your existing accounts have not changed.');}finally{if(!cancelled)setBusy(false);}}
   else setNotice('The connected SEO Agent server has not enabled social account access yet. The package editor and previews are available; account actions and publication are unavailable.');
   const {mountSocialStudio}=await import('agent-connect-dpro/studio');if(cancelled||!host.current)return;
   const theme=()=>document.querySelector('.shell')?.getAttribute('data-theme')==='dark'?'dark' as const:'light' as const;
   current=await mountMarketingSocial(host.current,{mount:mountSocialStudio,accounts,store,accountsAvailable,theme:theme()});if(cancelled){current.destroy();return;}
   const shell=document.querySelector('.shell');if(shell){observer=new MutationObserver(()=>current?.setTheme(theme()));observer.observe(shell,{attributes:true,attributeFilter:['data-theme']});}
  })().catch(()=>{if(!cancelled)setNotice('The social editor could not load. Reopen the Social tab to try again.');});
  return()=>{cancelled=true;observer?.disconnect();current?.destroy();};
 },[client,status.connectionId,status.scopes?.join(' ')]);
 return <section className="marketing-social" aria-label="Social publishing studio">{notice&&<p className="marketing-social-notice" role="status">{notice}</p>}{busy&&<p role="status">Loading social accounts…</p>}<div ref={host} className="marketing-social-studio"/></section>;
}
