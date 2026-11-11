import test from 'node:test';
import assert from 'node:assert/strict';
test('CP16: both computers compute the same trust code; a changed key or account changes it', async () => {
  const {computerTrustCode} = await import('../src/accounts/runtime.ts');
  const mac = {id: 'aaa', publicKey: 'key-mac'}, book = {id: 'bbb', publicKey: 'key-book'};
  const here = computerTrustCode('acct', mac, book), there = computerTrustCode('acct', book, mac);
  assert.equal(here, there); assert.match(here, /^[0-9A-F]{12}$/);
  assert.notEqual(computerTrustCode('acct', mac, {...book, publicKey: 'other'}), here, 'a swapped key shows a different code');
  assert.notEqual(computerTrustCode('other-acct', mac, book), here);
});
