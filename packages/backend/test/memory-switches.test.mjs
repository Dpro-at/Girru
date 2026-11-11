// STORE-MAP-01: every memory switch is on by default, `=0` turns one off, and each has a
// removal date (OPS9). The desktop app passes each switch through to the backend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MEMORY_SWITCHES, PILOT_SWITCH, memorySwitchOn, memorySwitchStates, memorySwitchesOff } from '../src/services/memory-switches.ts';
import { storeP2Enabled, oneContextEnabled } from '../src/services/agent-context/switch.ts';
import { storeP2bEnabled } from '../src/services/store-p2b.ts';
import { storeP3Enabled } from '../src/services/store-p3.ts';
import { storeP4Enabled } from '../src/services/store-p4.ts';
import { storeP5Enabled } from '../src/services/store-p5.ts';
import { storeP6Enabled } from '../src/services/store-p6.ts';
import { storeP7Enabled } from '../src/services/store-p7.ts';
import { storeP8Enabled } from '../src/services/store-p8.ts';
import { storeP9Enabled } from '../src/services/store-p9.ts';
import { storeP9bEnabled } from '../src/services/store-p9b.ts';
import { memoryHelperEnabled } from '../src/services/memory-helper-switch.ts';
import { docIndexEnabled } from '../src/services/doc-index-switch.ts';
import { repoTrustEnabled } from '../src/services/repo-trust-switch.ts';

const require = createRequire(import.meta.url);
const { backendEnv } = require('../../desktop/src/backend-process.cjs');

const CHECKS = {
  GIRRU_STORE_P2: storeP2Enabled, GIRRU_STORE_P2B: storeP2bEnabled, GIRRU_STORE_P3: storeP3Enabled,
  GIRRU_STORE_P4: storeP4Enabled, GIRRU_STORE_P5: storeP5Enabled, GIRRU_STORE_P6: storeP6Enabled,
  GIRRU_STORE_P7: storeP7Enabled, GIRRU_STORE_P8: storeP8Enabled, GIRRU_STORE_P9: storeP9Enabled,
  GIRRU_STORE_P9B: storeP9bEnabled, GIRRU_MEMORY_HELPER: memoryHelperEnabled, GIRRU_DOC_INDEX: docIndexEnabled, GIRRU_REPO_TRUST: repoTrustEnabled,
};

test('every memory switch is listed once, with a removal date after the day it went on', () => {
  assert.deepEqual(MEMORY_SWITCHES.map((s) => s.env).sort(), Object.keys(CHECKS).sort());
  for (const s of MEMORY_SWITCHES) {
    assert.match(s.removeBy, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(s.removeBy > s.onByDefaultSince, `${s.env} removal date`);
  }
  assert.equal(PILOT_SWITCH.env, 'GIRRU_STORE_PILOT');
});

test('on when unset or on; off only for 0 / false / no / off; anything else stays on', () => {
  for (const [name, check] of Object.entries(CHECKS)) {
    assert.equal(check({}), true, `${name} unset`);
    for (const v of ['1', 'true', 'YES', ' on ', '']) assert.equal(check({ [name]: v }), true, `${name}=${v}`);
    for (const v of ['0', 'false', 'No', ' OFF ']) assert.equal(check({ [name]: v }), false, `${name}=${v}`);
    assert.equal(check({ [name]: 'maybe' }), true, `${name}=maybe`);
  }
  assert.equal(memorySwitchOn('GIRRU_STORE_P3', { GIRRU_STORE_P3: '0' }), false);
});

test('one context stays on while P2 or P4 is on', () => {
  assert.equal(oneContextEnabled({}), true);
  assert.equal(oneContextEnabled({ GIRRU_STORE_P2: '0' }), true);
  assert.equal(oneContextEnabled({ GIRRU_STORE_P2: '0', GIRRU_STORE_P4: '0' }), false);
});

test('states list what is off and what is past its removal date', () => {
  assert.deepEqual(memorySwitchesOff({}), []);
  assert.deepEqual(memorySwitchesOff({ GIRRU_STORE_P9B: '0', GIRRU_MEMORY_HELPER: 'off' }), ['p9b', 'memoryHelper']);
  const s = MEMORY_SWITCHES[0];
  assert.equal(memorySwitchStates({}, new Date(`${s.removeBy}T12:00:00Z`)).every((x) => !x.expired), true);
  const later = new Date(Date.parse(`${s.removeBy}T00:00:00Z`) + 2 * 86_400_000);
  assert.equal(memorySwitchStates({}, later).every((x) => x.expired && x.on), true);
});

test('the desktop app passes every memory switch to the backend (and nothing else new)', () => {
  const base = Object.fromEntries(MEMORY_SWITCHES.map((s) => [s.env, '0']));
  const env = backendEnv({ base: { ...base, GIRRU_STORE_PILOT: 'p1', SOME_SECRET: 'x' }, dataDir: '/d', token: 't', allowedOrigin: 'o' });
  for (const s of MEMORY_SWITCHES) assert.equal(env[s.env], '0', s.env);
  assert.equal(env.SOME_SECRET, undefined);
  assert.equal(env.GIRRU_STORE_PILOT, undefined);
});
