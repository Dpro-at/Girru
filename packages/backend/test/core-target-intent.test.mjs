import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionedAgents, preferredMention } from '../src/agent/context/target.ts';
const team = [{ id: 'a', name: 'Ali' }, { id: 'b', name: 'Ali Hassan' }, { id: 'c', name: 'ليلى' }];
test('canonical mentions keep textual group order and longest overlapping name', () => {
  assert.deepEqual(mentionedAgents('@ليلى then @Ali Hassan', team).map(x => x.id), ['c', 'b']);
  assert.equal(preferredMention('@ليلى then @Ali Hassan', team), 'b');
  assert.deepEqual(mentionedAgents('@Ali and @Ali again', team).map(x => x.id), ['a']);
});
test('Unicode boundaries, punctuation, and embedded email-like strings match the existing backend semantics', () => {
  for (const text of ['x@Ali', '@Alina', '@Ali_2', '@ليلىمحمد', '@ليلى2']) assert.equal(preferredMention(text, team), undefined, text);
  for (const text of ['@ليلى!', 'ask @ليلى؟', '@ALI,']) assert.ok(preferredMention(text, team), text);
});
test('identical names remain ambiguous; missing and removed agents never resolve', () => {
  assert.throws(() => preferredMention('@Ali', [...team, { id: 'duplicate', name: 'ALI' }]), /ambiguous_group_mentions/);
  assert.equal(preferredMention('@Missing', team), undefined);
  assert.equal(preferredMention('@Ali Hassan', []), undefined);
});
