'use strict';

// Dependency audit gate.
//
// Runs `npm audit` for one package and fails when any advisory is found, with a
// single, documented exception: an advisory listed in audit-allowlist.json is
// tolerated ONLY while it stays out of the runtime (production) dependency tree.
// The runtime posture therefore never relaxes — a tolerated advisory that ever
// reaches a production dependency blocks the build again on its own, and any
// advisory the list does not mention always blocks.
//
// The allowlist exists because some advisories have no patched release at all
// (every published version is affected) and the only npm-offered "fix" is a
// breaking major downgrade of a build-time tool. Suppressing those at the gate
// is safer than shipping an untested downgrade, as long as they cannot reach
// runtime — which this gate keeps enforcing.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ALLOWLIST_PATH = path.join(__dirname, 'audit-allowlist.json');

function ghsaId(url) {
  const match = String(url || '').match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i);
  return match ? match[0].toUpperCase() : null;
}

// Collect {package, ghsa, severity, title} rows from an `npm audit --json` report
// (npm v7+ schema: report.vulnerabilities[name].via[] with object entries for
// real advisories and string entries for transitive links).
function advisories(report) {
  const rows = [];
  const vulns = (report && report.vulnerabilities) || {};
  for (const [pkg, node] of Object.entries(vulns)) {
    for (const via of node.via || []) {
      if (typeof via !== 'object' || !via.url) continue;
      const ghsa = ghsaId(via.url);
      if (!ghsa) continue;
      rows.push({ package: pkg, ghsa, severity: via.severity || node.severity, title: via.title || '' });
    }
  }
  return rows;
}

// Pure decision function (unit-tested with fixtures, no network):
//   fullReport — `npm audit --json`
//   prodReport — `npm audit --omit=dev --json` (runtime-only)
//   allowlist  — parsed audit-allowlist.json
function evaluate(fullReport, prodReport, allowlist) {
  const allow = new Map(((allowlist && allowlist.allow) || []).map((e) => [String(e.ghsa).toUpperCase(), e]));
  const runtimeGhsas = new Set(advisories(prodReport).map((a) => a.ghsa));

  const blocking = [];
  const tolerated = [];
  const seen = new Set();
  for (const row of advisories(fullReport)) {
    const key = `${row.package}|${row.ghsa}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const allowed = allow.get(row.ghsa);
    const reachesRuntime = runtimeGhsas.has(row.ghsa);
    if (allowed && !reachesRuntime) {
      tolerated.push({ ...row, reason: allowed.reason });
    } else {
      blocking.push({ ...row, reachesRuntime });
    }
  }
  return { blocking, tolerated };
}

function runAudit(packageDir, omitDev) {
  const args = ['audit', '--package-lock-only', '--json'];
  if (omitDev) args.push('--omit=dev');
  let stdout;
  try {
    // npm audit exits non-zero when it finds advisories; the JSON is still on stdout.
    stdout = execFileSync('npm', args, { cwd: packageDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    stdout = err.stdout ? err.stdout.toString() : '';
  }
  if (!stdout.trim()) throw new Error(`npm ${args.join(' ')} produced no output in ${packageDir}`);
  return JSON.parse(stdout);
}

function main(argv) {
  const packageDir = path.resolve(argv[0] || '.');
  const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  const { blocking, tolerated } = evaluate(runAudit(packageDir, false), runAudit(packageDir, true), allowlist);

  if (tolerated.length) {
    console.log(`Tolerated (documented, development-only, no patched release) in ${packageDir}:`);
    for (const t of tolerated) console.log(`  · ${t.severity} ${t.ghsa} ${t.package} — ${t.title}`);
  }
  if (blocking.length) {
    console.error(`\nBlocking advisories in ${packageDir}:`);
    for (const b of blocking) {
      const note = b.reachesRuntime ? ' (reaches runtime — never tolerated)' : '';
      console.error(`  ✗ ${b.severity} ${b.ghsa} ${b.package} — ${b.title}${note}`);
    }
    console.error('\nFix the dependency, or (only for an unpatchable development-only advisory) add a reviewed entry to scripts/audit-allowlist.json.');
    process.exit(1);
  }
  console.log(`No blocking advisories in ${packageDir}.`);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { ghsaId, advisories, evaluate };
