/**
 * Alpaca REST and stream client: Girru's own, on Node's built-in fetch and WebSocket.
 *
 * It replaces @alpacahq/alpaca-trade-api 3.x (which pulled in eslint and an old
 * minimatch, GHSA-g3hv-75wg-m249; 4.x and 5.x are rewrites with another API).
 * Only what alpaca-client.js uses is here, with the same method names, so the
 * wrapper and its callers stay as they are. Responses are Alpaca's own JSON
 * (snake_case trading fields, short market-data fields such as bp/ap/c/t).
 */

const TRADING_URL = { paper: 'https://paper-api.alpaca.markets', live: 'https://api.alpaca.markets' };
const DATA_URL = 'https://data.alpaca.markets';
const STREAM_URL = 'wss://stream.data.alpaca.markets/v2';
const TIMEOUT_MS = 20_000;
/** Page size for bar requests (Alpaca allows up to 10000). */
const BAR_PAGE = 1000;

/** An Alpaca answer that is not 2xx; the message keeps the status so callers can tell 403 apart. */
export class AlpacaError extends Error {
  constructor(status, message) {
    super(`${status} ${message}`);
    this.name = 'AlpacaError';
    this.status = status;
  }
}

function query(params) {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    q.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * @param {{ keyId: string, secretKey: string, paper?: boolean, feed?: string, fetch?: typeof fetch, WebSocket?: typeof WebSocket }} options
 */
export function createAlpacaRest({ keyId, secretKey, paper = true, feed = 'iex', fetch: get = globalThis.fetch, WebSocket: Socket = globalThis.WebSocket }) {
  if (!keyId || !secretKey) throw new Error('Alpaca API key and secret are required');
  const tradingUrl = paper ? TRADING_URL.paper : TRADING_URL.live;
  const headers = { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secretKey, Accept: 'application/json' };

  async function call(base, method, path, { params, body } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new Error('Alpaca request requires a relative API path');
    const res = await get(`${base}${path}${query(params)}`, {
      method,
      redirect: 'error',
      headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) throw new AlpacaError(res.status, (data && (data.message || data.error)) || res.statusText || 'request failed');
    return data;
  }
  const trading = (method, path, options) => call(tradingUrl, method, path, options);
  const data = (path, params) => call(DATA_URL, 'GET', path, { params });
  const symbolPath = (symbol) => encodeURIComponent(String(symbol).toUpperCase());

  return {
    getAccount: () => trading('GET', '/v2/account'),
    getPositions: () => trading('GET', '/v2/positions'),
    getOrders: ({ status, limit } = {}) => trading('GET', '/v2/orders', { params: { status, limit } }),
    createOrder: (order) => trading('POST', '/v2/orders', { body: order }),
    cancelOrder: (orderId) => trading('DELETE', `/v2/orders/${encodeURIComponent(orderId)}`),
    getClock: () => trading('GET', '/v2/clock'),
    getCalendar: ({ start, end } = {}) => trading('GET', '/v2/calendar', { params: { start, end } }),
    getAssets: ({ status, asset_class } = {}) => trading('GET', '/v2/assets', { params: { status, asset_class } }),
    /** A trading API call by path; `url` starts with /v2. */
    request: ({ method = 'GET', url, params, body }) => trading(method, url, { params, body }),

    async getLatestQuote(symbol) {
      const r = await data(`/v2/stocks/${symbolPath(symbol)}/quotes/latest`, { feed });
      if (!r?.quote) throw new AlpacaError(404, `no quote for ${symbol}`);
      return r.quote;
    },
    async getLatestBar(symbol) {
      const r = await data(`/v2/stocks/${symbolPath(symbol)}/bars/latest`, { feed });
      if (!r?.bar) throw new AlpacaError(404, `no bar for ${symbol}`);
      return r.bar;
    },
    /** Bars, page by page, as the old SDK named them (Timestamp, OpenPrice, …); `limit` is the total. */
    async *getBarsV2(symbol, { timeframe = '1Day', limit, start, end } = {}) {
      let left = Number.isInteger(limit) && limit > 0 ? limit : Infinity;
      let page_token;
      do {
        const r = await data(`/v2/stocks/${symbolPath(symbol)}/bars`, { timeframe, start, end, feed, limit: Math.min(left, BAR_PAGE), page_token });
        for (const b of r?.bars || []) {
          yield { Timestamp: b.t, OpenPrice: b.o, HighPrice: b.h, LowPrice: b.l, ClosePrice: b.c, Volume: b.v };
          if (--left <= 0) return;
        }
        page_token = r?.next_page_token || undefined;
      } while (page_token);
    },
    async getNews(params = {}) {
      const r = await data('/v1beta1/news', params);
      return r?.news || [];
    },

    /**
     * Live trades and quotes for stock symbols. Messages are Alpaca's short form
     * ({ T: 't', S, p, s, t } and { T: 'q', S, bp, ap, bs, as, t }).
     */
    stream({ symbols, onTrade, onQuote, onError, onConnect }) {
      if (typeof Socket !== 'function') throw new Error('This Node.js has no WebSocket');
      const socket = new Socket(`${STREAM_URL}/${feed}`);
      let closed = false;
      socket.addEventListener('open', () => socket.send(JSON.stringify({ action: 'auth', key: keyId, secret: secretKey })));
      socket.addEventListener('message', (event) => {
        let messages;
        try { messages = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
        for (const m of Array.isArray(messages) ? messages : [messages]) {
          if (m.T === 'success' && m.msg === 'authenticated') {
            socket.send(JSON.stringify({ action: 'subscribe', trades: symbols, quotes: symbols }));
            onConnect?.();
          } else if (m.T === 'error') onError?.(new AlpacaError(m.code || 0, m.msg || 'stream error'));
          else if (m.T === 't') onTrade?.(m);
          else if (m.T === 'q') onQuote?.(m);
        }
      });
      socket.addEventListener('error', () => { if (!closed) onError?.(new Error('Alpaca stream connection error')); });
      return { close() { closed = true; try { socket.close(); } catch { /* already closed */ } } };
    },
  };
}
