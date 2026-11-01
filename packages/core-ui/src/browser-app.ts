import {useCallback,useEffect,useState} from 'react';
import type {SessionClient} from './session';
import {BROWSER_APP_PATH} from './browser-app-contract.js';
export function useBrowserApp(client:SessionClient, owner:boolean) {
  const [available,setAvailable] = useState(false), [problem,setProblem] = useState('');
  useEffect(()=>{let active=true;if(owner)void client.request({method:'GET',path:BROWSER_APP_PATH} as never).then(r=>{if(active)setAvailable(r.status===200&&(r.body as {available?:boolean}).available===true);}).catch(()=>{});return()=>{active=false;};},[client,owner]);
  const open=useCallback(async()=>{setProblem('');try{const r=await client.request({method:'POST',path:BROWSER_APP_PATH,body:{action:'open'}} as never);if(r.status!==200)throw Error();}catch{setProblem('Browser could not open. Try again.');}},[client]);
  return {available,open,problem};
}
