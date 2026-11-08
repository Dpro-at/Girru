import {DproAccountClient,type DproAccountProof} from '../accounts/client.js';
/** Primary identity proof exists only after the trusted desktop broker verifies Google OIDC. */
import {validSetupEmail} from './setup-input.js';
import {randomBytes} from 'node:crypto';
import {privateDesktopCustodyChannel,type DesktopCustodyChannel} from '../devices/desktop-custody.js';
export interface GoogleAccountIdentity {issuer:'https://accounts.google.com';subject:string;email:string;emailVerified:true;verifiedAt:number;expiresAt:number;bindingNonce:string;dproProof?:DproAccountProof;cloudUnavailable?:true}
const proofs=new WeakMap<object,GoogleAccountIdentity>();
export interface GoogleAccountProof {readonly purpose:'google-account-proof'}
export function readGoogleAccountProof(proof:unknown):GoogleAccountIdentity{const value=proof&&typeof proof==='object'?proofs.get(proof):undefined;if(!value||value.expiresAt<=Date.now()||value.verifiedAt<Date.now()-300000)throw Error('google_identity_proof_expired');return {...value};}
export class GoogleAccountProvider {
 constructor(private channel:DesktopCustodyChannel|null=privateDesktopCustodyChannel(),private options:{localFixtureOnly?:boolean;temporaryAccountTestOnly?:boolean}={}){if((options.localFixtureOnly||options.temporaryAccountTestOnly)&&process.env.NODE_ENV!=='test')throw Error('google_fixture_provider_refused');}
 available(){return !!this.channel;}
 begin(kind:'signin'|'setup'|'link'='signin'){
  const nonce=randomBytes(32).toString('base64url'),client=this.channel&&!this.options.localFixtureOnly?new DproAccountClient(this.channel,{temporaryTestOnly:this.options.temporaryAccountTestOnly}):null;let local=false,cancelled=false,proof:GoogleAccountProof|undefined,authorize:(()=>void)|undefined,deny:(()=>void)|undefined,resolve!:(p:GoogleAccountProof)=>void,reject!:(e:unknown)=>void;
  const promise=new Promise<GoogleAccountProof>((yes,no)=>{resolve=yes;reject=no;});
  const mint=(identity:{issuer:string;subject:string;email?:string;emailVerified?:boolean;verifiedAt:number;expiresAt:number})=>{if(identity.issuer!=='https://accounts.google.com'||identity.emailVerified!==true||!identity.email||!validSetupEmail(identity.email))throw Error('google_verified_email_required');proof=Object.freeze({purpose:'google-account-proof' as const});proofs.set(proof,{issuer:identity.issuer,subject:identity.subject,email:identity.email,emailVerified:true,verifiedAt:identity.verifiedAt,expiresAt:identity.expiresAt,bindingNonce:nonce});resolve(proof);};
  const work=(async()=>{if(client){try{return await client.googleLogin({kind,confirmFirstDevice:kind==='setup',beforeExchange:async()=>{if(cancelled)throw Error('google_flow_cancelled');mint(client.lastVerifiedIdentity!);await new Promise<void>((yes,no)=>{authorize=yes;deny=()=>no(Error('google_flow_cancelled'));});if(cancelled)throw Error('google_flow_cancelled');}});}catch(error){if(cancelled)throw Error('google_flow_cancelled');if(proof){if(kind==='signin'){proofs.set(proof,{...proofs.get(proof)!,cloudUnavailable:true});return null;}throw error;}if(!(error instanceof Error)||error.message!=='device_account_service_not_configured'&&kind!=='signin')throw error;}}
   if(cancelled)throw Error('google_flow_cancelled');local=true;proof=await this.authenticate(nonce);resolve(proof);return null;
  })();void work.catch(error=>reject(error));
  return {promise,complete:async()=>{if(cancelled||!proof)throw Error('google_flow_cancelled');authorize?.();const result=await work;if(cancelled)throw Error('google_flow_cancelled');if(result)proofs.set(proof,{...proofs.get(proof)!,dproProof:result.proof});return proof;},cancel:()=>{cancelled=true;deny?.();const cancellation=local?this.channel?.request('auth-cancel',{nonce}):client?.cancelGoogle();client?.close();return cancellation;}};
 }

 async authenticate(nonce=randomBytes(32).toString('base64url')):Promise<GoogleAccountProof>{if(!this.channel)throw Error('google_desktop_required');const result=await this.channel.request('auth-login',{nonce});if(result?.issuer!=='https://accounts.google.com'||typeof result.subject!=='string'||!/^\d{1,255}$/.test(result.subject)||result.emailVerified!==true||typeof result.email!=='string'||result.email.length>320||!validSetupEmail(result.email.trim().toLowerCase())||!Number.isSafeInteger(result.verifiedAt)||Math.abs(result.verifiedAt-Date.now())>60000||!Number.isSafeInteger(result.expiresAt)||result.expiresAt<=Date.now())throw Error('google_identity_proof_invalid');const proof=Object.freeze({purpose:'google-account-proof' as const});proofs.set(proof,{issuer:result.issuer,subject:result.subject,email:result.email.trim().toLowerCase(),emailVerified:true,verifiedAt:result.verifiedAt,expiresAt:result.expiresAt,bindingNonce:nonce});return proof;}
}
