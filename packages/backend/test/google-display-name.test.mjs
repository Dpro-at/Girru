import test from 'node:test';
import assert from 'node:assert/strict';
import {googleDisplayName} from '../src/auth/google-account-flows.ts';

test('Create account without a name: the owner starts with the first part of the Google email (CP1a)', () => {
  assert.equal(googleDisplayName('mohamed.alarade@example.com'), 'Mohamed Alarade');
  assert.equal(googleDisplayName('sara_k+girru@example.com'), 'Sara K Girru');
  assert.equal(googleDisplayName('@example.com'), 'Owner');
  assert.ok(googleDisplayName(`${'a'.repeat(300)}@example.com`).length <= 100);
});
