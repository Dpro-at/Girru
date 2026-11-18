/**
 * Alpaca API Client Wrapper
 *
 * Handles authentication, API calls, and error handling for Alpaca trading API
 * Supports: Paper Trading, Live Trading, Stocks, Crypto, Real-time data
 */

import { createAlpacaRest } from './alpaca-rest.js';

/**
 * Create Alpaca client instance
 * @param {string} apiKey - Alpaca API key
 * @param {string} apiSecret - Alpaca API secret
 * @param {string} mode - 'paper' or 'live'
 * @returns {ReturnType<typeof createAlpacaRest>} Alpaca client instance
 */
export function createAlpacaClient(apiKey, apiSecret, mode = 'paper') {
  return createAlpacaRest({
    keyId: apiKey,
    secretKey: apiSecret,
    paper: mode === 'paper',
    feed: 'iex', // IEX for stocks, use 'sip' for crypto
  });
}

/**
 * Get account information
 * @param {ReturnType<typeof createAlpacaRest>} alpaca - Alpaca client
 * @returns {Promise<Object>} Account information
 */
export async function getAccountInfo(alpaca) {
  try {
    const account = await alpaca.getAccount();
    return {
      id: account.id,
      status: account.status,
      cash: parseFloat(account.cash),
      portfolio_value: parseFloat(account.portfolio_value),
      equity: parseFloat(account.equity),
      buying_power: parseFloat(account.buying_power),
      account_blocked: account.account_blocked,
      trade_suspended_by_user: account.trade_suspended_by_user,
      trading_blocked: account.trading_blocked,
      transfers_blocked: account.transfers_blocked,
    };
  } catch (error) {
    console.error('[Alpaca] Failed to get account info:', error);
    throw new Error(`Alpaca API error: ${error.message}`);
  }
}

/**
 * Get all positions
 * @param {ReturnType<typeof createAlpacaRest>} alpaca - Alpaca client
 * @returns {Promise<Array>} List of positions
 */
export async function getPositions(alpaca) {
  try {
    const positions = await alpaca.getPositions();
    return positions.map(pos => ({
      symbol: pos.symbol,
      asset_class: pos.asset_class,
      qty: parseFloat(pos.qty),
      avg_entry_price: parseFloat(pos.avg_entry_price),
      current_price: parseFloat(pos.current_price),
      market_value: parseFloat(pos.market_value),
      unrealized_pl: parseFloat(pos.unrealized_pl),
      unrealized_plpc: parseFloat(pos.unrealized_plpc),
      side: pos.side,
    }));
  } catch (error) {
    console.error('[Alpaca] Failed to get positions:', error);
    throw new Error(`Alpaca API error: ${error.message}`);
  }
}

/**
 * Get recent orders
 * @param {ReturnType<typeof createAlpacaRest>} alpaca - Alpaca client
 * @param {string} status - 'all', 'open', 'closed'
 * @param {number} limit - Max number of orders to return
 * @returns {Promise<Array>} List of orders
 */
export async function getOrders(alpaca, status = 'all', limit = 50) {
  try {
    const orders = await alpaca.getOrders({ status, limit });
    return orders.map(order => ({
      id: order.id,
      symbol: order.symbol,
      asset_class: order.asset_class,
      qty: parseFloat(order.qty),
      side: order.side,
      order_type: order.type,
      time_in_force: order.time_in_force,
      limit_price: order.limit_price ? parseFloat(order.limit_price) : null,
      stop_price: order.stop_price ? parseFloat(order.stop_price) : null,
      filled_avg_price: order.filled_avg_price ? parseFloat(order.filled_avg_price) : null,
      status: order.status,
      filled_qty: parseFloat(order.filled_qty || 0),
      submitted_at: order.submitted_at,
      filled_at: order.filled_at,
      canceled_at: order.canceled_at,
    }));
  } catch (error) {
    console.error('[Alpaca] Failed to get orders:', error);
    throw new Error(`Alpaca API error: ${error.message}`);
  }
}

