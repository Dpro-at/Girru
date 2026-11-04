// The phone's terminal keys (boards P24–P26).
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PHONE_KEYS, withCtrl, pastedLines, isPhoneShell } = require('../src/phone-terminal-keys.ts');

test('keys send what a real keyboard sends', () => {
  const send = Object.fromEntries(PHONE_KEYS.filter(k => k.send).map(k => [k.id, k.send]));
  assert.equal(send['ctrl-c'], '\x03');
  assert.equal(send['ctrl-d'], '\x04');
  assert.equal(send.esc, '\x1b');
  assert.equal(send.tab, '\t');
  assert.deepEqual([send.up, send.down, send.right, send.left], ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D']);
  assert.deepEqual(PHONE_KEYS.slice(0, 4).map(k => k.id), ['ctrl-c', 'ctrl-d', 'esc', 'tab']);
  assert.ok(PHONE_KEYS.every(k => k.aria.length > 0));
});

test('Ctrl turns the next letter into its control code', () => {
  assert.equal(withCtrl('c'), '\x03');
  assert.equal(withCtrl('Z'), '\x1a');
  assert.equal(withCtrl('l'), '\x0c');
  assert.equal(withCtrl('['), '\x1b');
  assert.equal(withCtrl('1'), '1');
  assert.equal(withCtrl('ab'), 'ab');
});

test('pasted text: lines counted, a trailing newline is not a line', () => {
  assert.deepEqual(pastedLines('ls'), ['ls']);
  assert.deepEqual(pastedLines('ls\n'), ['ls']);
  assert.deepEqual(pastedLines('cd x\r\ngit pull\nnpm i'), ['cd x', 'git pull', 'npm i']);
});

test('the phone shell is known only by its object', () => {
  assert.equal(isPhoneShell({ girruShell: { platform: 'ios' } }), true);
  assert.equal(isPhoneShell({}), false);
  assert.equal(isPhoneShell(undefined), false);
});
