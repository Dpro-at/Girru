'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ghsaId, advisories, evaluate } = require('./audit-gate.cjs');

const ALLOWLIST = {
  allow: [{ ghsa: 'GHSA-fc5q-39xc-vjpf', reason: 'dev-only build tool, no patch' }],
};

function report(rows) {
  const vulnerabilities = {};
  for (const r of rows) {
    vulnerabilities[r.package] = {
      severity: r.severity,
      via: [{ url: `https://github.com/advisories/${r.ghsa}`, title: r.title || '', severity: r.severity }],
    };
  }
  return { vulnerabilities };
}

test('ghsaId extracts and upper-cases the advisory id, ignoring other urls', () => {
  assert.equal(ghsaId('https://github.com/advisories/GHSA-fc5q-39xc-vjpf'), 'GHSA-FC5Q-39XC-VJPF');
  assert.equal(ghsaId('https://example.com/none'), null);
});

test('advisories reads only object via entries and skips transitive string links', () => {
  const rows = advisories({ vulnerabilities: { pkg: { severity: 'high', via: ['other-pkg', { url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', title: 't' }] } } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ghsa, 'GHSA-AAAA-BBBB-CCCC');
});

test('an allowlisted advisory absent from runtime is tolerated, not blocking', () => {
  const full = report([{ package: 'picomatch', ghsa: 'GHSA-fc5q-39xc-vjpf', severity: 'high' }]);
  const prod = report([]);
  const { blocking, tolerated } = evaluate(full, prod, ALLOWLIST);
  assert.equal(blocking.length, 0);
  assert.equal(tolerated.length, 1);
  assert.equal(tolerated[0].ghsa, 'GHSA-FC5Q-39XC-VJPF');
});

test('an allowlisted advisory that reaches runtime still blocks', () => {
  const full = report([{ package: 'picomatch', ghsa: 'GHSA-fc5q-39xc-vjpf', severity: 'high' }]);
  const prod = report([{ package: 'picomatch', ghsa: 'GHSA-fc5q-39xc-vjpf', severity: 'high' }]);
  const { blocking, tolerated } = evaluate(full, prod, ALLOWLIST);
  assert.equal(tolerated.length, 0);
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].reachesRuntime, true);
});

test('an advisory that is not allowlisted always blocks', () => {
  const full = report([{ package: 'hono', ghsa: 'GHSA-4m76-xfj5-7975', severity: 'moderate' }]);
  const prod = report([{ package: 'hono', ghsa: 'GHSA-4m76-xfj5-7975', severity: 'moderate' }]);
  const { blocking } = evaluate(full, prod, ALLOWLIST);
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].ghsa, 'GHSA-4M76-XFJ5-7975');
});

test('a clean report produces nothing', () => {
  const { blocking, tolerated } = evaluate(report([]), report([]), ALLOWLIST);
  assert.equal(blocking.length, 0);
  assert.equal(tolerated.length, 0);
});
