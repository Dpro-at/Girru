/**
 * AI Trading Tools
 *
 * Two tools for AI agents:
 * 1. trading_execute - Execute trades, view portfolio, manage orders
 * 2. trading_analyze - Analyze stocks/crypto and provide recommendations
 */

import { internalAuthHeaders } from '../../../../../../extensions/shared/internal-auth.js';

/**
 * Trading Execute Tool
 * Allows AI agents to interact with user's trading account
 */
export const tradingExecuteTool = {
  name: 'trading_execute',
  description: 'Execute stock and crypto trading operations: view portfolio, get quotes, place orders (buy/sell), check positions, view order history, manage watchlist. Works with user\'s connected trading account.',

  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'get_portfolio',
          'get_positions',
          'get_quote',
          'get_bars',
          'place_order',
          'get_orders',
          'cancel_order',
          'get_watchlist',
          'add_to_watchlist',
          'remove_from_watchlist'
        ],
        description: 'Trading action to perform',
      },
      symbol: {
        type: 'string',
        description: 'Stock/crypto ticker symbol (e.g., AAPL, TSLA, BTCUSD, ETHUSD)',
      },
      qty: {
        type: 'number',
        description: 'Number of shares/units (required for place_order)',
      },
      side: {
        type: 'string',
        enum: ['buy', 'sell'],
        description: 'Order side (required for place_order)',
      },
      order_type: {
        type: 'string',
        enum: ['market', 'limit', 'stop', 'stop_limit'],
        description: 'Order type (default: market)',
      },
      limit_price: {
        type: 'number',
        description: 'Limit price for limit orders',
      },
      stop_price: {
        type: 'number',
        description: 'Stop price for stop orders',
      },
      time_in_force: {
        type: 'string',
        enum: ['day', 'gtc', 'ioc', 'fok'],
        description: 'Time in force (default: day)',
      },
      order_id: {
        type: 'string',
        description: 'Order ID to cancel (required for cancel_order)',
      },
      timeframe: {
        type: 'string',
        enum: ['1Min', '5Min', '15Min', '1Hour', '1Day'],
        description: 'Timeframe for historical bars (default: 1Day)',
      },
      limit: {
        type: 'number',
        description: 'Number of bars to return (default: 30)',
      },
    },
    required: ['action'],
  },

  async execute(params, context) {
    const { action, symbol, qty, side, order_type, limit_price, stop_price, time_in_force, order_id, timeframe, limit } = params;
    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || '41522'}`;

    // Get user ID from context
    const userId = context?.userId || context?.user?.id;

    try {
      switch (action) {
        case 'get_portfolio': {
          const response = await fetch(`${backendUrl}/api/ext/trading/portfolio`, {
            headers: {
              ...internalAuthHeaders(userId),
            },
          });

          if (!response.ok) {
            throw new Error(`Failed to fetch portfolio: ${response.statusText}`);
          }

          const data = await response.json();

          return {
            content: [{
              type: 'text',
              text: `# Portfolio Overview\n\n` +
                    `**Cash**: $${data.cash?.toFixed(2) || '0.00'}\n` +
                    `**Portfolio Value**: $${data.portfolio_value?.toFixed(2) || '0.00'}\n` +
                    `**Equity**: $${data.equity?.toFixed(2) || '0.00'}\n` +
                    `**Buying Power**: $${data.buying_power?.toFixed(2) || '0.00'}\n` +
                    `**P&L**: $${data.profit_loss?.toFixed(2) || '0.00'} (${data.profit_loss_percent?.toFixed(2) || '0.00'}%)\n` +
                    `\n*Account Mode*: ${data.account_mode === 'paper' ? '📝 Paper Trading' : '💰 Live Trading'}`
            }],
          };
        }

        case 'get_positions': {
          const response = await fetch(`${backendUrl}/api/ext/trading/positions`, {
            headers: {
              ...internalAuthHeaders(userId),
            },
          });

          if (!response.ok) {
            throw new Error(`Failed to fetch positions: ${response.statusText}`);
          }

          const positions = await response.json();

          if (!positions || positions.length === 0) {
            return { content: [{ type: 'text', text: 'No open positions.' }] };
          }

          const positionsText = positions.map(pos =>
            `**${pos.symbol}** (${pos.asset_class}): ${pos.qty} @ $${pos.avg_entry_price.toFixed(2)} | ` +
            `Current: $${pos.current_price.toFixed(2)} | ` +
            `P&L: ${pos.unrealized_pl >= 0 ? '+' : ''}$${pos.unrealized_pl.toFixed(2)} (${pos.unrealized_plpc >= 0 ? '+' : ''}${pos.unrealized_plpc.toFixed(2)}%)`
          ).join('\n');

          return {
            content: [{
              type: 'text',
              text: `# Current Positions\n\n${positionsText}`
            }],
          };
        }

        case 'get_quote': {
          if (!symbol) {
            throw new Error('Symbol is required for get_quote');
          }

          const response = await fetch(`${backendUrl}/api/ext/trading/quote/${symbol}`, {
            headers: {
              ...internalAuthHeaders(userId),
            },
          });

          if (!response.ok) {
            throw new Error(`Failed to fetch quote: ${response.statusText}`);
          }

          const quote = await response.json();

          return {
            content: [{
              type: 'text',
              text: `# ${quote.symbol} Quote\n\n` +
                    `**Price**: $${quote.price.toFixed(2)}\n` +
                    `**High**: $${quote.high.toFixed(2)}\n` +
                    `**Low**: $${quote.low.toFixed(2)}\n` +
                    `**Open**: $${quote.open.toFixed(2)}\n` +
                    `**Volume**: ${quote.volume.toLocaleString()}\n`
            }],
          };
        }

        case 'get_bars': {
          if (!symbol) {
            throw new Error('Symbol is required for get_bars');
          }

          const response = await fetch(
            `${backendUrl}/api/ext/trading/bars/${symbol}?timeframe=${timeframe || '1Day'}&limit=${limit || 30}`,
            {
              headers: {
                ...internalAuthHeaders(userId),
              },
            }
          );

          if (!response.ok) {
            throw new Error(`Failed to fetch bars: ${response.statusText}`);
          }

          const bars = await response.json();

          if (!bars || bars.length === 0) {
            return { content: [{ type: 'text', text: `No historical data available for ${symbol}.` }] };
          }

          const barsText = bars.slice(0, 5).map(bar =>
            `${bar.timestamp}: O $${bar.open.toFixed(2)} | H $${bar.high.toFixed(2)} | L $${bar.low.toFixed(2)} | C $${bar.close.toFixed(2)}`
          ).join('\n');

          return {
            content: [{
              type: 'text',
              text: `# ${symbol} Historical Data (${timeframe || '1Day'})\n\n` +
                    `${bars.length} bars retrieved. Recent data:\n\n${barsText}\n\n` +
                    `*(Showing first 5 of ${bars.length} bars)*`
            }],
          };
        }

        case 'place_order': {
          if (!symbol || !qty || !side) {
            throw new Error('Symbol, qty, and side are required for place_order');
          }

          const response = await fetch(`${backendUrl}/api/ext/trading/orders`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...internalAuthHeaders(userId),
            },
            body: JSON.stringify({
              symbol,
              qty,
              side,
              order_type: order_type || 'market',
              limit_price,
              stop_price,
              time_in_force: time_in_force || 'day',
              placed_by: 'agent',
            }),
          });

          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to place order');
          }

          const order = await response.json();

          return {
            content: [{
              type: 'text',
              text: `# Order Placed ✅\n\n` +
                    `**Order ID**: ${order.id}\n` +
                    `**Symbol**: ${order.symbol}\n` +
                    `**Side**: ${order.side.toUpperCase()}\n` +
                    `**Quantity**: ${order.qty} shares\n` +
                    `**Type**: ${order.order_type}\n` +
                    `**Status**: ${order.status}\n` +
                    `\n*Submitted at: ${order.submitted_at}*`
            }],
          };
        }

        case 'get_orders': {
          const response = await fetch(`${backendUrl}/api/ext/trading/orders?limit=10`, {
            headers: {
              ...internalAuthHeaders(userId),
            },
          });

          if (!response.ok) {
            throw new Error(`Failed to fetch orders: ${response.statusText}`);
          }

          const orders = await response.json();

          if (!orders || orders.length === 0) {
            return { content: [{ type: 'text', text: 'No recent orders.' }] };
          }

          const ordersText = orders.map(order =>
            `**${order.symbol}** - ${order.side.toUpperCase()} ${order.qty} @ ${order.order_type} - Status: ${order.status}`
          ).join('\n');

          return {
            content: [{
              type: 'text',
              text: `# Recent Orders\n\n${ordersText}`
            }],
          };
        }

        case 'cancel_order': {
          if (!order_id) {
            throw new Error('Order ID is required for cancel_order');
          }

          const response = await fetch(`${backendUrl}/api/ext/trading/orders/${order_id}`, {
            method: 'DELETE',
            headers: {
              ...internalAuthHeaders(userId),
            },
          });

          if (!response.ok) {
            throw new Error(`Failed to cancel order: ${response.statusText}`);
          }

          return {
            content: [{
              type: 'text',
              text: `✅ Order ${order_id} has been canceled.`
            }],
          };
        }

        case 'get_watchlist': {
          const response = await fetch(`${backendUrl}/api/ext/trading/watchlist`, {
            headers: {
              ...internalAuthHeaders(userId),
            },
          });

          if (!response.ok) {
            throw new Error(`Failed to fetch watchlist: ${response.statusText}`);
          }

          const watchlist = await response.json();

          if (!watchlist || watchlist.length === 0) {
            return { content: [{ type: 'text', text: 'Watchlist is empty.' }] };
          }

          const watchlistText = watchlist.map(item =>
            `**${item.symbol}** (${item.asset_class}) - ${item.name || 'N/A'}`
          ).join('\n');

          return {
            content: [{
              type: 'text',
              text: `# Watchlist\n\n${watchlistText}`
            }],
          };
        }

        case 'add_to_watchlist': {
          if (!symbol) {
            throw new Error('Symbol is required for add_to_watchlist');
          }

          const response = await fetch(`${backendUrl}/api/ext/trading/watchlist`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...internalAuthHeaders(userId),
            },
            body: JSON.stringify({ symbol }),
          });

          if (!response.ok) {
            throw new Error(`Failed to add to watchlist: ${response.statusText}`);
          }

          return {
            content: [{
              type: 'text',
              text: `✅ ${symbol} added to watchlist.`
            }],
          };
        }

        case 'remove_from_watchlist': {
          if (!symbol) {
            throw new Error('Symbol is required for remove_from_watchlist');
          }

          const response = await fetch(`${backendUrl}/api/ext/trading/watchlist/${symbol}`, {
            method: 'DELETE',
            headers: {
              ...internalAuthHeaders(userId),
            },
          });

          if (!response.ok) {
            throw new Error(`Failed to remove from watchlist: ${response.statusText}`);
          }

          return {
            content: [{
              type: 'text',
              text: `✅ ${symbol} removed from watchlist.`
            }],
          };
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ Error: ${error.message}`
        }],
        isError: true,
      };
    }
  },
};

/**
 * Trading Analyze Tool
 * Provides AI-powered market analysis and recommendations
 */
export const tradingAnalyzeTool = {
  name: 'trading_analyze',
  description: 'Analyze stocks or crypto and provide AI-powered trading recommendations based on technical indicators, price trends, and market conditions.',

  input_schema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Stock/crypto ticker symbol to analyze (e.g., AAPL, BTCUSD)',
      },
      timeframe: {
        type: 'string',
        enum: ['1Day', '1Hour', '15Min'],
        description: 'Analysis timeframe (default: 1Day)',
      },
      analysis_type: {
        type: 'string',
        enum: ['technical', 'trend', 'quick'],
        description: 'Type of analysis to perform (default: technical)',
      },
    },
    required: ['symbol'],
  },

  async execute(params, context) {
    const { symbol, timeframe, analysis_type } = params;
    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || '41522'}`;
    const userId = context?.userId || context?.user?.id;

    try {
      // Fetch current quote
      const quoteResponse = await fetch(`${backendUrl}/api/ext/trading/quote/${symbol}`, {
        headers: internalAuthHeaders(userId),
      });

      if (!quoteResponse.ok) {
        throw new Error(`Symbol not found: ${symbol}`);
      }

      const quote = await quoteResponse.json();

      // Fetch historical data
      const barsResponse = await fetch(
        `${backendUrl}/api/ext/trading/bars/${symbol}?timeframe=${timeframe || '1Day'}&limit=50`,
        {
          headers: internalAuthHeaders(userId),
        }
      );

      if (!barsResponse.ok) {
        throw new Error(`Failed to fetch historical data for ${symbol}`);
      }

      const bars = await barsResponse.json();

      // Perform analysis
      const analysis = performAnalysis(quote, bars, analysis_type || 'technical');

      return {
        content: [{
          type: 'text',
          text: analysis,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ Analysis failed: ${error.message}`,
        }],
        isError: true,
      };
    }
  },
};

/**
 * Perform technical analysis on stock/crypto data
 * @private
 */
function performAnalysis(quote, bars, analysisType) {
  const currentPrice = quote.price;
  const symbol = quote.symbol;

  // Calculate simple indicators
  const prices = bars.map(b => b.close);
  const recentPrices = prices.slice(-20); // Last 20 periods

  const sma20 = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
  const sma50 = prices.slice(-50).reduce((a, b) => a + b, 0) / Math.min(50, prices.length);

  const priceChange = ((currentPrice - prices[0]) / prices[0]) * 100;
  const volatility = calculateVolatility(recentPrices);

  // Trend detection
  const trend = currentPrice > sma20 ? 'bullish' : 'bearish';
  const momentum = currentPrice > sma20 && sma20 > sma50 ? 'strong' : 'weak';

  // Generate recommendation
  let recommendation = 'HOLD';
  let confidence = 0.5;
  let reasoning = '';

  if (currentPrice > sma20 && sma20 > sma50) {
    recommendation = 'BUY';
    confidence = 0.75;
    reasoning = 'Price above both moving averages, showing strong upward trend.';
  } else if (currentPrice < sma20 && sma20 < sma50) {
    recommendation = 'SELL';
    confidence = 0.70;
    reasoning = 'Price below both moving averages, showing weak downward trend.';
  } else {
    reasoning = 'Mixed signals. Price consolidating between moving averages.';
  }

  // Format analysis report
  return `# Technical Analysis: ${symbol}\n\n` +
         `## Current Status\n` +
         `- **Price**: $${currentPrice.toFixed(2)}\n` +
         `- **Change**: ${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%\n` +
         `- **Trend**: ${trend.toUpperCase()}\n` +
         `- **Momentum**: ${momentum.toUpperCase()}\n\n` +
         `## Technical Indicators\n` +
         `- **SMA(20)**: $${sma20.toFixed(2)}\n` +
         `- **SMA(50)**: $${sma50.toFixed(2)}\n` +
         `- **Volatility**: ${volatility.toFixed(2)}%\n\n` +
         `## Recommendation\n` +
         `**${recommendation}** (Confidence: ${(confidence * 100).toFixed(0)}%)\n\n` +
         `*Reasoning*: ${reasoning}\n\n` +
         `---\n` +
         `*Note: This is AI-generated analysis for informational purposes only. Not financial advice.*`;
}

/**
 * Calculate price volatility (standard deviation)
 * @private
 */
function calculateVolatility(prices) {
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / prices.length;
  const stdDev = Math.sqrt(variance);
  return (stdDev / mean) * 100; // As percentage
}
