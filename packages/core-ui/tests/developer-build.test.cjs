require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { isDeveloperBuild, accountRoleLabel } = require('../src/developer-build.ts');
const { SessionClient } = require('../src/session.ts');
const { AuthBoundary } = require('../src/AuthBoundary.tsx');
const { ChatDestination } = require('../src/ChatDestination.tsx');
const { createLoginMock } = require('../src/session-mock.ts');
const live = { request: () => { throw Error('no network in tests'); } };

test('SH2: only a build with practice mode, or without live sign-in, is a developer build', () => {
  assert.equal(isDeveloperBuild(new SessionClient({ live })), false);
  assert.equal(isDeveloperBuild(new SessionClient({ mock: createLoginMock() })), true);
  assert.equal(isDeveloperBuild(new SessionClient({ live, mock: createLoginMock() })), true);
  assert.equal(isDeveloperBuild(new SessionClient({})), true);
});
test('SH2: the live-only build shows no session-mode bar and no draft-copy note', () => {
  const client = new SessionClient({ live });
  const html = renderToStaticMarkup(React.createElement(AuthBoundary, { client }, null));
  assert.doesNotMatch(html, /Session mode|English draft|Return to fixture|Open offline login mock/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(ChatDestination, { client })), /English draft/);
  const practice = new SessionClient({ mock: createLoginMock() });
  assert.match(renderToStaticMarkup(React.createElement(AuthBoundary, { client: practice }, null)), /Session mode/);
});
test('SH2: the account chip says plain words, never the raw role key', () => {
  assert.equal(accountRoleLabel('owner'), 'Owner of this workspace');
  assert.equal(accountRoleLabel('guest'), 'Guest');
  assert.equal(accountRoleLabel('admin'), '');
  assert.equal(accountRoleLabel('user'), '');
  const shell = fs.readFileSync(path.join(__dirname, '../src/SignedInShell.tsx'), 'utf8');
  assert.doesNotMatch(shell, /<small>\{user\.role\}<\/small>/);
  assert.match(shell, /extra=\{(?:<>\{)?isDeveloperBuild\(client\) && <button[^\n]*Leave to fixture/);
});
