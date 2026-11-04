// MACAPP-01: updates of the installed app. Looks once a day, never updates by itself;
// "Back up and update" checks the download's checksum, backs up first, checks the new
// app, replaces the old one (kept until the next start) and starts again. No network:
// GitHub, the download, the backup and unpacking are fakes; the "app" is a test folder.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {createHash}=require('node:crypto');
const {createUpdater,readRelease,newer,sumFor,platformId,currentAppPath}=require('../src/app-update.cjs');

const P='mac-arm64';
const release=(v,extra={})=>({tag_name:`v${v}`,draft:false,prerelease:false,published_at:'2026-10-31T10:00:00Z',html_url:`https://github.com/Dpro-at/Girru/releases/tag/v${v}`,body:'## New\n- Tasks that repeat\n- The task page',
 assets:[{name:`Girru-${v}-${P}.zip`,browser_download_url:`https://github.com/Dpro-at/Girru/releases/download/v${v}/Girru-${v}-${P}.zip`},{name:`SHA256SUMS-${P}.txt`,browser_download_url:`https://github.com/Dpro-at/Girru/releases/download/v${v}/SHA256SUMS-${P}.txt`}],...extra});

test('versions, release reading and checksums',()=>{
 assert.equal(newer('1.4.0','1.3.2'),true);assert.equal(newer('1.3.10','1.3.9'),true);assert.equal(newer('1.3.2','1.3.2'),false);assert.equal(newer('2.0','1.0.0'),false);
 const r=readRelease(release('1.4.0'),'1.3.2',P);
 assert.equal(r.available,true);assert.equal(r.zipName,'Girru-1.4.0-mac-arm64.zip');assert.match(r.zip,/^https:\/\/github\.com\/Dpro-at\/Girru\/releases\/download\//);
 assert.equal(readRelease(release('1.4.0',{draft:true}),'1.3.2',P).available,false,'drafts are not offered');
 assert.equal(readRelease(release('1.4.0',{prerelease:true}),'1.3.2',P).available,false);
 const elsewhere=readRelease(release('1.4.0',{assets:[{name:`Girru-1.4.0-${P}.zip`,browser_download_url:'https://evil.example/Girru.zip'}]}),'1.3.2',P);
 assert.equal(elsewhere.zip,null,'downloads only from the Girru releases');
 assert.equal(sumFor(`${'a'.repeat(64)}  Girru-1.4.0-mac-arm64.dmg\n${'b'.repeat(64)}  Girru-1.4.0-mac-arm64.zip\n`,'Girru-1.4.0-mac-arm64.zip'),'b'.repeat(64));
 assert.equal(platformId('darwin','arm64'),'mac-arm64');assert.equal(platformId('darwin','x64'),'mac-x64');
 assert.equal(currentAppPath('/Applications/Girru.app/Contents/MacOS/Girru'),'/Applications/Girru.app');assert.equal(currentAppPath('/usr/bin/node'),null);
});

function setup({sumOk=true,backup={ok:true,id:'x'},appId='app.dpro.desktop',appVersion='1.4.0',keepPrevious=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ap-app-update-'));
 const apps=path.join(dir,'Applications');fs.mkdirSync(path.join(apps,'Girru.app','Contents','MacOS'),{recursive:true});fs.writeFileSync(path.join(apps,'Girru.app','old.txt'),'1.3.2');
 const zipBytes=Buffer.from('zip of 1.4.0');const sum=createHash('sha256').update(sumOk?zipBytes:Buffer.from('other')).digest('hex');
 const calls=[];let relaunched=0;let t=Date.parse('2026-10-31T12:00:00Z');
 const u=createUpdater({currentVersion:'1.3.2',settingsDir:dir,platform:'darwin',arch:'arm64',execPath:path.join(apps,'Girru.app','Contents','MacOS','Girru'),now:()=>t,
  fetchRelease:async()=>{calls.push('github');return release('1.4.0');},
  download:async(url,opts={})=>{calls.push(url.endsWith('.txt')?'sums':'zip');if(!opts.file)return `${sum}  Girru-1.4.0-${P}.zip\n`;fs.writeFileSync(opts.file,zipBytes);return createHash('sha256').update(zipBytes).digest('hex');},
  backUp:async()=>{calls.push('backup');return backup;},
  unpack:async(_zip,to)=>{calls.push('unpack');fs.mkdirSync(path.join(to,'Girru.app'));fs.writeFileSync(path.join(to,'Girru.app','new.txt'),'1.4.0');},
  readApp:async()=>({id:appId,version:appVersion}),keepPrevious,
  relaunch:()=>{relaunched++;}});
 return {u,dir,apps,calls,relaunched:()=>relaunched,tick:ms=>{t+=ms;}};
}

test('looks once a day and offers the new version; never installs by itself',async()=>{
 const s=setup();
 assert.equal(s.u.view().update,null);
 let v=await s.u.checkIfDue();assert.equal(v.update.version,'1.4.0');assert.equal(v.update.canInstall,true);
 await s.u.checkIfDue();assert.equal(s.calls.filter(c=>c==='github').length,1,'not twice in a day');
 s.tick(86_400_001);await s.u.checkIfDue();assert.equal(s.calls.filter(c=>c==='github').length,2);
 assert.ok(!s.calls.includes('zip')&&!s.calls.includes('backup'),'nothing downloaded or changed by a check');
 assert.ok(fs.existsSync(path.join(s.apps,'Girru.app','old.txt')));
});

test('Back up and update: checksum, backup, check the app, replace, start again',async()=>{
 const s=setup();await s.u.check();
 const v=await s.u.install();
 assert.equal(v.error,null);
 assert.deepEqual(s.calls.slice(1),['github','sums','zip','backup','unpack'],'asks GitHub again, backs up before anything changes');
 assert.doesNotMatch(fs.readFileSync(path.join(s.dir,'app-update.json'),'utf8'),/https?:/,'no address is saved');
 assert.ok(fs.existsSync(path.join(s.apps,'Girru.app','new.txt')),'the new app is in place');
 const old=fs.readdirSync(s.apps).find(n=>n.startsWith('.Girru.app.old-'));assert.ok(old,'the old app is kept beside it');
 assert.equal(s.relaunched(),1);
 s.u.cleanOld();assert.ok(!fs.readdirSync(s.apps).some(n=>n.startsWith('.Girru.app.old-')),'removed on the next start');
});

for(const [name,opts,re] of [['a download that does not match its checksum',{sumOk:false},/checksum/],['a failed backup',{backup:{ok:false,error:'disk full'}},/backup before updating failed \(disk full\)/],['an app that is not Girru',{appId:'com.other.app'},/not this app/],['an app in another version',{appVersion:'1.3.9'},/not this app/]]){
 test(`nothing changes after ${name}`,async()=>{
  const s=setup(opts);await s.u.check();
  const v=await s.u.install();
  assert.match(v.error,re);assert.match(v.error,/Girru is unchanged/);
  assert.ok(fs.existsSync(path.join(s.apps,'Girru.app','old.txt')));assert.ok(!fs.existsSync(path.join(s.apps,'Girru.app','new.txt')));
  assert.equal(s.relaunched(),0);
  if(name!=='a failed backup'&&name!=='a download that does not match its checksum')assert.ok(s.calls.includes('backup'));
  if(name==='a download that does not match its checksum')assert.ok(!s.calls.includes('backup'),'no backup for a bad download');
 });
}

test('the app page asks only from the main window; installing is confirmed by the app',()=>{
 const main=fs.readFileSync(path.join(__dirname,'../src/main.cjs'),'utf8');
 for(const ch of ['dpro:app-update-state','dpro:app-update-check','dpro:app-update-install','dpro:app-update-page'])assert.match(main,new RegExp(`ipcMain\\.handle\\('${ch}', (async )?event => \\{?\\s*(if \\()?!?fromAppPage\\(event\\)`),ch);
 assert.match(main,/showMessageBox\(mainWindow, \{ type: 'question', message: `Back up and update to Girru/);
 assert.match(main,/if \(!app\.isPackaged \|\| updater\) return;/,'only the installed app looks for updates');
 const preload=fs.readFileSync(path.join(__dirname,'../src/preload.cjs'),'utf8');
 assert.match(preload,/appUpdate: \{/);assert.doesNotMatch(preload,/appUpdate:[\s\S]{0,600}(url|path|file)\s*=>/,'the page never passes a URL or a path');
});

// STORE-MAP-01 P3 (FD4a): with the switch on, the replaced version and its before-update backup stay
// until the new version has started once; "Restore and open" brings both back.
test('P3: the replaced version stays until the new one started; Restore and open brings it back',async()=>{
 const backup={ok:true,id:'20261103-091400-before-update',folder:'/fictional/backups/workspace'};
 const s=setup({keepPrevious:true,backup});await s.u.check();await s.u.install();
 const data=path.join(s.dir,'data');fs.mkdirSync(data);
 s.u.cleanOld();
 const kept=fs.readdirSync(s.apps).find(n=>n.startsWith('.Girru.app.old-'));assert.ok(kept,'kept across the next start');
 assert.deepEqual(s.u.previous(),{version:'1.3.2',backupId:backup.id,at:'2026-10-31T12:00:00.000Z'});
 // A new updater (the next start) still knows it; the saved file holds no address.
 const again=createUpdater({currentVersion:'1.4.0',settingsDir:s.dir,platform:'darwin',arch:'arm64',execPath:path.join(s.apps,'Girru.app','Contents','MacOS','Girru'),keepPrevious:true,relaunch:()=>{again.relaunched=(again.relaunched||0)+1;},backUp:async()=>({ok:true})});
 assert.equal(again.previous().version,'1.3.2');
 assert.doesNotMatch(fs.readFileSync(path.join(s.dir,'app-update.json'),'utf8'),/https?:/);
 const out=again.restorePrevious(data);
 assert.deepEqual(out,{version:'1.3.2'});
 assert.ok(fs.existsSync(path.join(s.apps,'Girru.app','old.txt')),'the version you had is back in place');
 assert.ok(fs.readdirSync(s.apps).some(n=>n.startsWith('.Girru.app.failed-')),'the new version is moved aside, not deleted');
 const marker=JSON.parse(fs.readFileSync(path.join(data,'restore-pending.json'),'utf8'));
 assert.deepEqual({id:marker.id,folder:marker.folder},{id:backup.id,folder:backup.folder},'the backend restores this backup before any store opens');
 assert.equal(again.relaunched,1);
 assert.equal(again.previous(),null,'only once');
 assert.throws(()=>again.restorePrevious(data),/no earlier version/);
});

test('P3: a version that started fine lets the replaced one go; without the switch nothing is kept',async()=>{
 const s=setup({keepPrevious:true,backup:{ok:true,id:'20261103-091400-before-update',folder:'/fictional/b'}});await s.u.check();await s.u.install();
 s.u.startedFine();
 assert.ok(!fs.readdirSync(s.apps).some(n=>n.startsWith('.Girru.app.old-')));
 assert.equal(s.u.previous(),null);
 const off=setup({backup:{ok:true,id:'20261103-091400-before-update',folder:'/fictional/b'}});await off.u.check();await off.u.install();
 assert.equal(off.u.previous(),null,'switch off: no restore offered');
 off.u.cleanOld();assert.ok(!fs.readdirSync(off.apps).some(n=>n.startsWith('.Girru.app.old-')),'removed on the next start, as before');
});
