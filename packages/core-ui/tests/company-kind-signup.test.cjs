// ONBOARD-COMPANYTYPE-01: "What does your company do?" right after the company name.
// The answer travels in the owner-setup body (company only), comes back from
// /api/first-run, and the Team step uses it instead of asking again.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { validOwnerSetupBody } = require('../src/owner-setup-contract.js');
const { firstRunResponse } = require('../src/first-run-contract.js');
const { COMPANY_KIND_CHOICES, validCompanyKind } = require('../src/company-kinds.js');
const { allowed } = require('../scripts/application-server.cjs');
const { KindStep } = require('../src/CompanyWizard.tsx');

const owner = { name: 'Fictional Owner', email: 'owner@example.invalid', password: 'fictional-pass-1234', setupToken: 'Fictional_setup_code_for_tests_only_000000a', workspaceType: 'company', companyName: 'Example Company' };
const KIND = COMPANY_KIND_CHOICES[0].id;

test('owner setup carries a company kind only for a company, and only a valid one', () => {
  for (const companyKind of ['', KIND, 'custom:Robot repair']) {
    assert.equal(validOwnerSetupBody({ ...owner, companyKind }), true, companyKind);
    assert.equal(allowed('POST', '/api/setup/admin', { ...owner, companyKind }), true, 'the bridge forwards the same body');
  }
  for (const companyKind of [null, 1, 'unknown kind', 'custom:', 'custom: padded', 'custom:semi;colon']) assert.equal(validOwnerSetupBody({ ...owner, companyKind }), false, String(companyKind));
  const { companyName, ...personal } = owner;
  assert.equal(validOwnerSetupBody({ ...personal, workspaceType: 'individual', companyKind: KIND }), false);
  assert.equal(validOwnerSetupBody({ ...personal, workspaceType: undefined, companyKind: KIND }), false);
  assert.equal(validCompanyKind(KIND), true);
});

test('/api/first-run returns the kind for a company and refuses it otherwise', () => {
  const base = { pending: true, step: 'team', workspaceType: 'company', companyName: 'Example Company' };
  assert.deepEqual(firstRunResponse('/api/first-run', 200, { ...base, companyKind: KIND }), { ...base, companyKind: KIND });
  assert.deepEqual(firstRunResponse('/api/first-run', 200, base), base, 'no kind when none was answered');
  assert.throws(() => firstRunResponse('/api/first-run', 200, { ...base, companyKind: 'unknown kind' }));
  assert.throws(() => firstRunResponse('/api/first-run', 200, { pending: true, step: 'team', workspaceType: 'individual', companyKind: KIND }));
});

test('the moved page shows the orb before the account exists and keeps an earlier answer', () => {
  const props = { workspaceType: 'company', kinds: COMPANY_KIND_CHOICES, more: 0, query: '', busy: false, onQuery() {}, onMore() {}, onBack() {}, onDone() {} };
  const html = renderToStaticMarkup(React.createElement(KindStep, { ...props, orb: true, value: 'custom:Robot repair' }));
  assert.match(html, /What does your company do\?/);
  assert.match(html, /setup-intro/);
  assert.match(html, /value="Robot repair"/, 'going back keeps the typed specialty');
  for (const k of COMPANY_KIND_CHOICES) assert.ok(html.includes(k.label.replace(/,/g, ',')), k.label);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(KindStep, props)), /setup-intro/, 'inside the Team step it has no orb of its own');
});

test('sign-up order and the Team step reuse: the kind is asked once, then applied to the departments', () => {
  const auth = fs.readFileSync(path.join(__dirname, '../src/AuthBoundary.tsx'), 'utf8');
  assert.match(auth, /setAskKind\(type === 'company'\)/, 'only a company is asked');
  assert.match(auth, /if \(askKind\) return <KindStep orb/, 'the kind page comes before the account form');
  assert.match(auth, /companyKind !== undefined \? \{ companyKind \}/, 'the answer goes with the owner');
  const team = fs.readFileSync(path.join(__dirname, '../src/CompanyWizard.tsx'), 'utf8');
  assert.match(team, /if \(companyKind !== undefined\) applyKind\(companyKind\);/, 'a saved kind ticks the departments at once');
  assert.match(team, /onClick=\{\(\) => setKind\(null\)\}>Change</, 'Change opens the kind list again');
});

test('the main-work card keeps its tile small (no stretched bar)', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');
  assert.match(css, /\.setup-mainwork > \.ag-tile \{ flex:none; \}/);
  assert.doesNotMatch(css, /\.setup-mainwork > span:nth-of-type\(1\)/);
});
