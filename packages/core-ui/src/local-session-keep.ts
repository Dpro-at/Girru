import {SHELL_SESSION,isShellOrigin,type TokenKeep} from './session';
/** The bridge owns an HttpOnly cookie. JavaScript stores no reusable credential.
 * Inside the phone app the computer runs requests as the paired owner, so the
 * page starts signed in with a placeholder (session.ts › SHELL_SESSION). */
export function localSessionKeep(hostname:string,origin?:string):TokenKeep|null {
 if(origin!==undefined&&isShellOrigin(origin))return {load:()=>SHELL_SESSION,save:()=>{}};
 if(hostname!=='127.0.0.1')return null;
 return {load:()=> 'dpro-remembered-session',save:()=>{}};
}
