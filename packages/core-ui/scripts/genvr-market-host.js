// GV1c v2: Girru's Market page is the Studio's own Items catalog (SDK mountMarket), in its own frame so
// the Studio's styles stay inside it. The catalog comes through the parent page (the same market
// route the Studio reads); "Add to a place…" asks the parent, which picks the place and opens it.
const channel=location.hash.slice(1),pending=new Map();let sequence=0,market=null;
const send=value=>parent.postMessage({type:'dpro-genvr-market',channel,...value},location.origin);
function request(operation){const id=String(++sequence);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('The market did not answer.'));},30000);pending.set(id,{resolve,reject,timer});send({id,operation});});}
window.addEventListener('message',async event=>{
 if(event.source!==parent||event.origin!==location.origin||event.data?.type!=='dpro-genvr-market'||event.data.channel!==channel)return;
 const data=event.data;
 if(data.response){const work=pending.get(data.id);if(!work)return;pending.delete(data.id);clearTimeout(work.timer);data.ok?work.resolve(data.value):work.reject(Error('The market could not be reached.'));return;}
 if(data.operation==='start'&&!market){
  try{
   const sdk=await import('/genvr/dist/studio.js');if(typeof sdk.mountMarket!=='function')throw Error();
   market=sdk.mountMarket(document.getElementById('market'),{catalog:{list:()=>request('catalog-list')},onAdd:itemId=>{if(typeof itemId==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(itemId))send({operation:'add',itemId});}});
   send({operation:'mounted'});
  }catch{send({operation:'unavailable'});}
 }
});
send({operation:'ready'});
