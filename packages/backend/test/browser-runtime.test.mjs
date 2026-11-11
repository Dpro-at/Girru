import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';import {randomBytes} from 'node:crypto';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'girru-browser-runtime-')),before=process.cwd();process.chdir(root);Object.assign(process.env,{HOME:root,AGENT_PLAYER_DATA_DIR:path.join(root,'data'),DATABASE_PATH:path.join(root,'data/db.sqlite'),JWT_SECRET:randomBytes(64).toString('hex'),ENCRYPTION_KEY:randomBytes(32).toString('hex'),NODE_ENV:'test',GIRRU_BROWSER_APP_DIR:path.join(root,'app')});delete process.env.EXTENSIONS_DISABLED;
const {getDatabase}=await import('../src/db/index.ts');const db=getDatabase();await db.initialize();const runtime=await import('../src/services/browser-runtime.ts');
test('missing and disabled browser never import engine; retirement closes a late startup and rejects cached calls',async()=>{
 assert.equal(await runtime.loadBrowserRuntime(),null);fs.mkdirSync(process.env.GIRRU_BROWSER_APP_DIR);const entry=path.join(process.env.GIRRU_BROWSER_APP_DIR,'index.js');
 fs.writeFileSync(path.join(process.env.GIRRU_BROWSER_APP_DIR,'package.json'),'{"type":"module"}');fs.writeFileSync(path.join(process.env.GIRRU_BROWSER_APP_DIR,'app-host.npm'),JSON.stringify({schema:1,host:'browser',protocolVersion:1}));
 fs.writeFileSync(entry,`export const state={imports:1,cleanups:0};let release;export function finish(){release();}export async function loadBrowser(){return {listSessions(){return [];},async createSession(){await new Promise(resolve=>release=resolve);return {id:'late'};},async cleanup(){state.cleanups++;}};}`);
 db.prepare("INSERT INTO extension_configs(extension_id,enabled) VALUES('browser',0)").run();assert.equal(await runtime.loadBrowserRuntime(),null);
 db.prepare("UPDATE extension_configs SET enabled=1 WHERE extension_id='browser'").run();const engine=await runtime.loadBrowserRuntime();assert.ok(engine);const module=await import(pathToFileURL(entry).href);assert.equal(module.state.imports,1);assert.deepEqual(engine.listSessions(),[]);
 const late=engine.createSession();await runtime.stopBrowserRuntime();module.finish();await assert.rejects(late,/Store|restart/);assert.equal(module.state.cleanups,2);assert.throws(()=>engine.listSessions());assert.equal(await runtime.loadBrowserRuntime(),null);
});
test('URL interception checks activation again after asynchronous validation',async()=>{
 const {guardPage}=await import('../src/browser/url-guard.ts');let listener,active=true,continued=0,aborted=0;const page={async setRequestInterception(){},on(name,fn){if(name==='request')listener=fn;}};
 await guardPage(page,undefined,()=>active);const pending=listener({url:()=> 'https://1.1.1.1/',isInterceptResolutionHandled:()=>false,async continue(){continued++;},async abort(){aborted++;}});active=false;await pending;assert.equal(continued,0);assert.equal(aborted,1);
});
test.after(async()=>{await runtime.stopBrowserRuntime();db.close();process.chdir(before);fs.rmSync(root,{recursive:true,force:true});});