/**
 * Place a new order
 * @param {ReturnType<typeof createAlpacaRest>} alpaca - Alpaca client
 * @param {Object} orderParams - Order parameters
 * @returns {Promise<Object>} Order confirmation
 */
export async function placeOrder(alpaca, orderParams) {
  try {
    const orderData = {
      symbol: orderParams.symbol,
      qty: orderParams.qty,
      side: orderParams.side, // 'buy' or 'sell'
      type: orderParams.order_type || 'market',
      time_in_force: orderParams.time_in_force || 'day',
      limit_price: orderParams.limit_price,
      stop_price: orderParams.stop_price,
    };

    // Advanced Order Types
    if (orderParams.order_class) {
      orderData.order_class = orderParams.order_class;
    }

    // Bracket Order: Take Profit + Stop Loss
    if (orderParams.order_class === 'bracket') {
      if (orderParams.take_profit) {
        orderData.take_profit = orderParams.take_profit;
      }
      if (orderParams.stop_loss) {
        orderData.stop_loss = orderParams.stop_loss;
      }
    }

    // Trailing Stop
    if (orderParams.order_class === 'trailing_stop') {
      if (orderParams.trail_amount) {
        orderData.trail_amount = orderParams.trail_amount;
      } else if (orderParams.trail_percent) {
        orderData.trail_percent = orderParams.trail_percent;
      }
    }

    // OCO (One-Cancels-Other) - Note: Alpaca has no single OCO request here
    // This would need to be handled by placing two separate orders and managing cancellation
    if (orderParams.order_class === 'oco' && orderParams.oco_order) {
      // For now, we'll place the primary order
      // TODO: Implement OCO logic by placing second order and linking them
      console.warn('[Alpaca] OCO orders require custom implementation');
    }

    const order = await alpaca.createOrder(orderData);

    return {
      id: order.id,
      symbol: order.symbol,
      asset_class: order.asset_class,
      qty: parseFloat(order.qty),
      side: order.side,
      order_type: order.type,
      order_class: order.order_class || 'simple',
      status: order.status,
      submitted_at: order.submitted_at,
    };
  } catch (error) {
    console.error('[Alpaca] Failed to place order:', error);
    throw new Error(`Alpaca API error: ${error.message}`);
  }
}

/**
 * Cancel an order
 * @param {ReturnType<typeof createAlpacaRest>} alpaca - Alpaca client
 * @param {string} orderId - Order ID to cancel
 * @returns {Promise<Object>} Cancellation result
 */
export async function cancelOrder(alpaca, orderId) {
  try {
    await alpaca.cancelOrder(orderId);
    return { success: true, orderId };
  } catch (error) {
    console.error('[Alpaca] Failed to cancel order:', error);
    throw new Error(`Alpaca API error: ${error.message}`);
  }
}

/**
 * Get latest stock/crypto quote
 * @param {ReturnType<typeof createAlpacaRest>} alpaca - Alpaca client
 * @param {string} symbol - Stock/crypto symbol
 * @returns {Promise<Object>} Latest quote
 */
export async function getLatestQuote(alpaca, symbol) {
  try {
    // Get latest quote (bid/ask prices)
    const quote = await alpaca.getLatestQuote(symbol);

    return {
      symbol,
      bid_price: quote.bp ? parseFloat(quote.bp) : null,
      bid_size: quote.bs || 0,
      ask_price: quote.ap ? parseFloat(quote.ap) : null,
      ask_size: quote.as || 0,
      timestamp: quote.t,
    };
  } catch (error) {
    console.error(`[Alpaca] Failed to get quote for ${symbol}:`, error);

    // Fallback to latest bar if quote fails
    try {
      const bar = await alpaca.getLatestBar(symbol);
      return {
        symbol,
        bid_price: parseFloat(bar.c),
        bid_size: 0,
        ask_price: parseFloat(bar.c),
        ask_size: 0,
        timestamp: bar.t,
      };
    } catch (barError) {
      throw new Error(`Alpaca API error: ${error.message}`);
    }
  }
}

