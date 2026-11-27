const http=require('node:http');
const {successPage}=require('./marketing-success.cjs');
const PREFIX='/api/ext/seo/marketing/';
function marketingOAuth(req,res,{upstreamPort,launchToken,origin}){
 const url=new URL(req.url,origin);if(![PREFIX+'open',PREFIX+'callback'].includes(url.pathname))return false;
 const send=(status,text)=>{if(res.writableEnded)return;res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"});res.end(text);};
 const open=url.pathname.endsWith('/open');const keys=[...url.searchParams.keys()];
 if(req.method!=='GET'||req.headers.authorization||req.headers['transfer-encoding']||Number(req.headers['content-length']||0)||keys.length!==(open?1:2)||new Set(keys).size!==keys.length||(open?!/^[a-f0-9]{64}$/.test(url.searchParams.get('ticket')||''):!/^[a-f0-9]{64}$/.test(url.searchParams.get('state')||'')||typeof url.searchParams.get('code')!=='string'||!url.searchParams.get('code')||url.searchParams.get('code').length>4096)||keys.some(k=>!(open?['ticket']:['state','code']).includes(k))) {send(400,'Invalid Marketing callback. Return to Girru and connect again.');return true;}
 const port=typeof upstreamPort==='function'?upstreamPort():upstreamPort;if(!Number.isInteger(port)||port<1||port>65535){send(503,'Girru is unavailable.');return true;}
 const cookies=(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>/^marketing_oauth=[a-f0-9]{64}$/.test(x));
 if(!open&&cookies.length!==1){send(400,'Connection browser changed. Start again from Marketing.');return true;}
 const upstream=http.request({hostname:'127.0.0.1',port,path:url.pathname+url.search,method:'GET',agent:false,headers:{Host:'127.0.0.1:'+port,Accept:'text/html',...(launchToken?{'X-Agent-Player-Launch':launchToken}:{}),...(!open?{Cookie:cookies[0]}:{})}},response=>{
  const cookie=response.headers['set-cookie'];
  const validCookie=Array.isArray(cookie)&&cookie.length===1&&/^marketing_oauth=(?:[a-f0-9]{64})?; Path=\/api\/ext\/seo\/marketing; HttpOnly; SameSite=Lax; Max-Age=(?:600|0)(?:; Secure)?$/.test(cookie[0]);
  if(open){let redirect;try{redirect=new URL(response.headers.location);}catch{}response.resume();if(response.statusCode!==302||!validCookie||redirect?.origin!=='https://seo-agent.net'||redirect.pathname!=='/api/oauth/authorize'){send(502,'Could not start Marketing connection.');return;}res.writeHead(302,{Location:redirect.href,'Set-Cookie':cookie[0],'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();return;}
  response.resume();if(response.statusCode!==200||!validCookie){send(400,'Marketing connection failed. Return to Girru and try again.');return;}res.setHeader('Set-Cookie',cookie[0]);send(200,successPage());
 });
 upstream.setTimeout(30000,()=>{upstream.destroy();send(504,'Marketing connection timed out.');});upstream.on('error',()=>send(502,'Marketing connection unavailable.'));req.on('aborted',()=>upstream.destroy());upstream.end();return true;
}
module.exports={marketingOAuth};
