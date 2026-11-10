/**
 * The last step of a desktop Google sign-in, done here so no Google client secret is ever shipped to,
 * or picked by hand on, a computer. The app sends only the one-time code, its PKCE verifier and its
 * loopback redirect; this returns only the ID token (no access or refresh token). PKCE binds the code
 * to the app that started the sign-in, so a stolen code alone is useless.
 */
const CODE=/^[A-Za-z0-9/_.~+-]{10,2048}$/,VERIFIER=/^[A-Za-z0-9_-]{43,128}$/,REDIRECT=/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/oauth\/device$/,TOKEN=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export type TokenFetch=(url:string,init:{method:'POST';headers:Record<string,string>;body:string;signal:AbortSignal})=>Promise<{ok:boolean;status:number;text():Promise<string>}>;
export function googleTokenInputOk(raw:any):raw is {code:string;codeVerifier:string;redirectUri:string}{
 return !!raw&&typeof raw==='object'&&!Array.isArray(raw)&&Object.keys(raw).sort().join(',')==='code,codeVerifier,redirectUri'&&typeof raw.code==='string'&&CODE.test(raw.code)&&typeof raw.codeVerifier==='string'&&VERIFIER.test(raw.codeVerifier)&&typeof raw.redirectUri==='string'&&REDIRECT.test(raw.redirectUri)&&Number(raw.redirectUri.split(':')[2].split('/')[0])<=65535;
}
export async function exchangeGoogleCode(raw:unknown,options:{clientId:string;clientSecret:string|null;fetcher?:TokenFetch;timeoutMs?:number}):Promise<{idToken:string}>{
 if(!options.clientSecret)throw Error('account_google_exchange_unavailable');
 if(!googleTokenInputOk(raw))throw Error('account_input_invalid');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),options.timeoutMs??10000);
 try{
  const fetcher=options.fetcher??(fetch as unknown as TokenFetch);
  const response=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},signal:controller.signal,
   body:new URLSearchParams({client_id:options.clientId,client_secret:options.clientSecret,code:raw.code,code_verifier:raw.codeVerifier,grant_type:'authorization_code',redirect_uri:raw.redirectUri}).toString()});
  const text=await response.text();if(text.length>65536)throw Error('account_google_exchange_refused');
  if(!response.ok)throw Error('account_google_exchange_refused');
  const body=JSON.parse(text);if(typeof body?.id_token!=='string'||body.id_token.length>20000||!TOKEN.test(body.id_token))throw Error('account_google_exchange_refused');
  return {idToken:body.id_token};
 }catch(error){throw Error(error instanceof Error&&/^account_[a-z_]+$/.test(error.message)?error.message:'account_google_exchange_refused');}
 finally{clearTimeout(timer);}
}
/** Reads the secret from the operator's private file: the bare secret, or Google's downloaded client JSON. */
export function googleClientSecretOf(text:string,clientId:string):string{
 const trimmed=text.trim();let secret=trimmed;
 if(trimmed.startsWith('{')){const value=JSON.parse(trimmed)?.installed;if(!value||value.client_id!==clientId)throw Error('account_configuration_invalid');secret=value.client_secret;}
 if(typeof secret!=='string'||!/^[A-Za-z0-9_-]{16,256}$/.test(secret))throw Error('account_configuration_invalid');
 return secret;
}
