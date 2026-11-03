// MOB-PAIR-01 / MOB-ONBOARD-01: the pairing screens and Settings › Phone (boards D1–D8).
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const P = require('../src/PhonePairing.tsx');
const { PhoneSettingsView } = require('../src/PhoneSettings.tsx');
const { SetupSteps } = require('../src/FirstRunSetup.tsx');
const { countdown, ago } = require('../src/phone.ts');
const h = React.createElement;
const noop = () => {};
const NOW = Date.parse('2026-11-03T10:00:15.000Z');
const QR = 'girru://pair?v=1&cid=' + 'C'.repeat(43) + '&pid=pr_x&ps=abc&exp=1793000000&relay=wss%3A%2F%2Frelay.girru.net%2Fv1';
const waiting = { state: 'waiting', qr: QR, expiresAt: '2026-11-03T10:02:00.000Z' };
const pairing = (view, extra = {}) => ({ path: 'anywhere', setPath: noop, view, notice: undefined, busy: false, allow: noop, deny: noop, renew: noop, ...extra });
const device = (id, over = {}) => ({ id: id.repeat(43), name: "Mohamed's iPhone", model: 'ios', path: 'anywhere', lifetimeDays: 90, status: 'active', pairedAt: '2026-11-03T09:00:00.000Z', lastUsedAt: '2026-11-03T09:58:00.000Z', expiresAt: null, ...over });

test('countdown and plain times', () => {
  assert.equal(countdown('2026-11-03T10:02:00.000Z', NOW), '1:45');
  assert.equal(countdown('2026-11-03T09:00:00.000Z', NOW), '0:00');
  assert.equal(ago('2026-11-03T09:58:00.000Z', NOW), '2 minutes ago');
  assert.equal(ago('2026-11-02T09:00:00.000Z', NOW), 'yesterday');
});

test('setup step D1: Phone is the last dot; QR, countdown, two paths, Back and Skip', () => {
  const dots = renderToStaticMarkup(h(SetupSteps, { current: 'Phone' }));
  assert.match(dots, /Team<\/li><li aria-current="step">Phone<\/li><\/ol>$/);
  const html = renderToStaticMarkup(h(P.PhoneSetupView, { pairing: pairing(waiting), now: NOW, onBack: noop, onSkip: noop }));
  assert.match(html, /Girru on your phone/);
  assert.match(html, /<svg class="phone-qr"[^>]*role="img" aria-label="Pairing code"/);
  assert.match(html, /<path d="(M\d+ \d+h\d+v1h-\d+z)+" fill="#111318"/);
  assert.match(html, /Waiting for your phone · new code in 1:45/);
  assert.match(html, /App Store/); assert.match(html, /Google Play/); assert.match(html, /href="https:\/\/girru.dev\/app" target="_blank" rel="noreferrer"/);
  assert.equal((html.match(/type="radio"[^>]*name="phone-path"/g) || []).length, 2);
  assert.match(html, /name="phone-path" checked="" value="anywhere"/);
  assert.match(html, /aria-label="Only on this Wi-Fi"/);
  assert.match(html, />Back<\/button>/); assert.match(html, /You can do this later in Settings › Phone\./); assert.match(html, />Skip for now<\/button>/);
  const off = renderToStaticMarkup(h(P.PhoneSetupView, { pairing: pairing(waiting, { notice: 'Only on this Wi-Fi is not turned on on this computer yet.' }), now: NOW, onBack: noop, onSkip: noop }));
  assert.match(off, /Only on this Wi-Fi is not turned on on this computer yet\./);
  const ended = renderToStaticMarkup(h(P.PhoneSetupView, { pairing: pairing({ state: 'cancelled', qr: null, expiresAt: null, warning: 'second_request' }), now: NOW, onBack: noop, onSkip: noop }));
  assert.doesNotMatch(ended, /aria-label="Pairing code"/); assert.match(ended, /Two phones used this code/); assert.match(ended, /Show a new code/);
});

