import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanComputerLabel, osFamilyOf, thisComputer} from '../src/accounts/this-computer.ts';

test('a computer registers with its own name, system and version, never “Computer / other / 1”', () => {
  const me = thisComputer();
  assert.ok(me.label.length > 0 && me.label.length <= 64);
  assert.equal(me.osFamily, osFamilyOf(process.platform));
  assert.match(me.appVersion, /^[A-Za-z0-9.+_-]{1,40}$/);
});

test('computer names are cleaned to what the account service accepts', () => {
  assert.equal(cleanComputerLabel('Mohameds-MacBook-Pro.local'), 'Mohameds-MacBook-Pro');
  assert.equal(cleanComputerLabel('  Office\tPC \n'), 'Office PC');
  assert.equal(cleanComputerLabel('x'.repeat(80))?.length, 64);
  assert.equal(cleanComputerLabel('   '), null);
  assert.equal(cleanComputerLabel(undefined), null);
  assert.deepEqual(['darwin', 'win32', 'linux', 'freebsd'].map(p => osFamilyOf(p)), ['macos', 'windows', 'linux', 'other']);
});
