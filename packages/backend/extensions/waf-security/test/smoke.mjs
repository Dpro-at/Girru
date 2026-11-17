// Localhost/fixtures-only smoke test for the defensive scan engine and data model.
// Runs on Node's built-in node:sqlite (no package install) with a small .transaction() shim.
// The ONLY network target is a fixture HTTP server on 127.0.0.1 — never any remote host.
//
//   node test/smoke.mjs      (from the extension root)

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import assert from 'node:assert';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));

const raw = new DatabaseSync(':memory:');
const db = new Proxy(raw, {
  get(t, p) {
    if (p === 'transaction') return (fn) => (...a) => { t.exec('BEGIN'); try { const r = fn(...a); t.exec('COMMIT'); return r; } catch (e) { t.exec('ROLLBACK'); throw e; } };
    const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
  },
});

db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, status TEXT)");
db.prepare("INSERT INTO users (id, role, status) VALUES ('u1','owner','active')").run();
for (const f of ['001_waf_scans','002_waf_rate_limits','003_waf_payload_library','004_waf_campaigns','005_waf_assets','006_waf_findings','007_waf_coverage','008_waf_sensor'])
  db.exec(readFileSync(join(APP, 'migrations', f + '.sql'), 'utf8'));
console.log('migrations applied');

const notifications = [];
const config = { noiseProfile: 'balanced' };
const api = { db, getConfig: () => config, setConfig: (c) => Object.assign(config, c), log: () => {}, notifications: { create: async (n) => { notifications.push(n); return { id: 'n', createdAt: '' }; } } };

const { seedLibrary } = await import(join(APP, 'src/seed.js'));
assert(seedLibrary(db) >= 100);

const ev = await import(join(APP, 'src/evidence.js'));
const e1 = ev.putEvidence(db, { kind: 'banner', body: 'OpenSSH_8.4' });
assert.equal(e1.id, ev.putEvidence(db, { kind: 'banner', body: 'OpenSSH_8.4' }).id);
db.prepare('UPDATE app_waf_security__evidence SET body=? WHERE id=?').run('x', e1.id);
assert.throws(() => ev.getEvidence(db, e1.id));
console.log('evidence: dedupe + tamper-evidence OK');

const scope = await import(join(APP, 'src/scope.js'));
const server = scope.addAsset(db, 'u1', 'u1', { kind: 'server', label: 'box', host: '127.0.0.1', owner_confirmed: true });
assert.equal(server.is_private, 1);
assert.throws(() => scope.requireInScope(db, 'u1', 'u1', 'nope'));
console.log('scope: gate + log OK');

const F = await import(join(APP, 'src/findings.js'));
const f1 = F.raiseFinding(db, { userId: 'u1', assetId: server.id, category: 'open-port', title: 'redis on :6379', severity: 'high', where: '127.0.0.1:6379', signature: 'open:redis', evidence: [{ kind: 'banner', body: 'redis', role: 'proof' }] });
assert.equal(f1.id, F.raiseFinding(db, { userId: 'u1', assetId: server.id, category: 'open-port', title: 'redis on :6379', severity: 'high', where: '127.0.0.1:6379', signature: 'open:redis' }).id);
const det = F.retestFinding(db, 'u1', f1.id, { verdict: 'fixed', oppositeCheck: 'closed now', verification: { kind: 'note', body: 'closed' } });
assert.equal(det.status, 'fixed');
assert(det.evidence.some((e) => e.role === 'verification') && det.evidence.some((e) => e.role === 'proof'));
console.log('findings: dedupe + retest + evidence roles OK');

const srv = http.createServer((req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Set-Cookie', 'sid=a'); res.end('ok'); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const siteUrl = `http://127.0.0.1:${srv.address().port}/`;

const { auditHeaders } = await import(join(APP, 'src/headers-audit.js'));
const audit = await auditHeaders(siteUrl, { allowPrivate: true });
assert(!audit.checks.find((c) => c.checkKind === 'cors').ok);
console.log('headers-audit: flags wildcard CORS + missing headers');

const site = scope.addAsset(db, 'u1', 'u1', { kind: 'site', label: 'fixture', host: '127.0.0.1', base_url: siteUrl, owner_confirmed: true });
const { runAssetScan } = await import(join(APP, 'src/scan-engine.js'));
const run = await runAssetScan(db, api, { userId: 'u1', asset: site, allowPrivate: true, profile: 'balanced' });
const before = db.prepare('SELECT COUNT(*) n FROM app_waf_security__findings WHERE asset_id=?').get(site.id).n;
await runAssetScan(db, api, { userId: 'u1', asset: site, allowPrivate: true, profile: 'balanced' });
assert.equal(before, db.prepare('SELECT COUNT(*) n FROM app_waf_security__findings WHERE asset_id=?').get(site.id).n, 'rescan must not duplicate');
assert(db.prepare('SELECT COUNT(*) n FROM app_waf_security__coverage WHERE scan_id=?').get(run.scanId).n > 0, 'coverage recorded');
console.log('scan-engine: coverage + evidence-bound findings + dedupe OK');

const S = await import(join(APP, 'src/sensor.js'));
const { sensor, token } = S.pairSensor(db, 'u1', { assetId: server.id, name: 'edge' });
assert(token.startsWith('gss_'));
assert.equal(db.prepare('SELECT token_hash FROM app_waf_security__sensors WHERE id=?').get(sensor.id).token_hash.length, 64);
await S.ingestAlert(db, api, S.sensorForToken(db, token), { kind: 'cert-expiry', severity: 'high', title: '7 days' });
assert.equal(notifications.length, 1);
db.prepare("INSERT INTO users (id, role, status) VALUES ('u2','admin','active')").run();
const u2 = scope.addAsset(db, 'u2', 'u2', { kind: 'server', label: 'u2', host: '203.0.113.5', owner_confirmed: true });
assert.throws(() => S.pairSensor(db, 'u1', { assetId: u2.id, name: 'evil' }), 'cross-user pairing must be rejected');
assert.equal(db.prepare('SELECT COUNT(*) n FROM app_waf_security__sensors WHERE asset_id=?').get(u2.id).n, 0);
console.log('sensor: hash-only token + alert->notification + cross-user pairing rejected');

srv.close();
console.log('\nALL CHECKS PASSED');
