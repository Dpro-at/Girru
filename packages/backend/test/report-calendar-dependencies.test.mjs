import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const backend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),requireBackend=createRequire(path.join(backend,'package.json'));
test('report calendar has an exact backend lock and runs with only its declared runtime dependency graph',t=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(backend,'package.json'),'utf8')),lock=JSON.parse(fs.readFileSync(path.join(backend,'package-lock.json'),'utf8'));
 assert.equal(manifest.dependencies.cron,lock.packages[''].dependencies.cron);
 assert.equal(manifest.dependencies.cron,lock.packages['node_modules/cron'].version);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'girru-calendar-prefix-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
 const queue=['cron'],seen=new Set();
 while(queue.length){const name=queue.shift();if(seen.has(name))continue;seen.add(name);const entry=lock.packages['node_modules/'+name];assert.ok(entry?.integrity&&entry.resolved.startsWith('https://registry.npmjs.org/'));
  const source=path.dirname(requireBackend.resolve(name+'/package.json')),installed=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));assert.equal(installed.version,entry.version);
  const target=path.join(root,'node_modules',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.cpSync(source,target,{recursive:true,filter:file=>file!==path.join(source,'node_modules')&&!file.startsWith(path.join(source,'node_modules')+path.sep)});
  queue.push(...Object.keys(entry.dependencies??{}));
 }
 assert.deepEqual([...seen].sort(),['@types/luxon','cron','luxon']);
 fs.copyFileSync(path.join(backend,'src/services/report-calendar.ts'),path.join(root,'report-calendar.ts'));
 fs.writeFileSync(path.join(root,'verify.mjs'),`import assert from 'node:assert/strict';import {nextReportOccurrence} from './report-calendar.ts';assert.equal(nextReportOccurrence({every:'monthly',day:31,at:'18:00',timezone:'UTC'},new Date('2026-01-31T18:00:01Z')).toISOString(),'2026-03-31T18:00:00.000Z');assert.equal(nextReportOccurrence({every:'daily',at:'10:00',timezone:'Europe/Vienna'},new Date('2026-03-28T10:00:00Z')).toISOString(),'2026-03-29T08:00:00.000Z');`);
 execFileSync(process.execPath,['--experimental-transform-types',path.join(root,'verify.mjs')],{cwd:root,env:{...process.env,NODE_PATH:''},stdio:'pipe'});
});