test('allow dialog D2: name, model, check code in two groups, Don\'t allow / Allow', () => {
  const request = { name: "Mohamed's iPhone", model: 'ios', checkCode: '482913' };
  const html = renderToStaticMarkup(h(P.AllowPhoneDialog, { request, onAllow: noop, onDeny: noop }));
  assert.match(html, /role="dialog" aria-modal="true" aria-label="Allow Mohamed&#x27;s iPhone\?"/);
  assert.match(html, /iPhone · wants to use this computer/);
  assert.match(html, /aria-label="Check code">482 913</);
  assert.match(html, /90 days after you last use it/);
  assert.match(html, />Don&#x27;t allow<\/button><button type="button" class="primary">Allow<\/button>/);
  const step = renderToStaticMarkup(h(P.PhoneSetupView, { pairing: pairing({ state: 'request', qr: null, expiresAt: null, request: { ...request, lifetimeDays: 30 } }), now: NOW, onBack: noop, onSkip: noop }));
  assert.match(step, /482 913/); assert.match(step, /30 days after/);
});

test('ready D3 and notice D5', () => {
  const ready = renderToStaticMarkup(h(P.PhoneReadyView, { name: 'Pixel 9', path: 'wifi', lifetimeDays: 90, onBack: noop, onStart: noop }));
  assert.match(ready, /Your phone is ready/); assert.match(ready, /only on this Wi-Fi · stays signed in 90 days after last use/); assert.match(ready, />Start using Girru</);
  const notice = renderToStaticMarkup(h(P.NewPhoneNoticeView, { name: 'Pixel 9', onForget: noop, onSettings: noop, onClose: noop }));
  assert.match(notice, /Pixel 9<\/bdi> can now use Girru/); assert.match(notice, /Forget this phone/); assert.match(notice, /Open Settings › Phone/); assert.match(notice, /aria-label="Close" title="Close"/);
});

test('sidebar D4: phone button with tooltip and name; popover with QR, path line and links', () => {
  const button = renderToStaticMarkup(h(P.SidebarPhoneButton, { client: {}, onSettings: noop }));
  assert.match(button, /title="Connect a phone" aria-label="Connect a phone" aria-expanded="false"/);
  assert.doesNotMatch(button, /role="dialog"/, 'closed until pressed');
  const pop = renderToStaticMarkup(h(P.ConnectPhoneView, { pairing: pairing(waiting), now: NOW, onSettings: noop }));
  assert.match(pop, /Connect a phone/); assert.match(pop, /aria-label="Pairing code"/); assert.match(pop, /new code in 1:45/);
  assert.match(pop, /Reaches this computer anywhere/); assert.match(pop, />Change</); assert.match(pop, /No app yet\? Get it/); assert.match(pop, /Settings › Phone/);
});

test('Settings › Phone D6/D8: list, inspector, ⋯ and empty state', () => {
  const props = { error: false, now: NOW, onSelect: noop, onPair: noop, onPatch: noop, onForget: noop, onMore: noop, onRowMenu: noop, onRetry: noop };
  const overview = { computer: null, relayUrl: 'wss://relay.girru.net/v1', connection: 'connected', wifi: 'off', devices: [device('A'), device('B', { name: 'Pixel 9', model: 'android', path: 'wifi', lifetimeDays: null, lastUsedAt: '2026-11-02T09:00:00.000Z' })] };
  const html = renderToStaticMarkup(h(PhoneSettingsView, { ...props, overview, selected: 'A'.repeat(43) }));
  assert.match(html, /role="listbox" aria-label="Paired phones"/);
  assert.equal((html.match(/role="option"/g) || []).length, 2);
  assert.match(html, /aria-selected="true" tabindex="0"/);
  assert.match(html, /Anywhere · used 2 minutes ago/); assert.match(html, /Only on this Wi-Fi · used yesterday/);
  assert.match(html, /title="More" aria-label="More"/); assert.match(html, />Pair a phone</);
  assert.match(html, /<aside class="phone-inspector" aria-label="Mohamed&#x27;s iPhone"/);
  assert.match(html, /iPhone · paired 3 Nov/);
  assert.match(html, /value="Mohamed&#x27;s iPhone"/);
  assert.match(html, /aria-label="Reaches this computer"[^]*aria-checked="true"[^>]*>Anywhere</);
  assert.match(html, /aria-label="Stays signed in after last use"[^]*>30 days<[^]*aria-checked="true"[^>]*>90</);
  assert.match(html, /Last used 2 minutes ago/); assert.match(html, />Forget this phone</);
  assert.match(html, /locked end to end/);
  const empty = renderToStaticMarkup(h(PhoneSettingsView, { ...props, overview: { ...overview, devices: [] }, selected: null }));
  assert.match(empty, /No phone yet/); assert.match(empty, /Pair your phone to chat and approve when you are away\./);
  assert.equal((empty.match(/Pair a phone/g) || []).length, 1, 'one main action');
  assert.doesNotMatch(empty, /aria-label="More"|phone-inspector/);
});

test('Settings lists Phone under Connections for the owner', () => {
  const { AppSettings } = require('../src/AppSettings.tsx');
  const client = { getSnapshot: () => ({ user: { id: 'u', role: 'owner', email: 'o@x', username: 'o' } }), subscribe: () => () => {}, request: async () => ({ status: 503, body: null }) };
  const html = renderToStaticMarkup(h(AppSettings, { signedIn: true, client, preference: 'system', onTheme: noop, onAccount: noop, initialTab: 'phone' }));
  assert.match(html, /Connections<\/p>[^]*Channels[^]*Phone[^]*MCP connections/);
  assert.match(html, /aria-current="page"[^>]*>[^]*?Phone</);
});
