import './fixtures/trading-runtime.mjs';
// Girru's own Alpaca client (replaces @alpacahq/alpaca-trade-api 3.x): requests, errors, bar pages,
// and the live stream, against a fake fetch and a fake WebSocket. No network.
// Run: node --import tsx --test test/trading-alpaca-rest.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlpacaRest, AlpacaError } from './fixtures/legacy-apps/extensions/trading/src/alpaca-rest.js';
import { getAccountInfo, getHistoricalBars, getLatestQuote, getOptionsChain, placeOrder } from './fixtures/legacy-apps/extensions/trading/src/alpaca-client.js';

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body, redirect: init.redirect });
    const u = new URL(String(url));
    const answer = routes(u, init);
    const [status, body] = Array.isArray(answer) ? answer : [200, answer];
    return { ok: status >= 200 && status < 300, status, statusText: 'x', text: async () => body === undefined ? '' : JSON.stringify(body) };
  };
  return { fetch, calls };
}

test('trading calls go to the paper or live host with the key headers', async () => {
  const { fetch, calls } = fakeFetch((u) => u.pathname === '/v2/account' ? { id: 'acc-1', status: 'ACTIVE', cash: '10.5', portfolio_value: '20', equity: '20', buying_power: '40' } : [404, { message: 'no' }]);
  const paper = createAlpacaRest({ keyId: 'K', secretKey: 'S', paper: true, fetch });
  const info = await getAccountInfo(paper);
  assert.equal(info.id, 'acc-1'); assert.equal(info.cash, 10.5);
  assert.equal(calls[0].url, 'https://paper-api.alpaca.markets/v2/account');
  assert.equal(calls[0].redirect, 'error', 'credentials must never follow a redirect');
  assert.equal(calls[0].headers['APCA-API-KEY-ID'], 'K'); assert.equal(calls[0].headers['APCA-API-SECRET-KEY'], 'S');
  await createAlpacaRest({ keyId: 'K', secretKey: 'S', paper: false, fetch }).getAccount();
  assert.equal(calls[1].url, 'https://api.alpaca.markets/v2/account');
  assert.throws(() => createAlpacaRest({ keyId: '', secretKey: 'S', fetch }), /required/);
});

test('an order is sent as JSON; an Alpaca refusal keeps its status in the message', async () => {
  const { fetch, calls } = fakeFetch((_u, init) => init.method === 'POST'
    ? (JSON.parse(init.body).symbol === 'NOPE' ? [403, { message: 'forbidden' }] : { id: 'o1', symbol: 'AAPL', qty: '2', side: 'buy', type: 'limit', status: 'accepted', submitted_at: 'now' })
    : [404, {}]);
  const alpaca = createAlpacaRest({ keyId: 'K', secretKey: 'S', fetch });
  const order = await placeOrder(alpaca, { symbol: 'AAPL', qty: 2, side: 'buy', order_type: 'limit', limit_price: 10 });
  assert.equal(order.id, 'o1'); assert.equal(order.qty, 2); assert.equal(order.order_class, 'simple');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].body), { symbol: 'AAPL', qty: 2, side: 'buy', type: 'limit', time_in_force: 'day', limit_price: 10 });
  const err = await alpaca.createOrder({ symbol: 'NOPE' }).catch((e) => e);
  assert.ok(err instanceof AlpacaError); assert.equal(err.status, 403); assert.match(err.message, /^403 forbidden/);
});

