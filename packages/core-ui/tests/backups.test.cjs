require('./load.cjs');const {test}=require('node:test'),assert=require('node:assert/strict'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {allowedBackups,backupsResponse,backupsRoute}=require('../src/backups-contract.js');const {allowed}=require('../scripts/application-server.cjs');const {allowedRequest}=require('../src/session.ts');
const {AppSettings}=require('../src/AppSettings.tsx');const {backupWhen,backupKind,nextWhen,SettingsBackups}=require('../src/SettingsBackups.tsx');
const id='20261029-030000-daily';
test('backups requests: only the page’s own, in both gates',()=>{
 for(const [m,p,b] of [['GET','/api/backups'],['POST','/api/backups',{}],['POST','/api/backups',{kind:'before-update'}],['PUT','/api/backups/folder',{folder:'/Users/x/Girru Backups'}],['PUT','/api/backups/retention',{keepDays:7}],['PUT','/api/backups/retention',{keepDays:3}],['PUT','/api/backups/retention',{keepDays:365}],['POST',`/api/backups/${id}/restore`],['POST',`/api/backups/${id}/show`],['DELETE',`/api/backups/${id}`]]){
  assert.ok(allowedBackups(m,p,b),`${m} ${p}`);assert.ok(allowed(m,p,b),`bridge ${m} ${p}`);assert.ok(allowedRequest(m,p,b),`client ${m} ${p}`);
 }
 for(const [m,p,b] of [['POST','/api/backups',{kind:'daily'}],['POST','/api/backups',{kind:'manual',extra:1}],['GET','/api/backups',{}],['PUT','/api/backups/folder',{folder:''}],['PUT','/api/backups/folder',{folder:'/x',move:true}],['PUT','/api/backups/retention',{keepDays:2}],['PUT','/api/backups/retention',{keepDays:7,extra:1}],['PUT','/api/backups/retention',{keepDays:1.5}],['PUT','/api/backups/retention',{days:7}],['POST','/api/backups/../../etc/restore'],['POST',`/api/backups/${id}/restore`,{force:true}],['GET',`/api/backups/${id}`],['DELETE','/api/backups/all'],['POST',`/api/backups/${id}/copy`]]){
  assert.equal(allowed(m,p,b),false,`${m} ${p}`);assert.equal(allowedRequest(m,p,b),false,`client ${m} ${p}`);
 }
 assert.ok(backupsRoute('/api/backups/x'));assert.equal(backupsRoute('/api/backupsx'),false);
});
test('backups answers: only what the page shows, the same when projected twice',()=>{
 const b={id,kind:'daily',at:'2026-10-29T01:00:00.000Z',checked:true,size:64e6,parts:{data:true,audit:true,keys:true},keepUntil:'2026-11-12T01:00:00.000Z',dir:'/secret/path',entries:[{path:'secrets.env'}]};
 const body={available:true,folder:'/Users/x/Girru Backups',cloud:false,defaultFolder:'/Users/x/Girru Backups',runsAt:'03:00',keeps:{days:14,sundays:4,beforeUpdateDays:30},running:false,last:b,next:'2026-10-30T01:00:00.000Z',lastError:null,lastRestore:null,backups:[b,{id:'../bad'}],token:'must-never-return'};
 const once=backupsResponse('/api/backups',200,body),twice=backupsResponse('/api/backups',200,once);
 assert.deepEqual(once,twice);assert.equal(once.backups.length,1);assert.ok(!JSON.stringify(once).includes('must-never-return'));assert.ok(!JSON.stringify(once).includes('/secret/path'));assert.ok(!JSON.stringify(once).includes('secrets.env'));
 assert.deepEqual(backupsResponse('/api/backups',200,{backup:b}),{backup:backupsResponse('/api/backups',200,{backup:b}).backup});
 assert.deepEqual(backupsResponse(`/api/backups/${id}/restore`,200,{restarting:true,undoId:'20261029-184000-before-restore'}),{restarting:true,undoId:'20261029-184000-before-restore'});
 assert.deepEqual(backupsResponse('/api/backups',400,{error:'Choose a folder',code:'invalid_folder',stack:'x'}),{code:'invalid_folder',error:'Choose a folder'});
 assert.deepEqual(backupsResponse('/api/backups',200,{available:false,reason:'On PostgreSQL, use pg_dump'}),{available:false,reason:'On PostgreSQL, use pg_dump'});
 // Retention: only the chosen number of days passes back; the keeps fields project with safe defaults.
 assert.deepEqual(backupsResponse('/api/backups/retention',200,{keepDays:7,secret:'no'}),{keepDays:7});
 assert.deepEqual(backupsResponse('/api/backups/retention',200,{keepDays:'x'}),{keepDays:0});
 const keepsBody={available:true,folder:'/Users/x/Girru Backups',cloud:false,defaultFolder:'/Users/x/Girru Backups',runsAt:'03:00',keeps:{days:7,sundays:4,beforeUpdateDays:30,min:3,max:3650,presets:[3,7,14]},running:false,last:null,next:'2026-10-30T01:00:00.000Z',lastError:null,lastRestore:null,backups:[]};
 const keeps=backupsResponse('/api/backups',200,keepsBody).keeps;
 assert.deepEqual(keeps,{days:7,sundays:4,beforeUpdateDays:30,min:3,max:3650,presets:[3,7,14]});
});
test('Settings › Backups: an owner place, plain words for when and what kind',()=>{
 const fake=role=>({getSnapshot:()=>({phase:'authenticated',user:{role}}),subscribe:()=>()=>{},request:async()=>{throw Error('no requests during render');}});
 for(const role of ['owner','user']){const html=renderToStaticMarkup(React.createElement(AppSettings,{signedIn:true,preference:'light',onTheme(){},onAccount(){},client:fake(role),initialTab:'backups',onOpenApps(){},onOpenTool(){}}));const nav=html.split('</nav>')[0];
  if(role==='owner'){assert.match(nav,/>Backups</);assert.match(html,/Loading backups/);}else{assert.doesNotMatch(nav,/>Backups</);assert.doesNotMatch(html,/Loading backups/);}}
 assert.match(renderToStaticMarkup(React.createElement(SettingsBackups,{client:fake('owner')})),/Loading backups/);
 const now=new Date('2026-10-29T18:40:00');
 assert.match(backupWhen('2026-10-29T03:00:00',now),/^Today /);assert.match(backupWhen('2026-10-28T03:00:00',now),/^Yesterday /);assert.doesNotMatch(backupWhen('2026-10-19T03:00:00',now),/Today|Yesterday/);
 assert.match(nextWhen('2026-10-30T03:00:00',now),/^tomorrow /);assert.equal(nextWhen('2026-10-29T03:00:00',now),'now');
 const base={id,checked:true,size:1,parts:{data:true,audit:true,keys:true},keepUntil:null};
 assert.equal(backupKind({...base,kind:'daily',at:'2026-10-29T03:00:00'},now),'automatic');assert.equal(backupKind({...base,kind:'daily',at:'2026-10-11T03:00:00'},now),'Sunday');
 assert.equal(backupKind({...base,kind:'before-update',at:'2026-10-29T18:25:00'},now),'before an update');assert.equal(backupKind({...base,kind:'manual',at:'2026-10-29T18:25:00'},now),'by you');
});