/**
 * Get historical bars (for charts)
 * @param {ReturnType<typeof createAlpacaRest>} alpaca - Alpaca client
 * @param {string} symbol - Stock/crypto symbol
 * @param {string} timeframe - '1Min', '5Min', '15Min', '1Hour', '1Day'
 * @param {Object} options - { start, end, limit }
 * @returns {Promise<Array>} Historical bars
 */
export async function getHistoricalBars(alpaca, symbol, timeframe = '1Day', options = {}) {
  try {
    const { start, end, limit } = options;

    const params = {
      timeframe,
      limit: limit || 100,
    };

    if (start) params.start = start;
    if (end) params.end = end;

    const barsIterator = alpaca.getBarsV2(symbol, params);
    const bars = [];

    for await (const bar of barsIterator) {
      bars.push({
        timestamp: bar.Timestamp,
        open: parseFloat(bar.OpenPrice),
        high: parseFloat(bar.HighPrice),
        low: parseFloat(bar.LowPrice),
        close: parseFloat(bar.ClosePrice),
        volume: bar.Volume,
      });
    }

    return bars;
  } catch (error) {
    console.error(`[Alpaca] Failed to get historical bars for ${symbol}:`, error);
    throw new Error(`Alpaca API error: ${error.message}`);
  }
}

/**
 * Check if market is currently open
 * @param {ReturnType<typeof createAlpacaRest>} alpaca - Alpaca client
 * @returns {Promise<boolean>} True if market is open
 */
export async function isMarketOpen(alpaca) {
  try {
    const clock = await alpaca.getClock();
    return clock.is_open;
  } catch (error) {
    console.error('[Alpaca] Failed to check market hours:', error);
    return false; // Assume closed on error
  }
}

/**
 * Get market calendar
 * @param {ReturnType<typeof createAlpacaRest>} alpaca - Alpaca client
 * @param {Object} options - { start, end }
 * @returns {Promise<Array>} Market calendar
 */
export async function getMarketCalendar(alpaca, options = {}) {
  try {
    const calendar = await alpaca.getCalendar(options);
    return calendar.map(day => ({
      date: day.date,
      open: day.open,
      close: day.close,
    }));
  } catch (error) {
    console.error('[Alpaca] Failed to get market calendar:', error);
    throw new Error(`Alpaca API error: ${error.message}`);
  }
}

/**
 * WebSocket connection for real-time data
 * @param {string} apiKey - Alpaca API key
 * @param {string} apiSecret - Alpaca API secret
 * @param {Array<string>} symbols - Symbols to subscribe to
 * @param {Function} onUpdate - Callback for price updates
 * @returns {Object} WebSocket client with close() method
 */
export function createRealtimeConnection(apiKey, apiSecret, symbols, onUpdate) {
  try {
    // Paper keys read the same market data.
    const stream = createAlpacaRest({ keyId: apiKey, secretKey: apiSecret, paper: true, feed: 'iex' }).stream({
      symbols,
      onConnect: () => console.log('[Alpaca WebSocket] Connected'),
      onError: (error) => console.error('[Alpaca WebSocket] Error:', error),
      onTrade: (trade) => onUpdate({
        type: 'trade',
        symbol: trade.S,
        price: trade.p,
        size: trade.s,
        timestamp: trade.t,
      }),
      onQuote: (quote) => onUpdate({
        type: 'quote',
        symbol: quote.S,
        bid: quote.bp,
        ask: quote.ap,
        bid_size: quote.bs,
        ask_size: quote.as,
        timestamp: quote.t,
      }),
    });

    return {
      close: () => {
        stream.close();
        console.log('[Alpaca WebSocket] Disconnected');
      },
    };
  } catch (error) {
    console.error('[Alpaca] Failed to create WebSocket connection:', error);
    throw error;
  }
}

/**
 * Test API credentials
 * @param {string} apiKey - Alpaca API key
 * @param {string} apiSecret - Alpaca API secret
 * @param {string} mode - 'paper' or 'live'
 * @returns {Promise<Object>} Test result
 */
