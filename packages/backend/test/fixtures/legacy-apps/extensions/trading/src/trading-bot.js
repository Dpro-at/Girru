/**
 * Trading Extension - AI Trading Bot Engine
 *
 * Executes trading strategies and generates signals
 *
 * Supported Strategies:
 * 1. Moving Average Crossover (ma_crossover) - Buy when short MA crosses above long MA
 * 2. RSI Trading (rsi) - Buy oversold, sell overbought
 * 3. Breakout Strategy (breakout) - Buy on price breakouts above resistance
 * 4. AI-Powered Analysis (ai_powered) - Claude AI technical analysis
 *
 * Execution Modes:
 * - manual: Show signals only (user reviews)
 * - semi_auto: Generate signal + require user approval
 * - full_auto: Generate signal + execute immediately
 */

import {
  createAlpacaClient,
  getHistoricalBars,
  getLatestQuote,
  placeOrder,
  getPositions,
} from './alpaca-client.js';
import { randomBytes } from 'crypto';

let strategyInterval = null;
let apiRef = null;

/**
 * Start strategy runner service
 * @param {ExtensionApi} api - Extension API
 */
export function startStrategyRunner(api) {
  apiRef = api;

  // Run immediately on startup
  runActiveStrategies();

  // Then run every 1 minute (60000ms)
  strategyInterval = setInterval(() => {
    runActiveStrategies();
  }, 60000);

  api.log('info', '✅ Strategy runner service started (1 minute interval)');
}

/**
 * Stop strategy runner service
 */
export function stopStrategyRunner() {
  if (strategyInterval) {
    clearInterval(strategyInterval);
    strategyInterval = null;
    if (apiRef) {
      apiRef.log('info', 'Strategy runner service stopped');
    }
  }
}

/**
 * Run all active strategies
 */
async function runActiveStrategies() {
  if (!apiRef) return;

  const api = apiRef;
  const db = api.db;
  const credentialManager = api.credentialManager;

  try {
    // Get all active strategies
    const strategies = db
      .prepare(
        `
      SELECT
        s.*,
        a.api_key_credential_id, a.api_secret_credential_id, a.account_mode, a.user_id
      FROM trading_strategies s
      JOIN trading_accounts a ON s.trading_account_id = a.id
      WHERE s.status = 'active' AND a.is_active = 1
    `
      )
      .all();

    if (strategies.length === 0) {
      return; // No active strategies
    }

    api.log('info', `🤖 Running ${strategies.length} active strateg(ies)...`);

    let signalsGenerated = 0;
    let ordersPlaced = 0;

    // Execute each strategy
    for (const strategy of strategies) {
      try {
        // Parse JSON fields
        strategy.symbols = JSON.parse(strategy.symbols || '[]');
        strategy.config = JSON.parse(strategy.config || '{}');

        // Decrypt credentials
        const apiKey = await credentialManager.getValue(strategy.api_key_credential_id);
        const apiSecret = await credentialManager.getValue(
          strategy.api_secret_credential_id
        );

        // Create Alpaca client
        const alpaca = createAlpacaClient(apiKey, apiSecret, strategy.account_mode);

        // Execute strategy for each symbol
        for (const symbol of strategy.symbols) {
          const result = await executeStrategy(api, db, alpaca, strategy, symbol);

          if (result.signal) {
            signalsGenerated++;
          }

          if (result.order) {
            ordersPlaced++;
          }
        }

        // Update last_run_at
        db.prepare('UPDATE trading_strategies SET last_run_at = ? WHERE id = ?').run(
          new Date().toISOString(),
          strategy.id
        );
      } catch (error) {
        api.log('error', `Strategy ${strategy.strategy_name} failed: ${error.message}`);
      }
    }

    if (signalsGenerated > 0 || ordersPlaced > 0) {
      api.log(
        'info',
        `✅ Strategy run complete: ${signalsGenerated} signals, ${ordersPlaced} orders`
      );
    }
  } catch (error) {
    api.log('error', `Strategy runner error: ${error.message}`);
  }
}

/**
 * Execute single strategy for a symbol
 * @param {ExtensionApi} api - Extension API
 * @param {Database} db - Database instance
 * @param {Alpaca} alpaca - Alpaca client
 * @param {Object} strategy - Strategy record
 * @param {string} symbol - Symbol to analyze
 * @returns {Promise<Object>} Result with signal and/or order
 */