test('bars come page by page in the old names and stop at the limit; quotes fall back to the latest bar', async () => {
  const { fetch, calls } = fakeFetch((u) => {
    if (u.pathname === '/v2/stocks/AAPL/bars') {
      return u.searchParams.get('page_token') === 'p2'
        ? { bars: [{ t: 't3', o: 3, h: 3, l: 3, c: 3, v: 30 }, { t: 't4', o: 4, h: 4, l: 4, c: 4, v: 40 }], next_page_token: 'p3' }
        : { bars: [{ t: 't1', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }, { t: 't2', o: 2, h: 2, l: 2, c: 2, v: 20 }], next_page_token: 'p2' };
    }
    if (u.pathname === '/v2/stocks/AAPL/quotes/latest') return [500, { message: 'down' }];
    if (u.pathname === '/v2/stocks/AAPL/bars/latest') return { bar: { t: 'tb', c: 9.5 } };
    return [404, {}];
  });
  const alpaca = createAlpacaRest({ keyId: 'K', secretKey: 'S', fetch });
  const bars = await getHistoricalBars(alpaca, 'aapl', '1Day', { limit: 3 });
  assert.deepEqual(bars.map((b) => b.timestamp), ['t1', 't2', 't3'], 'three bars over two pages, then it stops');
  assert.deepEqual(bars[0], { timestamp: 't1', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
  assert.equal(new URL(calls[0].url).host, 'data.alpaca.markets');
  assert.equal(new URL(calls[0].url).searchParams.get('feed'), 'iex');
  assert.equal(calls.length, 2, 'no third page asked for');
  const quote = await getLatestQuote(alpaca, 'AAPL');
  assert.equal(quote.bid_price, 9.5); assert.equal(quote.timestamp, 'tb');
});

test('the options chain reads option_contracts', async () => {
  const { fetch, calls } = fakeFetch(() => ({ option_contracts: [{ symbol: 'AAPL260117C00150000', underlying_symbol: 'AAPL', expiration_date: '2026-01-17', strike_price: '150', type: 'call' }], next_page_token: null }));
  const chain = await getOptionsChain(createAlpacaRest({ keyId: 'K', secretKey: 'S', fetch }), 'AAPL', { optionType: 'call' });
  assert.equal(chain.length, 1); assert.equal(chain[0].strike_price, 150); assert.equal(chain[0].option_type, 'call');
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, '/v2/options/contracts'); assert.equal(u.searchParams.get('underlying_symbols'), 'AAPL'); assert.equal(u.searchParams.get('type'), 'call');
});

test('the stream signs in, subscribes, and passes trades and quotes on', () => {
  const sockets = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.sent = []; this.handlers = {}; this.closed = false; sockets.push(this); }
    addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.closed = true; }
    emit(name, event) { for (const fn of this.handlers[name] || []) fn(event); }
  }
  const got = []; let connected = 0;
  const stream = createAlpacaRest({ keyId: 'K', secretKey: 'S', WebSocket: FakeSocket }).stream({
    symbols: ['AAPL'], onConnect: () => connected++, onTrade: (t) => got.push(['t', t.S, t.p]), onQuote: (q) => got.push(['q', q.S, q.bp, q.ap]), onError: (e) => got.push(['e', e.message]),
  });
  const s = sockets[0];
  assert.equal(s.url, 'wss://stream.data.alpaca.markets/v2/iex');
  s.emit('open');
  assert.deepEqual(s.sent[0], { action: 'auth', key: 'K', secret: 'S' });
  s.emit('message', { data: JSON.stringify([{ T: 'success', msg: 'connected' }, { T: 'success', msg: 'authenticated' }]) });
  assert.deepEqual(s.sent[1], { action: 'subscribe', trades: ['AAPL'], quotes: ['AAPL'] });
  assert.equal(connected, 1);
  s.emit('message', { data: JSON.stringify([{ T: 't', S: 'AAPL', p: 101.5, s: 3, t: 'x' }, { T: 'q', S: 'AAPL', bp: 101, ap: 102, bs: 1, as: 2, t: 'y' }, { T: 'error', code: 402, msg: 'auth failed' }]) });
  s.emit('message', { data: 'not json' });
  assert.deepEqual(got, [['t', 'AAPL', 101.5], ['q', 'AAPL', 101, 102], ['e', '402 auth failed']]);
  stream.close();
  assert.equal(s.closed, true);
});


test('generic requests cannot turn an API path into another credential destination', async () => {
  let requests = 0;
  const client = createAlpacaRest({ keyId: 'K', secretKey: 'S', fetch: async () => { requests++; throw new Error('must not fetch'); } });
  for (const url of ['@example.invalid/v2/account', '//example.invalid/v2/account', 'https://example.invalid/v2/account']) {
    await assert.rejects(client.request({ url }), /relative API path/);
  }
  assert.equal(requests, 0);
});