export async function testCredentials(apiKey, apiSecret, mode = 'paper') {
  try {
    const alpaca = createAlpacaClient(apiKey, apiSecret, mode);
    const account = await getAccountInfo(alpaca);

    return {
      success: true,
      account_id: account.id,
      status: account.status,
      mode,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Get news articles
 * @param {ReturnType<typeof createAlpacaRest>} alpaca - Alpaca client
 * @param {Object} options - { symbols?, start?, end?, limit?, sort?, include_content? }
 * @returns {Promise<Array>} News articles
 */
export async function getNews(alpaca, options = {}) {
  try {
    const { symbols, start, end, limit = 50, sort = 'desc', include_content = false } = options;

    const params = {
      limit,
      sort,
      include_content,
    };

    if (symbols && symbols.length > 0) {
      params.symbols = Array.isArray(symbols) ? symbols.join(',') : symbols;
    }

    if (start) params.start = start;
    if (end) params.end = end;

    const news = await alpaca.getNews(params);

    return news.map((article) => ({
      id: article.id || article.article_id,
      headline: article.headline,
      summary: article.summary || '',
      author: article.author || 'Benzinga',
      created_at: article.created_at,
      updated_at: article.updated_at,
      url: article.url,
      content: article.content || null,
      images: article.images || [],
      symbols: article.symbols || [],
      source: article.source || 'Benzinga',
    }));
  } catch (error) {
    console.error('[Alpaca] Failed to fetch news:', error);
    throw new Error(`Alpaca News API error: ${error.message}`);
  }
}

// ============================================================================
// OPTIONS TRADING FUNCTIONS
// ============================================================================

/**
 * Get options chain for a symbol
 * @param {ReturnType<typeof createAlpacaRest>} alpaca - Alpaca client
 * @param {string} symbol - Underlying symbol (e.g., 'AAPL')
 * @param {Object} options - { expirationDate?, strikePrice?, optionType? }
 * @returns {Promise<Array>} Options chain data
 */
export async function getOptionsChain(alpaca, symbol, options = {}) {
  try {
    // NOTE: Alpaca's options API requires special approval
    // API endpoint: GET /v2/options/contracts
    // Reference: https://alpaca.markets/docs/api-references/trading-api/options-trading/

    const params = {
      underlying_symbols: symbol,
      status: 'active', // Only active contracts
    };

    if (options.expirationDate) {
      params.expiration_date = options.expirationDate;
    }

    if (options.strikePrice) {
      params.strike_price_gte = options.strikePrice * 0.9; // 10% below
      params.strike_price_lte = options.strikePrice * 1.1; // 10% above
    }

    if (options.optionType) {
      params.type = options.optionType; // 'call' or 'put'
    }

    const response = await alpaca.request({
      method: 'GET',
      url: '/v2/options/contracts',
      params,
    });

    // Alpaca answers { option_contracts: [...], next_page_token }.
    const contracts = response?.option_contracts || response?.data || response || [];

    return contracts.map((contract) => ({
      option_symbol: contract.symbol,
      underlying_symbol: contract.underlying_symbol || symbol,
      expiration_date: contract.expiration_date,
      strike_price: parseFloat(contract.strike_price),
      option_type: contract.type, // 'call' or 'put'
      size: contract.size || 100, // Contracts usually represent 100 shares
      open_interest: contract.open_interest || 0,
      // Latest quote (if available)
      bid: contract.latest_quote?.bid_price || null,
      ask: contract.latest_quote?.ask_price || null,
      last_price: contract.latest_trade?.price || null,
      // Greeks (if provided by Alpaca)
      greeks: contract.greeks || null,
      implied_volatility: contract.implied_volatility || null,
    }));
  } catch (error) {
    console.error('[Alpaca] Failed to fetch options chain:', error);

    // If options trading not enabled, return helpful error
    if (error.message.includes('403') || error.message.includes('not approved')) {
      throw new Error(
        'Options trading not enabled. Please apply for approval at https://alpaca.markets/support'
      );
    }

    throw new Error(`Alpaca Options API error: ${error.message}`);
  }
}

/**
 * Get option contract details (quote + greeks)
 * @param {ReturnType<typeof createAlpacaRest>} alpaca - Alpaca client
 * @param {string} optionSymbol - Full option symbol (e.g., 'AAPL230120C00150000')
 * @returns {Promise<Object>} Option contract details with quote and greeks
 */
export async function getOptionContract(alpaca, optionSymbol) {
  try {
    // API endpoint: GET /v2/options/snapshots/{symbol}
    const response = await alpaca.request({
      method: 'GET',
      url: `/v2/options/snapshots/${optionSymbol}`,
    });

    const snapshot = response.data || response;

    return {
      option_symbol: optionSymbol,
      // Latest quote
      bid: snapshot.latestQuote?.bid_price || null,
      ask: snapshot.latestQuote?.ask_price || null,
      bid_size: snapshot.latestQuote?.bid_size || null,
      ask_size: snapshot.latestQuote?.ask_size || null,
      // Latest trade
      last_price: snapshot.latestTrade?.price || null,
      last_size: snapshot.latestTrade?.size || null,
      // Greeks (if available)
      greeks: snapshot.greeks || null,
      implied_volatility: snapshot.implied_volatility || null,
      // Volume and Open Interest
      volume: snapshot.dailyBar?.volume || 0,
      open_interest: snapshot.open_interest || 0,
    };
  } catch (error) {
    console.error('[Alpaca] Failed to fetch option contract:', error);
    throw new Error(`Alpaca Options API error: ${error.message}`);
  }
}

/**
 * Place an options order
 * @param {ReturnType<typeof createAlpacaRest>} alpaca - Alpaca client
 * @param {Object} orderParams - { optionSymbol, qty, side, orderType, limitPrice?, timeInForce? }
 * @returns {Promise<Object>} Order confirmation
 */
export async function placeOptionsOrder(alpaca, orderParams) {
  try {
    const {
      optionSymbol,
      qty,
      side, // 'buy_to_open', 'buy_to_close', 'sell_to_open', 'sell_to_close'
      orderType = 'market',
      limitPrice,
      timeInForce = 'day',
    } = orderParams;

    // Validate required fields
    if (!optionSymbol || !qty || !side) {
      throw new Error('Missing required fields: optionSymbol, qty, side');
    }

    const order = {
      symbol: optionSymbol,
      qty: parseInt(qty),
      side: side, // For options: buy_to_open, sell_to_close, etc.
      type: orderType,
      time_in_force: timeInForce,
    };

    if (orderType === 'limit' && limitPrice) {
      order.limit_price = parseFloat(limitPrice);
    }

    const response = await alpaca.createOrder(order);

    return {
      id: response.id,
      option_symbol: response.symbol,
      qty: parseInt(response.qty),
      side: response.side,
      type: response.type,
      status: response.status,
      filled_qty: parseInt(response.filled_qty || 0),
      filled_avg_price: parseFloat(response.filled_avg_price || 0),
      created_at: response.created_at,
    };
  } catch (error) {
    console.error('[Alpaca] Failed to place options order:', error);
    throw new Error(`Alpaca Options Order error: ${error.message}`);
  }
}

/**
 * Get options positions
 * @param {ReturnType<typeof createAlpacaRest>} alpaca - Alpaca client
 * @returns {Promise<Array>} List of options positions
 */
export async function getOptionsPositions(alpaca) {
  try {
    // Get all positions and filter for options (asset_class = 'us_option')
    const allPositions = await alpaca.getPositions();

    const optionsPositions = allPositions.filter(
      (pos) => pos.asset_class === 'us_option'
    );

    return optionsPositions.map((pos) => ({
      option_symbol: pos.symbol,
      underlying_symbol: pos.underlying_symbol || null,
      qty: parseFloat(pos.qty),
      avg_entry_price: parseFloat(pos.avg_entry_price),
      current_price: parseFloat(pos.current_price),
      market_value: parseFloat(pos.market_value),
      cost_basis: parseFloat(pos.cost_basis || pos.avg_entry_price * pos.qty),
      unrealized_pl: parseFloat(pos.unrealized_pl),
      unrealized_plpc: parseFloat(pos.unrealized_plpc),
      side: pos.side, // 'long' or 'short'
    }));
  } catch (error) {
    console.error('[Alpaca] Failed to get options positions:', error);
    throw new Error(`Alpaca API error: ${error.message}`);
  }
}

/**
 * Calculate Black-Scholes Greeks (fallback if Alpaca doesn't provide them)
 * @param {Object} params - { underlyingPrice, strikePrice, timeToExpiry, volatility, riskFreeRate, optionType }
 * @returns {Object} Greeks: { delta, gamma, theta, vega, rho }
 */
export function calculateGreeks(params) {
  const {
    underlyingPrice,
    strikePrice,
    timeToExpiry, // In years (e.g., 30 days = 30/365)
    volatility, // Annual volatility (e.g., 0.25 for 25%)
    riskFreeRate = 0.05, // Default 5% annual risk-free rate
    optionType = 'call', // 'call' or 'put'
  } = params;

  // Validate inputs
  if (!underlyingPrice || !strikePrice || !timeToExpiry || !volatility) {
    return null;
  }

  // Standard normal CDF (approximation)
  function normalCDF(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp((-x * x) / 2);
    const prob =
      d *
      t *
      (0.3193815 +
        t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - prob : prob;
  }

  // Standard normal PDF
  function normalPDF(x) {
    return Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
  }

  // Calculate d1 and d2
  const d1 =
    (Math.log(underlyingPrice / strikePrice) +
      (riskFreeRate + (volatility * volatility) / 2) * timeToExpiry) /
    (volatility * Math.sqrt(timeToExpiry));

  const d2 = d1 - volatility * Math.sqrt(timeToExpiry);

  // Calculate Greeks
  let delta, gamma, theta, vega, rho;

  if (optionType === 'call') {
    // Call option Greeks
    delta = normalCDF(d1);
    theta =
      ((-underlyingPrice * normalPDF(d1) * volatility) / (2 * Math.sqrt(timeToExpiry)) -
        riskFreeRate * strikePrice * Math.exp(-riskFreeRate * timeToExpiry) * normalCDF(d2)) /
      365; // Daily theta
    rho =
      (strikePrice * timeToExpiry * Math.exp(-riskFreeRate * timeToExpiry) * normalCDF(d2)) / 100;
  } else {
    // Put option Greeks
    delta = normalCDF(d1) - 1;
    theta =
      ((-underlyingPrice * normalPDF(d1) * volatility) / (2 * Math.sqrt(timeToExpiry)) +
        riskFreeRate * strikePrice * Math.exp(-riskFreeRate * timeToExpiry) * normalCDF(-d2)) /
      365; // Daily theta
    rho =
      (-strikePrice * timeToExpiry * Math.exp(-riskFreeRate * timeToExpiry) * normalCDF(-d2)) /
      100;
  }

  // Gamma and Vega are the same for calls and puts
  gamma = normalPDF(d1) / (underlyingPrice * volatility * Math.sqrt(timeToExpiry));
  vega = (underlyingPrice * normalPDF(d1) * Math.sqrt(timeToExpiry)) / 100;

  return {
    delta: parseFloat(delta.toFixed(4)),
    gamma: parseFloat(gamma.toFixed(4)),
    theta: parseFloat(theta.toFixed(4)), // Daily theta
    vega: parseFloat(vega.toFixed(4)), // Per 1% change in IV
    rho: parseFloat(rho.toFixed(4)), // Per 1% change in interest rate
  };
}

/**
 * Get list of available expiration dates for a symbol
 * @param {ReturnType<typeof createAlpacaRest>} alpaca - Alpaca client
 * @param {string} symbol - Underlying symbol
 * @returns {Promise<Array>} Array of expiration dates (ISO format)
 */
export async function getExpirationDates(alpaca, symbol) {
  try {
    // Fetch options chain without filtering by expiration
    const chain = await getOptionsChain(alpaca, symbol);

    // Extract unique expiration dates
    const expirations = [...new Set(chain.map((contract) => contract.expiration_date))];

    // Sort chronologically
    expirations.sort();

    return expirations;
  } catch (error) {
    console.error('[Alpaca] Failed to fetch expiration dates:', error);
    throw new Error(`Alpaca API error: ${error.message}`);
  }
}
