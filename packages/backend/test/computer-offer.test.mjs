import test from 'node:test';
import assert from 'node:assert/strict';
import {computerOffer, computerOfferTool} from '../src/tools/computer-offer.ts';

test('CP11a: an offer only describes steps; it sends nothing and asks the agent to wait', async () => {
  const ok = computerOffer({why: ' Office PC is free. ', steps: [{title: 'Relay\nmessages', computer: 'Office PC', text: 'Build the relay part.'}]});
  assert.deepEqual(ok, {why: 'Office PC is free.', steps: [{title: 'Relay messages', computer: 'Office PC', text: 'Build the relay part.'}]});
  for (const bad of [{}, {steps: []}, {steps: [{title: 'x', computer: '', text: 'y'}]}, {steps: Array.from({length: 7}, () => ({title: 'a', computer: 'b', text: 'c'}))}]) assert.equal(typeof computerOffer(bad), 'string');
  const r = await computerOfferTool.execute({steps: [{title: 'a', computer: 'Office PC', text: 'c'}]}, {});
  assert.match(r.content[0].text, /Nothing is sent until they press Send/);
  assert.equal(computerOfferTool.selfOnly, true);
});
