// STORE-UI-01: the Store's one read, Add and Remove, and the catalogue contract.
// Run: node --import tsx --test test/store.test.mjs  (throwaway DB, cwd and home; no network)
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'store-'));process.chdir(root);process.env.AGENT_PLAYER_DATA_DIR=root;process.env.DATABASE_PATH=path.join(root,'test.db');process.env.JWT_SECRET=randomBytes(64).toString('hex');process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');delete process.env.AGENT_PLAYER_DB;delete process.env.GIRRU_STORE_FEATURED;process.env.GIRRU_STORE_REPO='off'; // the local catalogue only: never the live Girru Store
process.env.HOME=root;process.env.USERPROFILE=root;process.env.GIRRU_GENVR_BUNDLED='0';delete process.env.GIRRU_APP_RUNTIMES_DIR;
const home=path.join(root,'home'),market=path.join(home,'.claude/plugins/marketplaces/acme/.claude-plugin');fs.mkdirSync(market,{recursive:true});
fs.writeFileSync(path.join(market,'marketplace.json'),JSON.stringify({name:'acme',plugins:[{name:'seo-audit',description:'Checks a site for search problems. More words.'}]}));
const quiet=console.log;console.log=()=>{};
const {getDatabase,closeDatabase}=await import('../src/db/database.ts');const db=getDatabase();await db.initialize();
for(const [id,role]of [['store-owner','owner'],['store-admin','admin']])db.prepare("INSERT INTO users(id,email,username,password_hash,role,status) VALUES(?,?,?,'fixture',?,'active')").run(id,id+'@example.invalid',id,role);
db.prepare("INSERT INTO extension_registry(id,name,description,author,version,type,category,download_url,permissions,verified) VALUES('weather','Weather','Forecasts for your agents. Uses a public service.','Acme','1.0.0','app','Productivity','https://example.invalid/w.zip','[\"Read the weather\"]',0)").run();
const {default:Fastify}=await import('fastify'),{registerAuthGate}=await import('../src/auth/auth-gate.ts'),{generateToken}=await import('../src/auth/jwt.ts'),{storeRoutes}=await import('../src/api/routes/store.ts'),{parseStoreIndex}=await import('../src/services/store-index.ts');
console.log=quiet;
const app=Fastify();registerAuthGate(app);await app.register(storeRoutes,{home});await app.ready();
const h=id=>({authorization:'Bearer '+generateToken(id,1)}),owner=h('store-owner');
const read=async()=>{const r=await app.inject({url:'/api/store',headers:owner});assert.equal(r.statusCode,200,r.body);return r.json();};
const post=(url,payload)=>app.inject({method:'POST',url,headers:owner,payload});
test.after(async()=>{await app.close();closeDatabase();fs.rmSync(root,{recursive:true,force:true});});

test('the store is owner-only and takes no query',async()=>{
 assert.equal((await app.inject({url:'/api/store'})).statusCode,401);
 assert.equal((await app.inject({url:'/api/store',headers:h('store-admin')})).statusCode,403);
 assert.equal((await app.inject({url:'/api/store?source=https://example.invalid',headers:owner})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url:'/api/store/install',headers:h('store-admin'),payload:{id:'registry:weather',hash:'0'.repeat(64)}})).statusCode,403);
});
test('one index joins the apps that come with Girru, the registry and the coding apps, with no invented numbers',async()=>{
 const s=await read();
 assert.equal(s.featured,'girru:genvr');
 assert.deepEqual(s.items.filter(x=>x.state==='included').map(x=>x.id),['girru:terminal','girru:code']);
 const w=s.items.find(x=>x.id==='registry:weather');assert.equal(w.state,'available');assert.equal(w.category,'productivity');assert.deepEqual(w.permissions,['Read the weather']);assert.match(w.hash,/^[a-f0-9]{64}$/);
 const a=s.items.find(x=>x.id==='claude-code:seo-audit@acme');assert.equal(a.state,'elsewhere');assert.equal(a.summary,'Checks a site for search problems.');
 assert.deepEqual(s.categories.map(c=>c.id),['marketing','sales','developer','worlds','trading','productivity'],'one fixed row; More only when used');
 assert.deepEqual(s.collections.map(c=>c.id),['made-by-girru','registry','claude-code']);
 const keys=new Set(s.items.flatMap(Object.keys));for(const banned of ['rating_avg','install_count','price','download_url','screenshot_urls','icon_url'])assert.ok(!keys.has(banned),banned);
});
test('Add is bound to what the owner saw; Remove gives it back; included and coding-app items are refused',async()=>{
 const w=(await read()).items.find(x=>x.id==='registry:weather');
 let r=await post('/api/store/install',{id:w.id,hash:'a'.repeat(64)});assert.equal(r.statusCode,409);assert.equal(r.json().code,'changed');
 r=await post('/api/store/install',{id:w.id,hash:w.hash,extra:1});assert.equal(r.statusCode,400);
 r=await post('/api/store/install',{id:w.id,hash:w.hash});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().state,'installed');
 assert.equal((await read()).items.find(x=>x.id===w.id).state,'installed');
 r=await post('/api/store/uninstall',{id:w.id});assert.equal(r.statusCode,200,r.body);assert.equal((await read()).items.find(x=>x.id===w.id).state,'available');
 for(const id of ['girru:terminal','claude-code:seo-audit@acme']){r=await post('/api/store/install',{id,hash:'a'.repeat(64)});assert.equal(r.statusCode,409);assert.equal(r.json().code,'not_installable');}
 r=await post('/api/store/install',{id:'registry:missing',hash:'a'.repeat(64)});assert.equal(r.statusCode,404);
});
test('the index contract refuses anything outside it',()=>{
 const ok={schema:1,featured:'x',collections:[{id:'c',title:'C',items:['x','gone']}],items:[{id:'x',kind:'skill',source:'girru',name:'X',category:'more',permissions:['p']}]};
 const p=parseStoreIndex(ok);assert.equal(p.featured,'x');assert.deepEqual(p.collections[0].items,['x']);assert.equal(p.items[0].icon,null);
 for(const bad of [{...ok,schema:2},{...ok,items:[{...ok.items[0],kind:'binary'}]},{...ok,items:[ok.items[0],ok.items[0]]},{...ok,items:[{...ok.items[0],category:'casino'}]},{...ok,items:[{...ok.items[0],icon:'<svg>'}]},{...ok,items:[{...ok.items[0],permissions:'all'}]}])assert.throws(()=>parseStoreIndex(bad));
 assert.equal(parseStoreIndex({...ok,featured:'nobody'}).featured,null);
});

test('GenVR runtime metadata is owner-only, local-only and does not reveal filesystem paths',async()=>{
 const good=await app.inject({url:'/api/apps/genvr',headers:owner});assert.equal(good.statusCode,200);assert.equal(good.json().state,'unavailable');assert.doesNotMatch(good.body,/packageDir|archiveSha256|entrySha256|installedAt/);
 assert.equal((await app.inject({url:'/api/apps/genvr',headers:h('store-admin')})).statusCode,403);
 assert.equal((await app.inject({url:'/api/apps/genvr?other=1',headers:owner})).statusCode,400);
 assert.equal((await app.inject({url:'/api/apps/genvr',headers:owner,remoteAddress:'203.0.113.10'})).statusCode,403);
});