async function executeStrategy(api, db, alpaca, strategy, symbol) {
  try {
    // Get current quote
    const quote = await getLatestQuote(alpaca, symbol);
    const currentPrice = quote.price;

    let signal = null;

    // Execute based on strategy type
    switch (strategy.strategy_type) {
      case 'ma_crossover':
        signal = await executeMAStrategy(alpaca, strategy, symbol, currentPrice);
        break;

      case 'rsi':
        signal = await executeRSIStrategy(alpaca, strategy, symbol, currentPrice);
        break;

      case 'breakout':
        signal = await executeBreakoutStrategy(alpaca, strategy, symbol, currentPrice);
        break;

      case 'ai_powered':
        signal = await executeAIPoweredStrategy(
          api,
          alpaca,
          strategy,
          symbol,
          currentPrice
        );
        break;

      default:
        api.log('warn', `Unknown strategy type: ${strategy.strategy_type}`);
        return { signal: null, order: null };
    }

    if (!signal) {
      return { signal: null, order: null }; // No signal generated
    }

    // Apply risk management
    signal = applyRiskManagement(strategy, signal, currentPrice);

    // Check daily trade limit
    const todayTrades = db
      .prepare(
        `
      SELECT COUNT(*) as count
      FROM trading_orders
      WHERE strategy_id = ? AND DATE(created_at) = DATE('now')
    `
      )
      .get(strategy.id).count;

    if (todayTrades >= strategy.max_daily_trades) {
      api.log(
        'warn',
        `Strategy ${strategy.strategy_name} hit daily trade limit (${strategy.max_daily_trades})`
      );
      return { signal: null, order: null };
    }

    // Save signal to database
    const signalId = randomBytes(16).toString('hex');
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(); // 4 hours

    db.prepare(
      `
      INSERT INTO trading_signals (
        id, strategy_id, trading_account_id, symbol, asset_class, signal_type,
        current_price, target_price, stop_loss_price, confidence, reason,
        analysis_data, recommended_qty, recommended_order_type, status,
        requires_approval, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      signalId,
      strategy.id,
      strategy.trading_account_id,
      symbol,
      signal.asset_class || 'us_equity',
      signal.signal_type,
      currentPrice,
      signal.target_price || null,
      signal.stop_loss_price || null,
      signal.confidence,
      signal.reason,
      JSON.stringify(signal.analysis_data || {}),
      signal.recommended_qty,
      signal.recommended_order_type || 'market',
      strategy.execution_mode === 'full_auto' ? 'pending' : 'pending',
      strategy.execution_mode !== 'full_auto' ? 1 : 0,
      now,
      expiresAt
    );

    api.log(
      'info',
      `📊 Signal: ${signal.signal_type.toUpperCase()} ${symbol} @ $${currentPrice.toFixed(2)} (${strategy.strategy_name})`
    );

    // If full_auto mode, execute immediately
    if (strategy.execution_mode === 'full_auto') {
      try {
        const order = await placeOrder(alpaca, {
          symbol,
          qty: signal.recommended_qty,
          side: signal.signal_type === 'buy' ? 'buy' : 'sell',
          order_type: signal.recommended_order_type || 'market',
        });

        // Save order
        const orderId = randomBytes(16).toString('hex');

        db.prepare(
          `
          INSERT INTO trading_orders (
            id, trading_account_id, alpaca_order_id, symbol, asset_class, qty, side,
            order_type, time_in_force, status, placed_by, strategy_id,
            submitted_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'day', ?, 'strategy', ?, ?, ?, ?)
        `
        ).run(
          orderId,
          strategy.trading_account_id,
          order.id,
          order.symbol,
          order.asset_class,
          order.qty,
          order.side,
          order.order_type,
          order.status,
          strategy.id,
          order.submitted_at,
          now,
          now
        );

        // Update signal status
        db.prepare(
          `
          UPDATE trading_signals
          SET status = 'executed', order_id = ?, executed_price = ?,
              executed_qty = ?, executed_at = ?
          WHERE id = ?
        `
        ).run(orderId, currentPrice, signal.recommended_qty, now, signalId);

        // Update strategy stats
        db.prepare(
          'UPDATE trading_strategies SET total_trades = total_trades + 1 WHERE id = ?'
        ).run(strategy.id);

        api.log(
          'info',
          `✅ Auto-executed: ${order.side.toUpperCase()} ${order.qty} ${order.symbol} @ ${order.order_type}`
        );

        return { signal: signalId, order: orderId };
      } catch (error) {
        api.log('error', `Failed to auto-execute signal: ${error.message}`);

        // Mark signal as failed
        db.prepare(
          'UPDATE trading_signals SET status = ?, execution_error = ? WHERE id = ?'
        ).run('failed', error.message, signalId);

        return { signal: signalId, order: null };
      }
    }

    return { signal: signalId, order: null };
  } catch (error) {
    api.log('error', `Failed to execute strategy for ${symbol}: ${error.message}`);
    return { signal: null, order: null };
  }
}

// ============================================================================
// STRATEGY IMPLEMENTATIONS
// ============================================================================

/**
 * Moving Average Crossover Strategy
 * Buy when short MA crosses above long MA, sell when crosses below
 */
async function executeMAStrategy(alpaca, strategy, symbol, currentPrice) {
  const config = strategy.config;
  const shortPeriod = config.ma_short || 50;
  const longPeriod = config.ma_long || 200;

  // Get historical data
  const bars = await getHistoricalBars(alpaca, symbol, '1Day', {
    limit: longPeriod + 10,
  });

  if (bars.length < longPeriod) {
    return null; // Not enough data
  }

  // Calculate moving averages
  const shortMA = calculateSMA(
    bars.slice(-shortPeriod).map((b) => b.close),
    shortPeriod
  );
  const longMA = calculateSMA(
    bars.slice(-longPeriod).map((b) => b.close),
    longPeriod
  );

  // Previous values (for crossover detection)
  const prevShortMA = calculateSMA(
    bars.slice(-shortPeriod - 1, -1).map((b) => b.close),
    shortPeriod
  );
  const prevLongMA = calculateSMA(
    bars.slice(-longPeriod - 1, -1).map((b) => b.close),
    longPeriod
  );

  // Detect crossover
  let signalType = null;
  let reason = '';

  if (prevShortMA <= prevLongMA && shortMA > longMA) {
    // Golden Cross - bullish signal
    signalType = 'buy';
    reason = `Golden Cross detected: MA(${shortPeriod}) crossed above MA(${longPeriod})`;
  } else if (prevShortMA >= prevLongMA && shortMA < longMA) {
    // Death Cross - bearish signal
    signalType = 'sell';
    reason = `Death Cross detected: MA(${shortPeriod}) crossed below MA(${longPeriod})`;
  }

  if (!signalType) {
    return null; // No signal
  }

  return {
    signal_type: signalType,
    confidence: 0.7,
    reason,
    analysis_data: {
      short_ma: shortMA,
      long_ma: longMA,
      prev_short_ma: prevShortMA,
      prev_long_ma: prevLongMA,
    },
    recommended_qty: 10,
    recommended_order_type: 'market',
  };
}

/**
 * RSI Trading Strategy
 * Buy when RSI < oversold level (30), sell when RSI > overbought level (70)
 */
async function executeRSIStrategy(alpaca, strategy, symbol, currentPrice) {
  const config = strategy.config;
  const period = config.period || 14;
  const oversold = config.oversold || 30;
  const overbought = config.overbought || 70;

  // Get historical data
  const bars = await getHistoricalBars(alpaca, symbol, '1Day', { limit: period + 10 });

  if (bars.length < period + 1) {
    return null; // Not enough data
  }

  // Calculate RSI
  const rsi = calculateRSI(
    bars.map((b) => b.close),
    period
  );

  let signalType = null;
  let reason = '';

  if (rsi < oversold) {
    signalType = 'buy';
    reason = `RSI oversold at ${rsi.toFixed(2)} (< ${oversold})`;
  } else if (rsi > overbought) {
    signalType = 'sell';
    reason = `RSI overbought at ${rsi.toFixed(2)} (> ${overbought})`;
  }

  if (!signalType) {
    return null; // No signal
  }

  return {
    signal_type: signalType,
    confidence: 0.65,
    reason,
    analysis_data: { rsi, period, oversold, overbought },
    recommended_qty: 10,
    recommended_order_type: 'market',
  };
}

/**
 * Breakout Strategy
 * Buy when price breaks above resistance (52-week high)
 */
async function executeBreakoutStrategy(alpaca, strategy, symbol, currentPrice) {
  const config = strategy.config;
  const lookback = config.lookback || 252; // 1 year of trading days

  // Get historical data
  const bars = await getHistoricalBars(alpaca, symbol, '1Day', { limit: lookback });

  if (bars.length < lookback) {
    return null; // Not enough data
  }

  // Find resistance (highest high)
  const resistance = Math.max(...bars.map((b) => b.high));

  // Find support (lowest low)
  const support = Math.min(...bars.map((b) => b.low));

  let signalType = null;
  let reason = '';

  // Breakout above resistance
  if (currentPrice > resistance * 1.01) {
    // 1% above resistance
    signalType = 'buy';
    reason = `Breakout above resistance: $${currentPrice.toFixed(2)} > $${resistance.toFixed(2)}`;
  }
  // Breakdown below support
  else if (currentPrice < support * 0.99) {
    // 1% below support
    signalType = 'sell';
    reason = `Breakdown below support: $${currentPrice.toFixed(2)} < $${support.toFixed(2)}`;
  }

  if (!signalType) {
    return null; // No signal
  }

  return {
    signal_type: signalType,
    confidence: 0.6,
    reason,
    analysis_data: { resistance, support, lookback },
    recommended_qty: 10,
    recommended_order_type: 'market',
  };
}

/**
 * AI-Powered Strategy
 * Use Claude AI for technical analysis
 */
async function executeAIPoweredStrategy(api, alpaca, strategy, symbol, currentPrice) {
  try {
    // Get historical data for context
    const bars = await getHistoricalBars(alpaca, symbol, '1Day', { limit: 30 });

    // Calculate basic indicators
    const sma20 = calculateSMA(
      bars.slice(-20).map((b) => b.close),
      20
    );
    const sma50 = calculateSMA(
      bars.slice(-50).map((b) => b.close),
      50
    );
    const rsi = calculateRSI(
      bars.map((b) => b.close),
      14
    );

    // Prepare data for AI
    const recentBars = bars.slice(-10);
    const priceData = recentBars.map((b) => ({
      date: b.timestamp,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));

    // Call Claude AI (simplified - in production, use proper LLM API)
    // For now, use rule-based logic as placeholder
    const analysis = {
      trend: sma20 > sma50 ? 'bullish' : 'bearish',
      momentum: rsi > 50 ? 'positive' : 'negative',
      rsi,
      sma20,
      sma50,
      currentPrice,
    };

    let signalType = null;
    let reason = '';
    let confidence = 0.5;

    // Simple AI logic (replace with actual LLM in production)
    if (analysis.trend === 'bullish' && analysis.momentum === 'positive' && rsi < 70) {
      signalType = 'buy';
      reason = `AI Analysis: Bullish trend with positive momentum (RSI: ${rsi.toFixed(2)})`;
      confidence = 0.75;
    } else if (
      analysis.trend === 'bearish' &&
      analysis.momentum === 'negative' &&
      rsi > 30
    ) {
      signalType = 'sell';
      reason = `AI Analysis: Bearish trend with negative momentum (RSI: ${rsi.toFixed(2)})`;
      confidence = 0.7;
    }

    if (!signalType) {
      return null; // No signal
    }

    return {
      signal_type: signalType,
      confidence,
      reason,
      analysis_data: analysis,
      recommended_qty: 10,
      recommended_order_type: 'market',
    };
  } catch (error) {
    api.log('error', `AI strategy failed for ${symbol}: ${error.message}`);
    return null;
  }
}

// ============================================================================
// TECHNICAL INDICATORS
// ============================================================================

/**
 * Calculate Simple Moving Average
 */
function calculateSMA(prices, period) {
  if (prices.length < period) return 0;
  const slice = prices.slice(-period);
  return slice.reduce((sum, p) => sum + p, 0) / period;
}

/**
 * Calculate RSI (Relative Strength Index)
 */
function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;

  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  const gains = changes.map((c) => (c > 0 ? c : 0));
  const losses = changes.map((c) => (c < 0 ? Math.abs(c) : 0));

  const avgGain = gains.slice(-period).reduce((sum, g) => sum + g, 0) / period;
  const avgLoss = losses.slice(-period).reduce((sum, l) => sum + l, 0) / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ============================================================================
// RISK MANAGEMENT
// ============================================================================

/**
 * Apply risk management rules to signal
 */
function applyRiskManagement(strategy, signal, currentPrice) {
  // Calculate stop loss price
  if (strategy.stop_loss_percent && signal.signal_type === 'buy') {
    signal.stop_loss_price = currentPrice * (1 - strategy.stop_loss_percent / 100);
  }

  // Calculate take profit price
  if (strategy.take_profit_percent && signal.signal_type === 'buy') {
    signal.target_price = currentPrice * (1 + strategy.take_profit_percent / 100);
  }

  // Adjust quantity based on max_position_size
  if (strategy.max_position_size) {
    const maxQty = Math.floor(strategy.max_position_size / currentPrice);
    if (signal.recommended_qty > maxQty) {
      signal.recommended_qty = maxQty;
    }
  }

  return signal;
}
