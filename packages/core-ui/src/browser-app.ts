import {useCallback,useEffect,useState} from 'react';
import type {SessionClient} from './session';
import {BROWSER_APP_PATH} from './browser-app-contract.js';
export function useBrowserApp(client:SessionClient, owner:boolean) {
  const [available,setAvailable] = useState(false), [problem,setProblem] = useState('');
  useEffect(()=>{let active=true;const epoch=client.getSnapshot().epoch;
    const read=async()=>{if(!owner){setAvailable(false);return;}try{const r=await client.request({method:'GET',path:BROWSER_APP_PATH} as never);if(active&&client.getSnapshot().epoch===epoch)setAvailable(r.status===200&&(r.body as {available?:boolean}).available===true);}catch{if(active)setAvailable(false);}};
    void read();const timer=owner?setInterval(()=>void read(),5000):undefined;window.addEventListener('focus',read);window.addEventListener('girru:apps-changed',read);
    return()=>{active=false;clearInterval(timer);window.removeEventListener('focus',read);window.removeEventListener('girru:apps-changed',read);};
  },[client,owner]);
  const open=useCallback(async()=>{setProblem('');try{const r=await client.request({method:'POST',path:BROWSER_APP_PATH,body:{action:'open'}} as never);if(r.status!==200)throw Error();}catch{setProblem('Browser could not open. Try again.');}},[client]);
  return {available,open,problem};
}
