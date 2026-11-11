/**
 * People (CP17): each account gets one public ID that never changes ("GR-7K2D-9QF4") and an
 * optional nickname. Another person adds you by typing either one exactly (nobody can list
 * people); you see a code that changes every 90 seconds and press Yes only when it matches
 * the code the other person reads to you. A link only lets the two accounts exchange tasks:
 * it shares their computers' public keys and nothing else.
 */
import {createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {AccountStore} from './store.js';
import {exact,opaque,RETENTION,type AccountRow,type DeviceRow} from './contracts.js';

export const PEOPLE_OPERATIONS=['people.me','people.nickname','people.find','people.request','people.requests','people.accept','people.decline','people.list','people.remove'] as const;
export type PeopleOperation=typeof PEOPLE_OPERATIONS[number];

const ID_LETTERS='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const PUBLIC_ID=/^GR-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
const NICKNAME=/^[a-z0-9](?:[a-z0-9.-]{1,22})[a-z0-9]$/;
export const CODE_WINDOW_MS=90_000;
export const REQUEST_LIFETIME_MS=15*60_000;
const FIND_LIMIT=30,FIND_WINDOW_MS=10*60_000;
const MAX_OUTGOING_PENDING=20,MAX_LINKS_PER_ACCOUNT=500,MAX_LINK_ROWS=200_000;

interface ProfileRow {account_id:string;public_id:string;nickname:string|null;nickname_at:number;created_at:number}
interface LinkRow {id:string;from_account:string;to_account:string;status:'pending'|'linked'|'blocked';code_seed:string;created_at:number;expires_at:number;linked_at:number|null}
interface Presence {at:number}

export const isPeopleOperation=(op:string):op is PeopleOperation=>(PEOPLE_OPERATIONS as readonly string[]).includes(op);

/** A nickname is 3–24 lowercase letters, numbers, dot or dash, and never shaped like an ID. */
export function normalNickname(value:unknown):string{
  if(typeof value!=='string')throw Error('account_people_nickname_invalid');
  const name=value.trim().toLowerCase();
  if(!NICKNAME.test(name)||name.startsWith('gr-')||/[.-]{2}/.test(name))throw Error('account_people_nickname_invalid');
  return name;
}

/** The 8-digit code both people see for one request during one 90-second window. */
export function peopleCode(seed:string,window:number){
  const mac=createHmac('sha256',Buffer.from(seed,'base64url')).update('girru-people-code:'+window).digest();
  return String(mac.readUInt32BE(0)%100_000_000).padStart(8,'0');
}

function newPublicId(){
  const bytes=randomBytes(8);let text='';
  for(const b of bytes)text+=ID_LETTERS[b%32];
  return 'GR-'+text.slice(0,4)+'-'+text.slice(4);
}

export class People {
  private finds=new Map<string,{count:number;until:number}>();
  constructor(private store:AccountStore,private now:()=>number,private presence:Map<string,Presence>){}

  private profile(accountId:string){return this.store.one<ProfileRow>('SELECT * FROM people_profiles WHERE account_id=?',accountId);}
  private ensureProfile(accountId:string):ProfileRow{
    const old=this.profile(accountId);if(old)return old;
    for(let i=0;i<8;i++){
      const id=newPublicId();
      if(this.store.one('SELECT 1 FROM people_profiles WHERE public_id=?',id))continue;
      this.store.run('INSERT INTO people_profiles(account_id,public_id,nickname,nickname_at,created_at) VALUES(?,?,NULL,0,?)',accountId,id,this.now());
      return this.profile(accountId)!;
    }
    throw Error('account_people_capacity');
  }
  private person(p:ProfileRow){return {publicId:p.public_id,nickname:p.nickname};}
  private between(a:string,b:string){return this.store.all<LinkRow>('SELECT * FROM people_links WHERE (from_account=? AND to_account=?) OR (from_account=? AND to_account=?)',a,b,b,a);}
  private link(id:unknown,accountId:string){
    if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw Error('account_input_invalid');
    const row=this.store.one<LinkRow>('SELECT * FROM people_links WHERE id=?',id);
    if(!row||row.from_account!==accountId&&row.to_account!==accountId)throw Error('account_people_unavailable');
    return row;
  }
  private codeOf(row:LinkRow){
    const now=this.now(),window=Math.floor(now/CODE_WINDOW_MS);
    return {code:peopleCode(row.code_seed,window),codeExpiresAt:(window+1)*CODE_WINDOW_MS};
  }
  private computers(accountId:string){
    const now=this.now();
    return this.store.all<DeviceRow>("SELECT * FROM devices WHERE account_id=? AND status='approved' ORDER BY registered_at,id LIMIT 64",accountId).map(d=>{
      const seen=this.presence.get(d.id);
      return {deviceId:d.id,publicKey:d.public_key,label:d.label,osFamily:d.os_family,presence:seen&&seen.at+RETENTION.presenceMs>now?'online':'unknown'};
    });
  }
  private purge(){this.store.run("DELETE FROM people_links WHERE status='pending' AND expires_at<=?",this.now());}
  private found(query:unknown,self:string){
    if(typeof query!=='string'||query.length>40)throw Error('account_input_invalid');
    const text=query.trim(),upper=text.toUpperCase();
    let row:ProfileRow|undefined;
    if(PUBLIC_ID.test(upper))row=this.store.one<ProfileRow>('SELECT * FROM people_profiles WHERE public_id=?',upper);
    else{let name:string;try{name=normalNickname(text);}catch{return undefined;}row=this.store.one<ProfileRow>('SELECT * FROM people_profiles WHERE nickname=?',name);}
    if(!row||row.account_id===self)return undefined;
    const account=this.store.one<AccountRow>('SELECT * FROM accounts WHERE id=?',row.account_id);
    return account&&account.status==='active'?row:undefined;
  }
  private limitFind(accountId:string){
    const now=this.now();
    for(const [k,v]of this.finds)if(v.until<=now)this.finds.delete(k);
    const r=this.finds.get(accountId)??{count:0,until:now+FIND_WINDOW_MS};
    if(++r.count>FIND_LIMIT)throw Error('account_people_wait');
    if(this.finds.size>=10000&&!this.finds.has(accountId))throw Error('account_people_wait');
    this.finds.set(accountId,r);
  }

  /** Runs inside the service's request transaction, after the caller's device is approved. */
  run(context:{account:AccountRow;device:DeviceRow},operation:PeopleOperation,payload:unknown){
    const me=context.account.id;this.purge();
    switch(operation){
      case 'people.me':{exact(payload,[]);return this.person(this.ensureProfile(me));}
      case 'people.nickname':{
        exact(payload,['nickname']);const mine=this.ensureProfile(me);
        const name=payload.nickname===null?null:normalNickname(payload.nickname);
        if(name===mine.nickname)return this.person(mine);
        if(name&&this.store.one('SELECT 1 FROM people_profiles WHERE nickname=? AND account_id<>?',name,me))throw Error('account_people_nickname_taken');
        if(mine.nickname_at>this.now()-60_000)throw Error('account_people_wait');
        this.store.run('UPDATE people_profiles SET nickname=?,nickname_at=? WHERE account_id=?',name,this.now(),me);
        return this.person(this.profile(me)!);
      }
      case 'people.find':{
        exact(payload,['query']);this.limitFind(me);
        const row=this.found(payload.query,me);
        if(!row)return {found:false};
        const rows=this.between(me,row.account_id);
        if(rows.some(r=>r.status==='blocked'))return {found:false};
        return {found:true,person:this.person(row),computers:this.computers(row.account_id).length,linked:rows.some(r=>r.status==='linked'),waiting:rows.some(r=>r.status==='pending')};
      }
      case 'people.request':{
        exact(payload,['publicId']);
        const id=typeof payload.publicId==='string'?payload.publicId.toUpperCase():'';
        if(!PUBLIC_ID.test(id))throw Error('account_input_invalid');
        this.ensureProfile(me);
        const target=this.found(id,me);if(!target)throw Error('account_people_unavailable');
        const rows=this.between(me,target.account_id);
        if(rows.some(r=>r.status==='blocked'))throw Error('account_people_unavailable');
        if(rows.some(r=>r.status==='linked'))throw Error('account_people_linked');
        if(rows.some(r=>r.status==='pending'&&r.from_account===target.account_id))throw Error('account_people_request_waiting');
        const mineOld=rows.find(r=>r.status==='pending'&&r.from_account===me);
        if(mineOld){
          this.store.run('UPDATE people_links SET expires_at=? WHERE id=?',this.now()+REQUEST_LIFETIME_MS,mineOld.id);
          const row=this.store.one<LinkRow>('SELECT * FROM people_links WHERE id=?',mineOld.id)!;
          return {linkId:row.id,person:this.person(target),expiresAt:row.expires_at,...this.codeOf(row)};
        }
        const count=(sql:string,...p:unknown[])=>Number(this.store.one<any>(sql,...p)?.n);
        if(count("SELECT COUNT(*) n FROM people_links WHERE from_account=? AND status='pending'",me)>=MAX_OUTGOING_PENDING
          ||count('SELECT COUNT(*) n FROM people_links WHERE from_account=? OR to_account=?',me,me)>=MAX_LINKS_PER_ACCOUNT
          ||count('SELECT COUNT(*) n FROM people_links WHERE from_account=? OR to_account=?',target.account_id,target.account_id)>=MAX_LINKS_PER_ACCOUNT
          ||count('SELECT COUNT(*) n FROM people_links')>=MAX_LINK_ROWS)throw Error('account_people_capacity');
        const linkId=randomUUID();
        this.store.run("INSERT INTO people_links(id,from_account,to_account,status,code_seed,created_at,expires_at,linked_at) VALUES(?,?,?,'pending',?,?,?,NULL)",linkId,me,target.account_id,opaque(),this.now(),this.now()+REQUEST_LIFETIME_MS);
        const row=this.store.one<LinkRow>('SELECT * FROM people_links WHERE id=?',linkId)!;
        return {linkId,person:this.person(target),expiresAt:row.expires_at,...this.codeOf(row)};
      }
      case 'people.requests':{
        exact(payload,[]);
        const view=(r:LinkRow,other:string)=>{const p=this.profile(other);return p?{linkId:r.id,person:this.person(p),expiresAt:r.expires_at,...this.codeOf(r)}:null;};
        const incoming=this.store.all<LinkRow>("SELECT * FROM people_links WHERE to_account=? AND status='pending' ORDER BY created_at DESC LIMIT 20",me).map(r=>view(r,r.from_account)).filter(Boolean);
        const outgoing=this.store.all<LinkRow>("SELECT * FROM people_links WHERE from_account=? AND status='pending' ORDER BY created_at DESC LIMIT 20",me).map(r=>view(r,r.to_account)).filter(Boolean);
        return {incoming,outgoing};
      }
      case 'people.accept':{
        exact(payload,['linkId','code','confirmed']);
        if(payload.confirmed!==true||typeof payload.code!=='string'||!/^\d{8}$/.test(payload.code))throw Error('account_people_code_required');
        const row=this.link(payload.linkId,me);
        if(row.to_account!==me||row.status!=='pending'||row.expires_at<=this.now())throw Error('account_people_unavailable');
        const window=Math.floor(this.now()/CODE_WINDOW_MS),given=Buffer.from(payload.code);
        const ok=[window,window-1].some(w=>timingSafeEqual(Buffer.from(peopleCode(row.code_seed,w)),given));
        if(!ok)throw Error('account_people_code_changed');
        this.store.run("UPDATE people_links SET status='linked',code_seed='',linked_at=?,expires_at=0 WHERE id=?",this.now(),row.id);
        const other=this.profile(row.from_account)!;
        return {linked:true,linkId:row.id,person:this.person(other)};
      }
      case 'people.decline':{
        exact(payload,['linkId','block']);
        if(typeof payload.block!=='boolean')throw Error('account_input_invalid');
        const row=this.link(payload.linkId,me);
        if(row.status!=='pending')throw Error('account_people_unavailable');
        if(payload.block&&row.to_account===me)this.store.run("UPDATE people_links SET status='blocked',code_seed='',expires_at=0 WHERE id=?",row.id);
        else this.store.run('DELETE FROM people_links WHERE id=?',row.id);
        return {declined:true,blocked:payload.block&&row.to_account===me};
      }
      case 'people.list':{
        exact(payload,[]);
        const people=this.store.all<LinkRow>("SELECT * FROM people_links WHERE (from_account=? OR to_account=?) AND status='linked' ORDER BY linked_at,id LIMIT 500",me,me).flatMap(r=>{
          const other=r.from_account===me?r.to_account:r.from_account,p=this.profile(other);
          return p?[{linkId:r.id,person:this.person(p),linkedAt:r.linked_at,computers:this.computers(other)}]:[];
        });
        const blocked=this.store.all<LinkRow>("SELECT * FROM people_links WHERE to_account=? AND status='blocked' ORDER BY created_at DESC LIMIT 100",me).flatMap(r=>{const p=this.profile(r.from_account);return p?[{linkId:r.id,person:this.person(p)}]:[];});
        return {people,blocked};
      }
      case 'people.remove':{
        exact(payload,['linkId','confirmed']);
        if(payload.confirmed!==true)throw Error('account_input_invalid');
        const row=this.link(payload.linkId,me);
        if(row.status==='blocked'&&row.to_account!==me)throw Error('account_people_unavailable');
        this.store.run('DELETE FROM people_links WHERE id=?',row.id);
        return {removed:true};
      }
    }
  }

  /** Called when an account is deleted: its ID, nickname and every link go with it. */
  forget(accountId:string){
    this.store.run('DELETE FROM people_links WHERE from_account=? OR to_account=?',accountId,accountId);
    this.store.run('DELETE FROM people_profiles WHERE account_id=?',accountId);
    this.finds.delete(accountId);
  }
}
