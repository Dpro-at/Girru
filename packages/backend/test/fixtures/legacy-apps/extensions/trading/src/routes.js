/**
 * Trading Extension - API Routes
 *
 * 25 endpoints covering:
 * - Account Management (5 routes)
 * - Portfolio & Positions (3 routes)
 * - Orders (3 routes)
 * - Market Data (2 routes)
 * - Watchlist (3 routes)
 * - Strategies (5 routes)
 * - Signals (3 routes)
 * - Activity Log (1 route)
 */

import {
  createAlpacaClient,
  getAccountInfo,
  getPositions,
  getOrders,
  placeOrder,
  cancelOrder,
  getLatestQuote,
  getHistoricalBars,
  testCredentials,
  createRealtimeConnection,
  getNews,
  // Options Trading Functions
  getOptionsChain,
  getOptionContract,
  placeOptionsOrder,
  getOptionsPositions,
  calculateGreeks,
  getExpirationDates,
} from './alpaca-client.js';
import { randomBytes } from 'crypto';
import { getCredentialManager } from '../../../../../../src/credentials/index.js';

/**
 * User of this request, as verified by the extension route guard (S0-Q.18).
 * Never taken from a client header; there is no fallback user.
 * @param {FastifyRequest} request
 * @returns {string} User ID
 */
function getUserId(request) {
  const userId = request.authUserId;
  if (!userId) {
    const error = new Error('Authentication required');
    error.statusCode = 401;
    throw error;
  }
  return userId;
}

/**
 * Register all trading routes
 * @param {FastifyInstance} fastify - Fastify instance
 */
/** Origins allowed to read the SSE stream: the same list as the core CORS config. */
function streamAllowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || 'http://localhost:41521')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o && o !== '*');
}

export async function registerTradingRoutes(fastify) {
  const db = fastify.db;
  const credentialManager = getCredentialManager();

  // ============================================================================
  // ACCOUNT MANAGEMENT
  // ============================================================================

  /**
   * GET /api/ext/trading/accounts
   * List user's trading accounts
   */
  fastify.get('/accounts', async (request, reply) => {
    try {
      const userId = getUserId(request);

      const accounts = db
        .prepare(
          `
        SELECT
          id, user_id, platform, account_name, account_mode,
          is_active, is_default, alpaca_account_id, account_status,
          account_blocked, trade_suspended_by_user, allow_autonomous_trading,
          created_at, updated_at, last_synced_at
        FROM trading_accounts
        WHERE user_id = ?
        ORDER BY is_default DESC, created_at DESC
      `
        )
        .all(userId);

      return reply.send({ accounts });
    } catch (error) {
      console.error('[Trading]', `Failed to fetch accounts: ${error.message}`);
      return reply.send({ error: 'Failed to fetch accounts' }, 500);
    }
  });

  /**
   * POST /api/ext/trading/accounts
   * Connect new trading account
   * Body: { platform, account_name, account_mode, api_key, api_secret }
   */
  fastify.post('/accounts', async (request, reply) => {
    try {
      const userId = getUserId(request);
      console.log('[Trading DEBUG] userId:', userId, 'type:', typeof userId);
      const { platform, account_name, account_mode, api_key, api_secret } =
        request.body;

      // Validate inputs
      if (!platform || !account_name || !account_mode || !api_key || !api_secret) {
        return reply.send({ error: 'Missing required fields' }, 400);
      }

      if (!['paper', 'live'].includes(account_mode)) {
        return reply.send({ error: 'Invalid account_mode (must be paper or live)' }, 400);
      }

      // Test credentials first
      console.log('[Trading]', `Testing ${platform} credentials for ${account_name}...`);
      const testResult = await testCredentials(api_key, api_secret, account_mode);

      if (!testResult.success) {
        return reply.send({ error: `Invalid credentials: ${testResult.error}` }, 400);
      }

      // Encrypt API credentials
      console.log('[Trading DEBUG] About to encrypt - api_key:', api_key ? 'EXISTS' : 'UNDEFINED', 'api_secret:', api_secret ? 'EXISTS' : 'UNDEFINED');
      const { id: keyCredentialId } = await credentialManager.create({
        userId,
        name: `${platform}_api_key_${Date.now()}`,
        value: api_key,
        type: 'trading_api_key'
      });

      const { id: secretCredentialId } = await credentialManager.create({
        userId,
        name: `${platform}_api_secret_${Date.now()}`,
        value: api_secret,
        type: 'trading_api_secret'
      });

      // Insert account
      const accountId = randomBytes(16).toString('hex');
      const now = new Date().toISOString();

      // Check if this is the user's first account (make it default)
      const existingAccountsCount = db.prepare('SELECT COUNT(*) as count FROM trading_accounts WHERE user_id = ?').get(userId).count;
      const isDefault = existingAccountsCount === 0 ? 1 : 0;

      db.prepare(
        `
        INSERT INTO trading_accounts (
          id, user_id, platform, account_name, account_mode,
          api_key_credential_id, api_secret_credential_id,
          is_active, is_default, alpaca_account_id, account_status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      `
      ).run(
        accountId,
        userId,
        platform,
        account_name,
        account_mode,
        keyCredentialId,
        secretCredentialId,
        isDefault,
        testResult.account_id,
        testResult.status,
        now,
        now
      );

      console.log('[Trading]', `✅ Trading account connected: ${account_name} (${account_mode})`);

      return reply.send({
        success: true,
        account: {
          id: accountId,
          platform,
          account_name,
          account_mode,
          alpaca_account_id: testResult.account_id,
          status: testResult.status,
        },
      });
    } catch (error) {
      console.error('[Trading]', `Failed to connect account: ${error.message}`);
      return reply.send({ error: 'Failed to connect account' }, 500);
    }
  });

  /**
   * POST /api/ext/trading/accounts/:id/activate
   * Set account as active (default)
   */
  fastify.post('/accounts/:id/activate', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const accountId = request.params('id');

      // Verify ownership
      const account = db
        .prepare('SELECT id FROM trading_accounts WHERE id = ? AND user_id = ?')
        .get(accountId, userId);

      if (!account) {
        return reply.send({ error: 'Account not found' }, 404);
      }

      // Deactivate all other accounts
      db.prepare('UPDATE trading_accounts SET is_default = 0 WHERE user_id = ?').run(
        userId
      );

      // Activate this account
      db.prepare('UPDATE trading_accounts SET is_default = 1, is_active = 1 WHERE id = ?').run(
        accountId
      );

      console.log('[Trading]', `Account activated: ${accountId}`);

      return reply.send({ success: true });
    } catch (error) {
      console.error('[Trading]', `Failed to activate account: ${error.message}`);
      return reply.send({ error: 'Failed to activate account' }, 500);
    }
  });

  /**
   * PUT /api/ext/trading/accounts/:id
   * Update account settings
   * Body: { account_name?, allow_autonomous_trading? }
   */
  fastify.put('/accounts/:id', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const accountId = request.params('id');
      const { account_name, allow_autonomous_trading } = request.body;

      // Verify ownership
      const account = db
        .prepare('SELECT id FROM trading_accounts WHERE id = ? AND user_id = ?')
        .get(accountId, userId);

      if (!account) {
        return reply.send({ error: 'Account not found' }, 404);
      }

      const updates = [];
      const params = [];

      if (account_name !== undefined) {
        updates.push('account_name = ?');
        params.push(account_name);
      }

      if (allow_autonomous_trading !== undefined) {
        updates.push('allow_autonomous_trading = ?');
        params.push(allow_autonomous_trading ? 1 : 0);
      }

      if (updates.length === 0) {
        return reply.send({ error: 'No fields to update' }, 400);
      }

      updates.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(accountId);

      db.prepare(
        `UPDATE trading_accounts SET ${updates.join(', ')} WHERE id = ?`
      ).run(...params);

      console.log('[Trading]', `Account updated: ${accountId}`);

      return reply.send({ success: true });
    } catch (error) {
      console.error('[Trading]', `Failed to update account: ${error.message}`);
      return reply.send({ error: 'Failed to update account' }, 500);
    }
  });

  /**
   * DELETE /api/ext/trading/accounts/:id
   * Remove trading account
   */
  fastify.delete('/accounts/:id', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const accountId = request.params('id');

      // Verify ownership
      const account = db
        .prepare(
          'SELECT api_key_credential_id, api_secret_credential_id FROM trading_accounts WHERE id = ? AND user_id = ?'
        )
        .get(accountId, userId);

      if (!account) {
        return reply.send({ error: 'Account not found' }, 404);
      }

      // Delete credentials
      await credentialManager.delete(account.api_key_credential_id);
      await credentialManager.delete(account.api_secret_credential_id);

      // Delete account (cascade will delete positions, orders, etc.)
      db.prepare('DELETE FROM trading_accounts WHERE id = ?').run(accountId);

      console.log('[Trading]', `Account deleted: ${accountId}`);

      return reply.send({ success: true });
    } catch (error) {
      console.error('[Trading]', `Failed to delete account: ${error.message}`);
      return reply.send({ error: 'Failed to delete account' }, 500);
    }
  });

  // ============================================================================
  // PORTFOLIO & POSITIONS
  // ============================================================================

  /**
   * GET /api/ext/trading/portfolio
   * Get current portfolio snapshot
   */
  fastify.get('/portfolio', async (request, reply) => {
    try {
      const userId = getUserId(request);

      // Get active account
      const account = db
        .prepare(
          `
        SELECT id, platform, account_mode, api_key_credential_id, api_secret_credential_id
        FROM trading_accounts
        WHERE user_id = ? AND is_default = 1 AND is_active = 1
        LIMIT 1
      `
        )
        .get(userId);

      if (!account) {
        return reply.send({ error: 'No active trading account found' }, 404);
      }

      // Decrypt credentials
      const apiKey = await credentialManager.getValue(account.api_key_credential_id);
      const apiSecret = await credentialManager.getValue(account.api_secret_credential_id);

      // Fetch from Alpaca
      const alpaca = createAlpacaClient(apiKey, apiSecret, account.account_mode);
      const accountInfo = await getAccountInfo(alpaca);

      // Save snapshot
      const snapshotId = randomBytes(16).toString('hex');
      db.prepare(
        `
        INSERT INTO trading_portfolio_snapshots (
          id, trading_account_id, cash, portfolio_value, equity, buying_power,
          snapshot_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        snapshotId,
        account.id,
        accountInfo.cash,
        accountInfo.portfolio_value,
        accountInfo.equity,
        accountInfo.buying_power,
        new Date().toISOString()
      );

      return reply.send({ portfolio: accountInfo, account_id: account.id });
    } catch (error) {
      console.error('[Trading]', `Failed to fetch portfolio: ${error.message}`);
      return reply.send({ error: 'Failed to fetch portfolio' }, 500);
    }
  });

  /**
   * GET /api/ext/trading/positions
   * Get current holdings
   */
  fastify.get('/positions', async (request, reply) => {
    try {
      const userId = getUserId(request);

      // Get active account
      const account = db
        .prepare(
          `
        SELECT id, platform, account_mode, api_key_credential_id, api_secret_credential_id
        FROM trading_accounts
        WHERE user_id = ? AND is_default = 1 AND is_active = 1
        LIMIT 1
      `
        )
        .get(userId);

      if (!account) {
        return reply.send({ error: 'No active trading account found' }, 404);
      }

      // Decrypt credentials
      const apiKey = await credentialManager.getValue(account.api_key_credential_id);
      const apiSecret = await credentialManager.getValue(account.api_secret_credential_id);

      // Fetch from Alpaca
      const alpaca = createAlpacaClient(apiKey, apiSecret, account.account_mode);
      const positions = await getPositions(alpaca);

      return reply.send({ positions, account_id: account.id });
    } catch (error) {
      console.error('[Trading]', `Failed to fetch positions: ${error.message}`);
      return reply.send({ error: 'Failed to fetch positions' }, 500);
    }
  });

  /**
   * GET /api/ext/trading/portfolio/snapshots
   * Get portfolio historical snapshots for analytics
   * Query params: days=90 (number of days to look back)
   */
  fastify.get('/portfolio/snapshots', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const days = parseInt(request.query('days') || '90', 10);

      // Get active account
      const account = db
        .prepare(
          `
        SELECT id
        FROM trading_accounts
        WHERE user_id = ? AND is_default = 1 AND is_active = 1
        LIMIT 1
      `
        )
        .get(userId);

      if (!account) {
        return reply.send({ error: 'No active trading account found' }, 404);
      }

      // Calculate date threshold
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);
      const cutoffISO = cutoffDate.toISOString();

      // Fetch snapshots
      const snapshots = db
        .prepare(
          `
        SELECT
          id, trading_account_id, cash, portfolio_value, equity, buying_power, snapshot_at as created_at
        FROM trading_portfolio_snapshots
        WHERE trading_account_id = ? AND snapshot_at >= ?
        ORDER BY snapshot_at ASC
      `
        )
        .all(account.id, cutoffISO);

      return reply.send({ snapshots, account_id: account.id, days });
    } catch (error) {
      console.error('[Trading]', `Failed to fetch portfolio snapshots: ${error.message}`);
      return reply.send({ error: 'Failed to fetch portfolio snapshots' }, 500);
    }
  });

  /**
   * POST /api/ext/trading/sync
   * Manually sync portfolio data
   */
  fastify.post('/sync', async (request, reply) => {
    try {
      const userId = getUserId(request);

      // Get active account
      const account = db
        .prepare(
          `
        SELECT id, platform, account_mode, api_key_credential_id, api_secret_credential_id
        FROM trading_accounts
        WHERE user_id = ? AND is_default = 1 AND is_active = 1
        LIMIT 1
      `
        )
        .get(userId);

      if (!account) {
        return reply.send({ error: 'No active trading account found' }, 404);
      }

      // Decrypt credentials
      const apiKey = await credentialManager.getValue(account.api_key_credential_id);
      const apiSecret = await credentialManager.getValue(account.api_secret_credential_id);

      // Fetch from Alpaca
      const alpaca = createAlpacaClient(apiKey, apiSecret, account.account_mode);
      const accountInfo = await getAccountInfo(alpaca);
      const positions = await getPositions(alpaca);

      // Save portfolio snapshot
      const snapshotId = randomBytes(16).toString('hex');
      const now = new Date().toISOString();

      db.prepare(
        `
        INSERT INTO trading_portfolio_snapshots (
          id, trading_account_id, cash, portfolio_value, equity, buying_power,
          snapshot_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        snapshotId,
        account.id,
        accountInfo.cash,
        accountInfo.portfolio_value,
        accountInfo.equity,
        accountInfo.buying_power,
        now
      );

      // Clear old positions
      db.prepare('DELETE FROM trading_positions WHERE trading_account_id = ?').run(
        account.id
      );

      // Insert new positions
      for (const pos of positions) {
        const posId = randomBytes(16).toString('hex');
        db.prepare(
          `
          INSERT INTO trading_positions (
            id, trading_account_id, symbol, asset_class, qty, avg_entry_price,
            current_price, market_value, unrealized_pl, unrealized_plpc, side, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
          posId,
          account.id,
          pos.symbol,
          pos.asset_class,
          pos.qty,
          pos.avg_entry_price,
          pos.current_price,
          pos.market_value,
          pos.unrealized_pl,
          pos.unrealized_plpc,
          pos.side,
          now
        );
      }

      // Update last_synced_at
      db.prepare(
        'UPDATE trading_accounts SET last_synced_at = ? WHERE id = ?'
      ).run(now, account.id);

      console.log('[Trading]', `Portfolio synced: ${account.id}`);

      return reply.send({ success: true, synced_at: now });
    } catch (error) {
      console.error('[Trading]', `Failed to sync portfolio: ${error.message}`);
      return reply.send({ error: 'Failed to sync portfolio' }, 500);
    }
  });

  // ============================================================================
  // ORDERS
  // ============================================================================

  /**
   * GET /api/ext/trading/orders
   * Get order history
   * Query params: status=all|open|closed, limit=50
   */
  fastify.get('/orders', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const status = request.query('status') || 'all';
      const limit = parseInt(request.query('limit') || '50', 10);

      // Get active account
      const account = db
        .prepare(
          `
        SELECT id, platform, account_mode, api_key_credential_id, api_secret_credential_id
        FROM trading_accounts
        WHERE user_id = ? AND is_default = 1 AND is_active = 1
        LIMIT 1
      `
        )
        .get(userId);

      if (!account) {
        return reply.send({ error: 'No active trading account found' }, 404);
      }

      // Decrypt credentials
      const apiKey = await credentialManager.getValue(account.api_key_credential_id);
      const apiSecret = await credentialManager.getValue(account.api_secret_credential_id);

      // Fetch from Alpaca
      const alpaca = createAlpacaClient(apiKey, apiSecret, account.account_mode);
      const orders = await getOrders(alpaca, status, limit);

      return reply.send({ orders, account_id: account.id });
    } catch (error) {
      console.error('[Trading]', `Failed to fetch orders: ${error.message}`);
      return reply.send({ error: 'Failed to fetch orders' }, 500);
    }
  });

  /**
   * POST /api/ext/trading/orders
   * Place new order
   * Body: { symbol, qty, side, order_type?, time_in_force?, limit_price?, stop_price?, placed_by? }
   */
  fastify.post('/orders', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const {
        symbol,
        qty,
        side,
        order_type = 'market',
        time_in_force = 'day',
        limit_price,
        stop_price,
        placed_by = 'user',
      } = request.body;

      // Validate inputs
      if (!symbol || !qty || !side) {
        return reply.send({ error: 'Missing required fields: symbol, qty, side' }, 400);
      }

      if (!['buy', 'sell'].includes(side)) {
        return reply.send({ error: 'Invalid side (must be buy or sell)' }, 400);
      }

      if (qty <= 0) {
        return reply.send({ error: 'Quantity must be greater than 0' }, 400);
      }

      // Get active account
      const account = db
        .prepare(
          `
        SELECT id, platform, account_mode, api_key_credential_id, api_secret_credential_id
        FROM trading_accounts
        WHERE user_id = ? AND is_default = 1 AND is_active = 1
        LIMIT 1
      `
        )
        .get(userId);

      if (!account) {
        return reply.send({ error: 'No active trading account found' }, 404);
      }

      // Decrypt credentials
      const apiKey = await credentialManager.getValue(account.api_key_credential_id);
      const apiSecret = await credentialManager.getValue(account.api_secret_credential_id);

      // Place order via Alpaca
      const alpaca = createAlpacaClient(apiKey, apiSecret, account.account_mode);
      const order = await placeOrder(alpaca, {
        symbol,
        qty,
        side,
        order_type,
        time_in_force,
        limit_price,
        stop_price,
      });

      // Save to database
      const orderId = randomBytes(16).toString('hex');
      const now = new Date().toISOString();

      db.prepare(
        `
        INSERT INTO trading_orders (
          id, trading_account_id, alpaca_order_id, symbol, asset_class, qty, side,
          order_type, time_in_force, limit_price, stop_price, status, placed_by,
          submitted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        orderId,
        account.id,
        order.id,
        order.symbol,
        order.asset_class,
        order.qty,
        order.side,
        order.order_type,
        time_in_force,
        limit_price || null,
        stop_price || null,
        order.status,
        placed_by,
        order.submitted_at,
        now,
        now
      );

      // Log activity
      const activityId = randomBytes(16).toString('hex');
      db.prepare(
        `
        INSERT INTO trading_activity_log (
          id, trading_account_id, action, details, triggered_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `
      ).run(
        activityId,
        account.id,
        'order_placed',
        JSON.stringify({ symbol, qty, side, order_type, order_id: order.id }),
        placed_by,
        now
      );

      api.log(
        'info',
        `Order placed: ${side.toUpperCase()} ${qty} ${symbol} @ ${order_type} (${account.account_mode})`
      );

      return reply.send({ success: true, order });
    } catch (error) {
      console.error('[Trading]', `Failed to place order: ${error.message}`);
      return reply.send({ error: `Failed to place order: ${error.message}` }, 500);
    }
  });

  /**
   * DELETE /api/ext/trading/orders/:orderId
   * Cancel pending order
   */
  fastify.delete('/orders/:orderId', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const orderId = request.params('orderId');

      // Get order
      const order = db
        .prepare(
          `
        SELECT o.alpaca_order_id, o.trading_account_id, a.api_key_credential_id, a.api_secret_credential_id, a.account_mode
        FROM trading_orders o
        JOIN trading_accounts a ON o.trading_account_id = a.id
        WHERE o.id = ? AND a.user_id = ?
      `
        )
        .get(orderId, userId);

      if (!order) {
        return reply.send({ error: 'Order not found' }, 404);
      }

      // Decrypt credentials
      const apiKey = await credentialManager.getValue(order.api_key_credential_id);
      const apiSecret = await credentialManager.getValue(order.api_secret_credential_id);

      // Cancel via Alpaca
      const alpaca = createAlpacaClient(apiKey, apiSecret, order.account_mode);
      await cancelOrder(alpaca, order.alpaca_order_id);

      // Update database
      const now = new Date().toISOString();
      db.prepare(
        `
        UPDATE trading_orders
        SET status = 'canceled', canceled_at = ?, updated_at = ?
        WHERE id = ?
      `
      ).run(now, now, orderId);

      console.log('[Trading]', `Order canceled: ${orderId}`);

      return reply.send({ success: true });
    } catch (error) {
      console.error('[Trading]', `Failed to cancel order: ${error.message}`);
      return reply.send({ error: 'Failed to cancel order' }, 500);
    }
  });

  // ============================================================================
  // MARKET DATA
  // ============================================================================

  /**
   * GET /api/ext/trading/quote/:symbol
   * Get real-time stock quote
   */
  fastify.get('/quote/:symbol', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const symbol = request.params('symbol');

      // Get active account
      const account = db
        .prepare(
          `
        SELECT id, platform, account_mode, api_key_credential_id, api_secret_credential_id
        FROM trading_accounts
        WHERE user_id = ? AND is_default = 1 AND is_active = 1
        LIMIT 1
      `
        )
        .get(userId);

      if (!account) {
        return reply.send({ error: 'No active trading account found' }, 404);
      }

      // Decrypt credentials
      const apiKey = await credentialManager.getValue(account.api_key_credential_id);
      const apiSecret = await credentialManager.getValue(account.api_secret_credential_id);

      // Fetch from Alpaca
      const alpaca = createAlpacaClient(apiKey, apiSecret, account.account_mode);
      const quote = await getLatestQuote(alpaca, symbol);

      return reply.send({ quote });
    } catch (error) {
      console.error('[Trading]', `Failed to fetch quote: ${error.message}`);
      return reply.send({ error: 'Failed to fetch quote' }, 500);
    }
  });

  /**
   * GET /api/ext/trading/bars/:symbol
   * Get historical price data for charts
   * Query params: timeframe=1Day, limit=100, start?, end?
   */
  fastify.get('/bars/:symbol', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const symbol = request.params('symbol');
      const timeframe = request.query('timeframe') || '1Day';
      const limit = parseInt(request.query('limit') || '100', 10);
      const start = request.query('start');
      const end = request.query('end');

      // Get active account
      const account = db
        .prepare(
          `
        SELECT id, platform, account_mode, api_key_credential_id, api_secret_credential_id
        FROM trading_accounts
        WHERE user_id = ? AND is_default = 1 AND is_active = 1
        LIMIT 1
      `
        )
        .get(userId);

      if (!account) {
        return reply.send({ error: 'No active trading account found' }, 404);
      }

      // Decrypt credentials
      const apiKey = await credentialManager.getValue(account.api_key_credential_id);
      const apiSecret = await credentialManager.getValue(account.api_secret_credential_id);

      // Fetch from Alpaca
      const alpaca = createAlpacaClient(apiKey, apiSecret, account.account_mode);
      const bars = await getHistoricalBars(alpaca, symbol, timeframe, {
        start,
        end,
        limit,
      });

      return reply.send({ bars, symbol, timeframe });
    } catch (error) {
      console.error('[Trading]', `Failed to fetch bars: ${error.message}`);
      return reply.send({ error: 'Failed to fetch bars' }, 500);
    }
  });

  /**
   * GET /api/ext/trading/assets/search
   * Search for stocks by symbol or name
   * Query params: query (search term)
   */
  fastify.get('/assets/search', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const query = request.query.query || '';

      if (!query || query.length < 1) {
        return reply.send({ assets: [] });
      }

      // Get active account
      const account = db
        .prepare(
          `
        SELECT id, platform, account_mode, api_key_credential_id, api_secret_credential_id
        FROM trading_accounts
        WHERE user_id = ? AND is_default = 1 AND is_active = 1
        LIMIT 1
      `
        )
        .get(userId);

      if (!account) {
        return reply.send({ error: 'No active trading account found' }, 404);
      }

      // Decrypt credentials
      const apiKey = await credentialManager.getValue(account.api_key_credential_id);
      const apiSecret = await credentialManager.getValue(account.api_secret_credential_id);

      // Create Alpaca client
      const alpaca = createAlpacaClient(apiKey, apiSecret, account.account_mode);

      // Search assets via Alpaca API
      // GET /v2/assets?status=active&asset_class=us_equity
      const searchQuery = query.toUpperCase();
      const assets = await alpaca.getAssets({
        status: 'active',
        asset_class: 'us_equity,crypto',
      });

      // Filter results by symbol or name
      const filtered = assets
        .filter((asset) => {
          const symbolMatch = asset.symbol.includes(searchQuery);
          const nameMatch = asset.name?.toUpperCase().includes(searchQuery);
          return symbolMatch || nameMatch;
        })
        .slice(0, 10); // Limit to 10 results

      return reply.send({
        assets: filtered.map((asset) => ({
          id: asset.id,
          symbol: asset.symbol,
          name: asset.name,
          exchange: asset.exchange,
          asset_class: asset.class,
          tradable: asset.tradable,
          marginable: asset.marginable,
        }))
      });
    } catch (error) {
      console.error('[Trading]', `Failed to search assets: ${error.message}`);
      return reply.send({ error: 'Failed to search assets' }, 500);
    }
  });

  // ============================================================================
  // WATCHLIST
  // ============================================================================

  /**
   * GET /api/ext/trading/watchlist
   * Get user's watchlist
   */
  fastify.get('/watchlist', async (request, reply) => {
    try {
      const userId = getUserId(request);

      const watchlist = db
        .prepare(
          `
        SELECT id, symbol, asset_class, name, notes, display_order, created_at
        FROM trading_watchlist
        WHERE user_id = ?
        ORDER BY display_order ASC, created_at DESC
      `
        )
        .all(userId);

      return reply.send({ watchlist });
    } catch (error) {
      console.error('[Trading]', `Failed to fetch watchlist: ${error.message}`);
      return reply.send({ error: 'Failed to fetch watchlist' }, 500);
    }
  });

  /**
   * POST /api/ext/trading/watchlist
   * Add symbol to watchlist
   * Body: { symbol, asset_class?, name?, notes? }
   */
  fastify.post('/watchlist', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { symbol, asset_class = 'us_equity', name, notes } = request.body;

      if (!symbol) {
        return reply.send({ error: 'Symbol is required' }, 400);
      }

      // Check if already exists
      const existing = db
        .prepare('SELECT id FROM trading_watchlist WHERE user_id = ? AND symbol = ?')
        .get(userId, symbol);

      if (existing) {
        return reply.send({ error: 'Symbol already in watchlist' }, 400);
      }

      // Insert
      const id = randomBytes(16).toString('hex');
      const now = new Date().toISOString();

      db.prepare(
        `
        INSERT INTO trading_watchlist (
          id, user_id, symbol, asset_class, name, notes, display_order, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      `
      ).run(id, userId, symbol, asset_class, name || null, notes || null, now);

      console.log('[Trading]', `Added to watchlist: ${symbol}`);

      return reply.send({ success: true, id });
    } catch (error) {
      console.error('[Trading]', `Failed to add to watchlist: ${error.message}`);
      return reply.send({ error: 'Failed to add to watchlist' }, 500);
    }
  });

  /**
   * DELETE /api/ext/trading/watchlist/:symbol
   * Remove from watchlist
   */
  fastify.delete('/watchlist/:symbol', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const symbol = request.params('symbol');

      db.prepare('DELETE FROM trading_watchlist WHERE user_id = ? AND symbol = ?').run(
        userId,
        symbol
      );

      console.log('[Trading]', `Removed from watchlist: ${symbol}`);

      return reply.send({ success: true });
    } catch (error) {
      console.error('[Trading]', `Failed to remove from watchlist: ${error.message}`);
      return reply.send({ error: 'Failed to remove from watchlist' }, 500);
    }
  });

  // ============================================================================
  // WATCHLIST GROUPS (Multiple Watchlists)
  // ============================================================================

  /**
   * GET /api/ext/trading/watchlist/groups
   * Get all watchlist groups for user
   */
  fastify.get('/watchlist/groups', async (request, reply) => {
    try {
      const userId = getUserId(request);

      const groups = db
        .prepare(
          `
        SELECT id, name, description, color, icon, display_order, is_default, created_at
        FROM trading_watchlist_groups
        WHERE user_id = ?
        ORDER BY display_order ASC, created_at DESC
      `
        )
        .all(userId);

      // If no groups exist, create default one
      if (groups.length === 0) {
        const defaultId = randomBytes(16).toString('hex');
        const now = new Date().toISOString();

        db.prepare(
          `
          INSERT INTO trading_watchlist_groups (
            id, user_id, name, description, color, display_order, is_default, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
          defaultId,
          userId,
          'My Watchlist',
          'Default watchlist',
          '#3B82F6',
          0,
          1,
          now
        );

        return reply.send({
          groups: [
            {
              id: defaultId,
              name: 'My Watchlist',
              description: 'Default watchlist',
              color: '#3B82F6',
              icon: null,
              display_order: 0,
              is_default: 1,
              created_at: now
            }
          ]
        });
      }

      return reply.send({ groups });
    } catch (error) {
      console.error('[Trading]', `Failed to fetch watchlist groups: ${error.message}`);
      return reply.send({ error: 'Failed to fetch watchlist groups' }, 500);
    }
  });

  /**
   * POST /api/ext/trading/watchlist/groups
   * Create new watchlist group
   * Body: { name, description?, color?, icon? }
   */
  fastify.post('/watchlist/groups', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { name, description, color = '#3B82F6', icon } = request.body;

      if (!name || name.trim().length === 0) {
        return reply.send({ error: 'Watchlist name is required' }, 400);
      }

      const id = randomBytes(16).toString('hex');
      const now = new Date().toISOString();

      // Get max display_order
      const maxOrder = db
        .prepare('SELECT MAX(display_order) as max FROM trading_watchlist_groups WHERE user_id = ?')
        .get(userId);

      const displayOrder = (maxOrder?.max || 0) + 1;

      db.prepare(
        `
        INSERT INTO trading_watchlist_groups (
          id, user_id, name, description, color, icon, display_order, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(id, userId, name.trim(), description || null, color, icon || null, displayOrder, now);

      console.log('[Trading]', `Created watchlist group: ${name}`);

      return reply.send({
        success: true,
        group: {
          id,
          name: name.trim(),
          description,
          color,
          icon,
          display_order: displayOrder,
          is_default: 0,
          created_at: now
        }
      });
    } catch (error) {
      console.error('[Trading]', `Failed to create watchlist group: ${error.message}`);
      return reply.send({ error: 'Failed to create watchlist group' }, 500);
    }
  });

  /**
   * PUT /api/ext/trading/watchlist/groups/:id
   * Update watchlist group
   * Body: { name?, description?, color?, icon? }
   */
  fastify.put('/watchlist/groups/:id', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const groupId = request.params('id');
      const { name, description, color, icon } = request.body;

      // Check ownership
      const group = db
        .prepare('SELECT id FROM trading_watchlist_groups WHERE id = ? AND user_id = ?')
        .get(groupId, userId);

      if (!group) {
        return reply.send({ error: 'Watchlist group not found' }, 404);
      }

      const updates = [];
      const params = [];

      if (name !== undefined) {
        updates.push('name = ?');
        params.push(name.trim());
      }
      if (description !== undefined) {
        updates.push('description = ?');
        params.push(description);
      }
      if (color !== undefined) {
        updates.push('color = ?');
        params.push(color);
      }
      if (icon !== undefined) {
        updates.push('icon = ?');
        params.push(icon);
      }

      if (updates.length === 0) {
        return reply.send({ error: 'No fields to update' }, 400);
      }

      updates.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(groupId, userId);

      db.prepare(
        `UPDATE trading_watchlist_groups SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`
      ).run(...params);

      console.log('[Trading]', `Updated watchlist group: ${groupId}`);

      return reply.send({ success: true });
    } catch (error) {
      console.error('[Trading]', `Failed to update watchlist group: ${error.message}`);
      return reply.send({ error: 'Failed to update watchlist group' }, 500);
    }
  });

  /**
   * DELETE /api/ext/trading/watchlist/groups/:id
   * Delete watchlist group (and move items to default watchlist)
   */
  fastify.delete('/watchlist/groups/:id', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const groupId = request.params('id');

      // Check ownership
      const group = db
        .prepare('SELECT id, is_default FROM trading_watchlist_groups WHERE id = ? AND user_id = ?')
        .get(groupId, userId);

      if (!group) {
        return reply.send({ error: 'Watchlist group not found' }, 404);
      }

      if (group.is_default === 1) {
        return reply.send({ error: 'Cannot delete default watchlist' }, 400);
      }

      // Get default watchlist
      const defaultGroup = db
        .prepare('SELECT id FROM trading_watchlist_groups WHERE user_id = ? AND is_default = 1')
        .get(userId);

      if (defaultGroup) {
        // Move items to default watchlist
        db.prepare(
          'UPDATE trading_watchlist SET watchlist_group_id = ? WHERE watchlist_group_id = ?'
        ).run(defaultGroup.id, groupId);
      } else {
        // No default? Set items to null (ungrouped)
        db.prepare(
          'UPDATE trading_watchlist SET watchlist_group_id = NULL WHERE watchlist_group_id = ?'
        ).run(groupId);
      }

      // Delete group
      db.prepare('DELETE FROM trading_watchlist_groups WHERE id = ? AND user_id = ?').run(
        groupId,
        userId
      );

      console.log('[Trading]', `Deleted watchlist group: ${groupId}`);

      return reply.send({ success: true });
    } catch (error) {
      console.error('[Trading]', `Failed to delete watchlist group: ${error.message}`);
      return reply.send({ error: 'Failed to delete watchlist group' }, 500);
    }
  });

  /**
   * PUT /api/ext/trading/watchlist/groups/reorder
   * Reorder watchlist groups
   * Body: { groupIds: ['id1', 'id2', 'id3'] } - array in new order
   */
  fastify.put('/watchlist/groups/reorder', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { groupIds } = request.body;

      if (!Array.isArray(groupIds) || groupIds.length === 0) {
        return reply.send({ error: 'groupIds array is required' }, 400);
      }

      // Update display_order for each group
      const stmt = db.prepare(
        'UPDATE trading_watchlist_groups SET display_order = ? WHERE id = ? AND user_id = ?'
      );

      groupIds.forEach((groupId, index) => {
        stmt.run(index, groupId, userId);
      });

      console.log('[Trading]', `Reordered ${groupIds.length} watchlist groups`);

      return reply.send({ success: true });
    } catch (error) {
      console.error('[Trading]', `Failed to reorder watchlist groups: ${error.message}`);
      return reply.send({ error: 'Failed to reorder watchlist groups' }, 500);
    }
  });

  /**
   * PUT /api/ext/trading/watchlist/reorder
   * Reorder watchlist items within a group
   * Body: { itemIds: ['id1', 'id2', 'id3'] } - array in new order
   */
  fastify.put('/watchlist/reorder', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { itemIds } = request.body;

      if (!Array.isArray(itemIds) || itemIds.length === 0) {
        return reply.send({ error: 'itemIds array is required' }, 400);
      }

      // Update display_order for each item
      const stmt = db.prepare(
        'UPDATE trading_watchlist SET display_order = ? WHERE id = ? AND user_id = ?'
      );

      itemIds.forEach((itemId, index) => {
        stmt.run(index, itemId, userId);
      });

      console.log('[Trading]', `Reordered ${itemIds.length} watchlist items`);

      return reply.send({ success: true });
    } catch (error) {
      console.error('[Trading]', `Failed to reorder watchlist items: ${error.message}`);
      return reply.send({ error: 'Failed to reorder watchlist items' }, 500);
    }
  });

  // ============================================================================
  // PRICE ALERTS
  // ============================================================================

  /**
   * GET /api/ext/trading/alerts
   * Get all price alerts for user
   */
  fastify.get('/alerts', async (request, reply) => {
    try {
      const userId = getUserId(request);

      const alerts = db
        .prepare(
          `
        SELECT id, symbol, asset_class, alert_type, target_price, target_percent,
               is_active, repeat_alert, notification_channels, last_triggered_at,
               trigger_count, auto_execute_order, order_config, created_at, expires_at
        FROM trading_price_alerts
        WHERE user_id = ?
        ORDER BY is_active DESC, created_at DESC
      `
        )
        .all(userId);

      // Parse JSON fields
      const parsedAlerts = alerts.map((alert) => ({
        ...alert,
        notification_channels: JSON.parse(alert.notification_channels || '["in_app"]'),
        order_config: alert.order_config ? JSON.parse(alert.order_config) : null
      }));

      return reply.send({ alerts: parsedAlerts });
    } catch (error) {
      console.error('[Trading]', `Failed to fetch price alerts: ${error.message}`);
      return reply.send({ error: 'Failed to fetch price alerts' }, 500);
    }
  });

  /**
   * POST /api/ext/trading/alerts
   * Create new price alert
   * Body: { symbol, alert_type, target_price?, target_percent?, notification_channels?, ... }
   */
  fastify.post('/alerts', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const {
        symbol,
        asset_class = 'us_equity',
        alert_type,
        target_price,
        target_percent,
        repeat_alert = 0,
        notification_channels = ['in_app'],
        auto_execute_order = 0,
        order_config,
        expires_at
      } = request.body;

      // Validation
      if (!symbol || !alert_type) {
        return reply.send({ error: 'symbol and alert_type are required' }, 400);
      }

      if (!['above', 'below', 'percent_change'].includes(alert_type)) {
        return reply.send({ error: 'Invalid alert_type' }, 400);
      }

      if ((alert_type === 'above' || alert_type === 'below') && !target_price) {
        return reply.send({ error: 'target_price is required for above/below alerts' }, 400);
      }

      if (alert_type === 'percent_change' && !target_percent) {
        return reply.send({ error: 'target_percent is required for percent_change alerts' }, 400);
      }

      const id = randomBytes(16).toString('hex');
      const now = new Date().toISOString();

      db.prepare(
        `
        INSERT INTO trading_price_alerts (
          id, user_id, symbol, asset_class, alert_type, target_price, target_percent,
          is_active, repeat_alert, notification_channels, auto_execute_order, order_config,
          created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        id,
        userId,
        symbol.toUpperCase(),
        asset_class,
        alert_type,
        target_price || null,
        target_percent || null,
        1,
        repeat_alert,
        JSON.stringify(notification_channels),
        auto_execute_order,
        order_config ? JSON.stringify(order_config) : null,
        now,
        expires_at || null
      );

      console.log('[Trading]', `Created price alert: ${symbol} ${alert_type}`);

      return reply.send({
        success: true,
        alert: {
          id,
          symbol: symbol.toUpperCase(),
          asset_class,
          alert_type,
          target_price,
          target_percent,
          is_active: 1,
          created_at: now
        }
      });
    } catch (error) {
      console.error('[Trading]', `Failed to create price alert: ${error.message}`);
      return reply.send({ error: 'Failed to create price alert' }, 500);
    }
  });

  /**
   * PUT /api/ext/trading/alerts/:id
   * Update price alert (toggle active, update target, etc.)
   */
  fastify.put('/alerts/:id', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const alertId = request.params('id');
      const { is_active, target_price, target_percent, notification_channels } = request.body;

      // Check ownership
      const alert = db
        .prepare('SELECT id FROM trading_price_alerts WHERE id = ? AND user_id = ?')
        .get(alertId, userId);

      if (!alert) {
        return reply.send({ error: 'Price alert not found' }, 404);
      }

      const updates = [];
      const params = [];

      if (is_active !== undefined) {
        updates.push('is_active = ?');
        params.push(is_active ? 1 : 0);
      }
      if (target_price !== undefined) {
        updates.push('target_price = ?');
        params.push(target_price);
      }
      if (target_percent !== undefined) {
        updates.push('target_percent = ?');
        params.push(target_percent);
      }
      if (notification_channels !== undefined) {
        updates.push('notification_channels = ?');
        params.push(JSON.stringify(notification_channels));
      }

      if (updates.length === 0) {
        return reply.send({ error: 'No fields to update' }, 400);
      }

      params.push(alertId, userId);

      db.prepare(
        `UPDATE trading_price_alerts SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`
      ).run(...params);

      console.log('[Trading]', `Updated price alert: ${alertId}`);

      return reply.send({ success: true });
    } catch (error) {
      console.error('[Trading]', `Failed to update price alert: ${error.message}`);
      return reply.send({ error: 'Failed to update price alert' }, 500);
    }
  });

  /**
   * DELETE /api/ext/trading/alerts/:id
   * Delete price alert
   */
  fastify.delete('/alerts/:id', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const alertId = request.params('id');

      db.prepare('DELETE FROM trading_price_alerts WHERE id = ? AND user_id = ?').run(
        alertId,
        userId
      );

      console.log('[Trading]', `Deleted price alert: ${alertId}`);

      return reply.send({ success: true });
    } catch (error) {
      console.error('[Trading]', `Failed to delete price alert: ${error.message}`);
      return reply.send({ error: 'Failed to delete price alert' }, 500);
    }
  });

  // ============================================================================
  // IMPORT/EXPORT
  // ============================================================================

  /**
   * GET /api/ext/trading/watchlist/export
   * Export watchlist as CSV
   * Query: ?groupId=xxx (optional - export specific group, or all if omitted)
   */
  fastify.get('/watchlist/export', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const groupId = request.query('groupId');

      let query = `
        SELECT w.symbol, w.asset_class, w.name, w.notes, g.name as group_name
        FROM trading_watchlist w
        LEFT JOIN trading_watchlist_groups g ON w.watchlist_group_id = g.id
        WHERE w.user_id = ?
      `;

      const params = [userId];

      if (groupId) {
        query += ' AND w.watchlist_group_id = ?';
        params.push(groupId);
      }

      query += ' ORDER BY w.display_order ASC';

      const items = db.prepare(query).all(...params);

      // Generate CSV
      const csvLines = ['Symbol,Asset Class,Name,Notes,Watchlist'];

      items.forEach((item) => {
        const line = [
          item.symbol || '',
          item.asset_class || '',
          item.name || '',
          (item.notes || '').replace(/"/g, '""'), // Escape quotes
          item.group_name || ''
        ].map((field) => `"${field}"`);

        csvLines.push(line.join(','));
      });

      const csvContent = csvLines.join('\n');

      reply.raw.setHeader('Content-Type', 'text/csv');
      reply.raw.setHeader(
        'Content-Disposition',
        `attachment; filename="watchlist_${new Date().toISOString().split('T')[0]}.csv"`
      );

      return reply.send(csvContent);
    } catch (error) {
      console.error('[Trading]', `Failed to export watchlist: ${error.message}`);
      return reply.send({ error: 'Failed to export watchlist' }, 500);
    }
  });

  /**
   * POST /api/ext/trading/watchlist/import
   * Import watchlist from CSV
   * Body: { csv: string, groupId?: string } - CSV content and target group ID
   */
  fastify.post('/watchlist/import', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { csv, groupId } = request.body;

      if (!csv || typeof csv !== 'string') {
        return reply.send({ error: 'CSV content is required' }, 400);
      }

      // Verify group ownership if groupId provided
      if (groupId) {
        const group = db
          .prepare('SELECT id FROM trading_watchlist_groups WHERE id = ? AND user_id = ?')
          .get(groupId, userId);

        if (!group) {
          return reply.send({ error: 'Watchlist group not found' }, 404);
        }
      }

      // Parse CSV (simple parser - expects Symbol,Asset Class,Name,Notes format)
      const lines = csv.split('\n').filter((line) => line.trim().length > 0);

      if (lines.length < 2) {
        return reply.send({ error: 'CSV file is empty or invalid' }, 400);
      }

      // Skip header
      const dataLines = lines.slice(1);

      let successCount = 0;
      let failCount = 0;
      const errors = [];

      const stmt = db.prepare(
        `
        INSERT OR IGNORE INTO trading_watchlist (
          id, user_id, symbol, asset_class, name, notes, watchlist_group_id, display_order, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      );

      dataLines.forEach((line, index) => {
        try {
          // Parse CSV line (handle quoted fields)
          const fields = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
          const cleanFields = fields.map((f) => f.replace(/^"|"$/g, '').trim());

          const symbol = cleanFields[0]?.toUpperCase();
          const asset_class = cleanFields[1] || 'us_equity';
          const name = cleanFields[2] || null;
          const notes = cleanFields[3] || null;

          if (!symbol) {
            errors.push(`Line ${index + 2}: Missing symbol`);
            failCount++;
            return;
          }

          const id = randomBytes(16).toString('hex');
          const now = new Date().toISOString();

          const result = stmt.run(
            id,
            userId,
            symbol,
            asset_class,
            name,
            notes,
            groupId || null,
            index,
            now
          );

          if (result.changes > 0) {
            successCount++;
          } else {
            failCount++; // Already exists (OR IGNORE)
          }
        } catch (err) {
          errors.push(`Line ${index + 2}: ${err.message}`);
          failCount++;
        }
      });

      // Log import
      const importId = randomBytes(16).toString('hex');
      const now = new Date().toISOString();

      db.prepare(
        `
        INSERT INTO trading_watchlist_imports (
          id, user_id, watchlist_group_id, filename, symbols_count,
          successful_imports, failed_imports, imported_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(importId, userId, groupId || null, 'import.csv', dataLines.length, successCount, failCount, now);

      console.log('[Trading]', `Imported watchlist: ${successCount} success, ${failCount} failed`);

      return reply.send({
        success: true,
        successCount,
        failCount,
        total: dataLines.length,
        errors: errors.slice(0, 10) // Limit error messages
      });
    } catch (error) {
      console.error('[Trading]', `Failed to import watchlist: ${error.message}`);
      return reply.send({ error: 'Failed to import watchlist' }, 500);
    }
  });

  // ============================================================================
  // NEWS FEED
  // ============================================================================

  /**
   * GET /api/ext/trading/news
   * Get latest news articles
   * Query: ?symbols=AAPL,TSLA&limit=50&start=2024-01-01
   */
  fastify.get('/news', async (request, reply) => {
    try {
      const userId = getUserId(request);

      // Get user's trading account for API credentials
      const account = db
        .prepare(
          `
        SELECT api_key_credential_id, api_secret_credential_id, account_mode
        FROM trading_accounts
        WHERE user_id = ? AND is_default = 1 AND is_active = 1
        LIMIT 1
      `
        )
        .get(userId);

      if (!account) {
        return reply.send({ error: 'No active trading account found' }, 404);
      }

      // Decrypt API credentials
      const apiKey = credentialManager.getValue(account.api_key_credential_id);
      const apiSecret = credentialManager.getValue(account.api_secret_credential_id);

      if (!apiKey || !apiSecret) {
        return reply.send({ error: 'Failed to decrypt API credentials' }, 500);
      }

      // Create Alpaca client
      const alpaca = createAlpacaClient(apiKey, apiSecret, account.account_mode);

      // Parse query parameters
      const symbols = request.query('symbols'); // Comma-separated: "AAPL,TSLA"
      const limit = parseInt(request.query('limit') || '50', 10);
      const start = request.query('start'); // ISO date
      const end = request.query('end');

      // Fetch news from Alpaca
      const news = await getNews(alpaca, {
        symbols: symbols ? symbols.split(',') : undefined,
        limit: Math.min(limit, 100), // Cap at 100
        start,
        end,
        include_content: false, // Don't include full article content for performance
      });

      // Cache news articles in database (async, don't wait)
      setImmediate(() => {
        try {
          const insertStmt = db.prepare(
            `
            INSERT OR IGNORE INTO trading_news_articles (
              article_id, headline, summary, content, author, source, url, images,
              symbols, created_at, updated_at, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          `
          );

          const insertSymbolStmt = db.prepare(
            `INSERT OR IGNORE INTO trading_news_symbols (article_id, symbol) VALUES (?, ?)`
          );

          news.forEach((article) => {
            insertStmt.run(
              article.id,
              article.headline,
              article.summary || null,
              article.content || null,
              article.author || null,
              article.source || 'Benzinga',
              article.url || null,
              JSON.stringify(article.images || []),
              JSON.stringify(article.symbols || []),
              article.created_at,
              article.updated_at || null
            );

            // Insert symbol references
            if (article.symbols && article.symbols.length > 0) {
              article.symbols.forEach((symbol) => {
                insertSymbolStmt.run(article.id, symbol);
              });
            }
          });
        } catch (cacheError) {
          console.error('[Trading News] Failed to cache articles:', cacheError.message);
        }
      });

      return reply.send({ news, count: news.length });
    } catch (error) {
      console.error('[Trading]', `Failed to fetch news: ${error.message}`);
      return reply.send({ error: 'Failed to fetch news' }, 500);
    }
  });

  /**
   * GET /api/ext/trading/news/cached
   * Get cached news from database (faster, no API call)
   * Query: ?symbols=AAPL&limit=50
   */
  fastify.get('/news/cached', async (request, reply) => {
    try {
      const userId = getUserId(request);

      const symbols = request.query('symbols'); // Comma-separated or single
      const limit = parseInt(request.query('limit') || '50', 10);

      let query = `
        SELECT DISTINCT a.article_id as id, a.headline, a.summary, a.author, a.source,
               a.url, a.images, a.symbols, a.sentiment, a.sentiment_score, a.created_at
        FROM trading_news_articles a
      `;

      const params = [];

      if (symbols) {
        const symbolList = symbols.split(',').map((s) => s.trim().toUpperCase());
        query += `
          INNER JOIN trading_news_symbols ns ON a.article_id = ns.article_id
          WHERE ns.symbol IN (${symbolList.map(() => '?').join(',')})
        `;
        params.push(...symbolList);
      }

      query += ' ORDER BY a.created_at DESC LIMIT ?';
      params.push(Math.min(limit, 200));

      const articles = db.prepare(query).all(...params);

      // Parse JSON fields
      const parsedArticles = articles.map((article) => ({
        ...article,
        images: JSON.parse(article.images || '[]'),
        symbols: JSON.parse(article.symbols || '[]'),
      }));

      return reply.send({ news: parsedArticles, count: parsedArticles.length, cached: true });
    } catch (error) {
      console.error('[Trading]', `Failed to fetch cached news: ${error.message}`);
      return reply.send({ error: 'Failed to fetch cached news' }, 500);
    }
  });

  /**
   * GET /api/ext/trading/news/trending
   * Get trending symbols from recent news
   */
  fastify.get('/news/trending', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const limit = parseInt(request.query('limit') || '10', 10);

      // Get most mentioned symbols in last 24 hours
      const cutoff = new Date();
      cutoff.setHours(cutoff.getHours() - 24);
      const cutoffISO = cutoff.toISOString();

      const trending = db
        .prepare(
          `
        SELECT ns.symbol, COUNT(*) as mention_count
        FROM trading_news_symbols ns
        INNER JOIN trading_news_articles a ON ns.article_id = a.article_id
        WHERE a.created_at >= ?
        GROUP BY ns.symbol
        ORDER BY mention_count DESC
        LIMIT ?
      `
        )
        .all(cutoffISO, limit);

      return reply.send({ trending });
    } catch (error) {
      console.error('[Trading]', `Failed to fetch trending symbols: ${error.message}`);
      return reply.send({ error: 'Failed to fetch trending symbols' }, 500);
    }
  });

  // ============================================================================
  // STRATEGIES (AI Trading)
  // ============================================================================

  /**
   * GET /api/ext/trading/strategies
   * List trading strategies
   */
  fastify.get('/strategies', async (request, reply) => {
    try {
      const userId = getUserId(request);

      const strategies = db
        .prepare(
          `
        SELECT
          s.id, s.trading_account_id, s.strategy_name, s.strategy_type,
          s.execution_mode, s.status, s.symbols, s.asset_classes,
          s.max_position_size, s.max_daily_trades, s.stop_loss_percent,
          s.take_profit_percent, s.config, s.total_trades, s.winning_trades,
          s.losing_trades, s.total_profit_loss, s.win_rate,
          s.created_at, s.updated_at, s.started_at, s.stopped_at, s.last_run_at,
          a.account_name, a.account_mode
        FROM trading_strategies s
        JOIN trading_accounts a ON s.trading_account_id = a.id
        WHERE a.user_id = ?
        ORDER BY s.created_at DESC
      `
        )
        .all(userId);

      // Parse JSON fields
      for (const s of strategies) {
        s.symbols = JSON.parse(s.symbols || '[]');
        s.asset_classes = JSON.parse(s.asset_classes || '[]');
        s.config = JSON.parse(s.config || '{}');
      }

      return reply.send({ strategies });
    } catch (error) {
      console.error('[Trading]', `Failed to fetch strategies: ${error.message}`);
      return reply.send({ error: 'Failed to fetch strategies' }, 500);
    }
  });

  /**
   * POST /api/ext/trading/strategies
   * Create new trading strategy
   * Body: { trading_account_id, strategy_name, strategy_type, execution_mode, symbols, config?, risk_management? }
   */
  fastify.post('/strategies', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const {
        trading_account_id,
        strategy_name,
        strategy_type,
        execution_mode,
        symbols,
        asset_classes = ['us_equity'],
        config = {},
        max_position_size,
        max_daily_trades = 10,
        stop_loss_percent,
        take_profit_percent,
      } = request.body;

      // Validate
      if (!trading_account_id || !strategy_name || !strategy_type || !execution_mode) {
        return reply.send({ error: 'Missing required fields' }, 400);
      }

      if (!['manual', 'semi_auto', 'full_auto'].includes(execution_mode)) {
        return reply.send({ error: 'Invalid execution_mode' }, 400);
      }

      if (!symbols || symbols.length === 0) {
        return reply.send({ error: 'At least one symbol is required' }, 400);
      }

      // Verify account ownership
      const account = db
        .prepare('SELECT id FROM trading_accounts WHERE id = ? AND user_id = ?')
        .get(trading_account_id, userId);

      if (!account) {
        return reply.send({ error: 'Account not found' }, 404);
      }

      // Insert strategy
      const id = randomBytes(16).toString('hex');
      const now = new Date().toISOString();

      db.prepare(
        `
        INSERT INTO trading_strategies (
          id, trading_account_id, strategy_name, strategy_type, execution_mode,
          status, symbols, asset_classes, max_position_size, max_daily_trades,
          stop_loss_percent, take_profit_percent, config, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        id,
        trading_account_id,
        strategy_name,
        strategy_type,
        execution_mode,
        JSON.stringify(symbols),
        JSON.stringify(asset_classes),
        max_position_size || null,
        max_daily_trades,
        stop_loss_percent || null,
        take_profit_percent || null,
        JSON.stringify(config),
        now,
        now
      );

      console.log('[Trading]', `Strategy created: ${strategy_name} (${strategy_type})`);

      return reply.send({ success: true, id });
    } catch (error) {
      console.error('[Trading]', `Failed to create strategy: ${error.message}`);
      return reply.send({ error: 'Failed to create strategy' }, 500);
    }
  });

  /**
   * PUT /api/ext/trading/strategies/:id
   * Update strategy
   * Body: { strategy_name?, symbols?, config?, execution_mode?, risk_management? }
   */
  fastify.put('/strategies/:id', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const strategyId = request.params('id');
      const body = request.body;

      // Verify ownership
      const strategy = db
        .prepare(
          `
        SELECT s.id
        FROM trading_strategies s
        JOIN trading_accounts a ON s.trading_account_id = a.id
        WHERE s.id = ? AND a.user_id = ?
      `
        )
        .get(strategyId, userId);

      if (!strategy) {
        return reply.send({ error: 'Strategy not found' }, 404);
      }

      const updates = [];
      const params = [];

      const fields = [
        'strategy_name',
        'execution_mode',
        'max_position_size',
        'max_daily_trades',
        'stop_loss_percent',
        'take_profit_percent',
      ];

      for (const field of fields) {
        if (body[field] !== undefined) {
          updates.push(`${field} = ?`);
          params.push(body[field]);
        }
      }

      if (body.symbols !== undefined) {
        updates.push('symbols = ?');
        params.push(JSON.stringify(body.symbols));
      }

      if (body.asset_classes !== undefined) {
        updates.push('asset_classes = ?');
        params.push(JSON.stringify(body.asset_classes));
      }

      if (body.config !== undefined) {
        updates.push('config = ?');
        params.push(JSON.stringify(body.config));
      }

      if (updates.length === 0) {
        return reply.send({ error: 'No fields to update' }, 400);
      }

      updates.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(strategyId);

      db.prepare(
        `UPDATE trading_strategies SET ${updates.join(', ')} WHERE id = ?`
      ).run(...params);

      console.log('[Trading]', `Strategy updated: ${strategyId}`);

      return reply.send({ success: true });
    } catch (error) {
      console.error('[Trading]', `Failed to update strategy: ${error.message}`);
      return reply.send({ error: 'Failed to update strategy' }, 500);
    }
  });

  /**
   * DELETE /api/ext/trading/strategies/:id
   * Delete strategy
   */
  fastify.delete('/strategies/:id', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const strategyId = request.params('id');

      // Verify ownership
      const strategy = db
        .prepare(
          `
        SELECT s.id
        FROM trading_strategies s
        JOIN trading_accounts a ON s.trading_account_id = a.id
        WHERE s.id = ? AND a.user_id = ?
      `
        )
        .get(strategyId, userId);

      if (!strategy) {
        return reply.send({ error: 'Strategy not found' }, 404);
      }

      // Delete (cascade will delete signals, performance, etc.)
      db.prepare('DELETE FROM trading_strategies WHERE id = ?').run(strategyId);

      console.log('[Trading]', `Strategy deleted: ${strategyId}`);

      return reply.send({ success: true });
    } catch (error) {
      console.error('[Trading]', `Failed to delete strategy: ${error.message}`);
      return reply.send({ error: 'Failed to delete strategy' }, 500);
    }
  });

  /**
   * POST /api/ext/trading/strategies/:id/start
   * Start strategy execution
   */
  fastify.post('/strategies/:id/start', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const strategyId = request.params('id');

      // Verify ownership
      const strategy = db
        .prepare(
          `
        SELECT s.id, s.execution_mode, a.allow_autonomous_trading
        FROM trading_strategies s
        JOIN trading_accounts a ON s.trading_account_id = a.id
        WHERE s.id = ? AND a.user_id = ?
      `
        )
        .get(strategyId, userId);

      if (!strategy) {
        return reply.send({ error: 'Strategy not found' }, 404);
      }

      // Check if autonomous trading is allowed
      if (
        strategy.execution_mode === 'full_auto' &&
        !strategy.allow_autonomous_trading
      ) {
        return reply.send(
          {
            error:
              'Autonomous trading not enabled for this account. Enable it in account settings first.',
          },
          403
        );
      }

      const now = new Date().toISOString();

      db.prepare(
        `
        UPDATE trading_strategies
        SET status = 'active', started_at = ?, updated_at = ?
        WHERE id = ?
      `
      ).run(now, now, strategyId);

      console.log('[Trading]', `Strategy started: ${strategyId}`);

      return reply.send({ success: true });
    } catch (error) {
      console.error('[Trading]', `Failed to start strategy: ${error.message}`);
      return reply.send({ error: 'Failed to start strategy' }, 500);
    }
  });

  /**
   * POST /api/ext/trading/strategies/:id/stop
   * Stop strategy execution
   */
  fastify.post('/strategies/:id/stop', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const strategyId = request.params('id');

      // Verify ownership
      const strategy = db
        .prepare(
          `
        SELECT s.id
        FROM trading_strategies s
        JOIN trading_accounts a ON s.trading_account_id = a.id
        WHERE s.id = ? AND a.user_id = ?
      `
        )
        .get(strategyId, userId);

      if (!strategy) {
        return reply.send({ error: 'Strategy not found' }, 404);
      }

      const now = new Date().toISOString();

      db.prepare(
        `
        UPDATE trading_strategies
        SET status = 'stopped', stopped_at = ?, updated_at = ?
        WHERE id = ?
      `
      ).run(now, now, strategyId);

      console.log('[Trading]', `Strategy stopped: ${strategyId}`);

      return reply.send({ success: true });
    } catch (error) {
      console.error('[Trading]', `Failed to stop strategy: ${error.message}`);
      return reply.send({ error: 'Failed to stop strategy' }, 500);
    }
  });

  // ============================================================================
  // SIGNALS (Trading Signals for Semi-Auto / Full-Auto)
  // ============================================================================

  /**
   * GET /api/ext/trading/signals
   * Get pending trading signals
   * Query params: status=pending|approved|rejected|executed
   */
  fastify.get('/signals', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const status = request.query('status') || 'pending';

      const signals = db
        .prepare(
          `
        SELECT
          sig.id, sig.strategy_id, sig.symbol, sig.asset_class, sig.signal_type,
          sig.current_price, sig.target_price, sig.stop_loss_price, sig.confidence,
          sig.reason, sig.analysis_data, sig.recommended_qty, sig.recommended_order_type,
          sig.status, sig.requires_approval, sig.created_at, sig.expires_at,
          strat.strategy_name, strat.execution_mode,
          acc.account_name, acc.account_mode
        FROM trading_signals sig
        JOIN trading_strategies strat ON sig.strategy_id = strat.id
        JOIN trading_accounts acc ON sig.trading_account_id = acc.id
        WHERE acc.user_id = ? AND sig.status = ?
        ORDER BY sig.created_at DESC
        LIMIT 50
      `
        )
        .all(userId, status);

      // Parse JSON fields
      for (const sig of signals) {
        sig.analysis_data = JSON.parse(sig.analysis_data || '{}');
      }

      return reply.send({ signals });
    } catch (error) {
      console.error('[Trading]', `Failed to fetch signals: ${error.message}`);
      return reply.send({ error: 'Failed to fetch signals' }, 500);
    }
  });

  /**
   * POST /api/ext/trading/signals/:id/execute
   * Execute a trading signal (approve and place order)
   */
  fastify.post('/signals/:id/execute', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const signalId = request.params('id');

      // Get signal
      const signal = db
        .prepare(
          `
        SELECT
          sig.*, acc.id as account_id, acc.api_key_credential_id, acc.api_secret_credential_id, acc.account_mode
        FROM trading_signals sig
        JOIN trading_accounts acc ON sig.trading_account_id = acc.id
        WHERE sig.id = ? AND acc.user_id = ?
      `
        )
        .get(signalId, userId);

      if (!signal) {
        return reply.send({ error: 'Signal not found' }, 404);
      }

      if (signal.status !== 'pending') {
        return reply.send({ error: `Signal already ${signal.status}` }, 400);
      }

      // Decrypt credentials
      const apiKey = await credentialManager.getValue(signal.api_key_credential_id);
      const apiSecret = await credentialManager.getValue(signal.api_secret_credential_id);

      // Place order via Alpaca
      const alpaca = createAlpacaClient(apiKey, apiSecret, signal.account_mode);
      const order = await placeOrder(alpaca, {
        symbol: signal.symbol,
        qty: signal.recommended_qty,
        side: signal.signal_type === 'buy' ? 'buy' : 'sell',
        order_type: signal.recommended_order_type,
      });

      // Save order to database
      const orderId = randomBytes(16).toString('hex');
      const now = new Date().toISOString();

      db.prepare(
        `
        INSERT INTO trading_orders (
          id, trading_account_id, alpaca_order_id, symbol, asset_class, qty, side,
          order_type, time_in_force, status, placed_by, strategy_id,
          submitted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'day', ?, 'agent', ?, ?, ?, ?)
      `
      ).run(
        orderId,
        signal.account_id,
        order.id,
        order.symbol,
        order.asset_class,
        order.qty,
        order.side,
        order.order_type,
        order.status,
        signal.strategy_id,
        order.submitted_at,
        now,
        now
      );

      // Update signal status
      db.prepare(
        `
        UPDATE trading_signals
        SET status = 'executed', order_id = ?, executed_price = ?, executed_qty = ?,
            approved_by = ?, approved_at = ?, executed_at = ?
        WHERE id = ?
      `
      ).run(
        orderId,
        signal.current_price,
        signal.recommended_qty,
        userId,
        now,
        now,
        signalId
      );

      console.log('[Trading]', `Signal executed: ${signalId} → Order ${orderId}`);

      return reply.send({ success: true, order_id: orderId });
    } catch (error) {
      console.error('[Trading]', `Failed to execute signal: ${error.message}`);

      // Mark signal as failed
      db.prepare(
        `
        UPDATE trading_signals
        SET status = 'failed', execution_error = ?
        WHERE id = ?
      `
      ).run(error.message, signalId);

      return reply.send({ error: `Failed to execute signal: ${error.message}` }, 500);
    }
  });

  /**
   * POST /api/ext/trading/signals/:id/reject
   * Reject a trading signal
   * Body: { reason? }
   */
  fastify.post('/signals/:id/reject', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const signalId = request.params('id');
      const { reason } = request.body;

      // Verify ownership
      const signal = db
        .prepare(
          `
        SELECT sig.id
        FROM trading_signals sig
        JOIN trading_accounts acc ON sig.trading_account_id = acc.id
        WHERE sig.id = ? AND acc.user_id = ?
      `
        )
        .get(signalId, userId);

      if (!signal) {
        return reply.send({ error: 'Signal not found' }, 404);
      }

      const now = new Date().toISOString();

      db.prepare(
        `
        UPDATE trading_signals
        SET status = 'rejected', rejected_at = ?, rejection_reason = ?
        WHERE id = ?
      `
      ).run(now, reason || 'User rejected', signalId);

      console.log('[Trading]', `Signal rejected: ${signalId}`);

      return reply.send({ success: true });
    } catch (error) {
      console.error('[Trading]', `Failed to reject signal: ${error.message}`);
      return reply.send({ error: 'Failed to reject signal' }, 500);
    }
  });

  // ============================================================================
  // ACTIVITY LOG
  // ============================================================================

  /**
   * GET /api/ext/trading/activity
   * Get trading activity log
   * Query params: limit=50
   */
  fastify.get('/activity', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const limit = parseInt(request.query('limit') || '50', 10);

      const activity = db
        .prepare(
          `
        SELECT
          log.id, log.action, log.details, log.triggered_by, log.created_at,
          acc.account_name, acc.account_mode
        FROM trading_activity_log log
        JOIN trading_accounts acc ON log.trading_account_id = acc.id
        WHERE acc.user_id = ?
        ORDER BY log.created_at DESC
        LIMIT ?
      `
        )
        .all(userId, limit);

      // Parse JSON details
      for (const a of activity) {
        a.details = JSON.parse(a.details || '{}');
      }

      return reply.send({ activity });
    } catch (error) {
      console.error('[Trading]', `Failed to fetch activity log: ${error.message}`);
      return reply.send({ error: 'Failed to fetch activity log' }, 500);
    }
  });

  // ============================================================================
  // REAL-TIME WEBSOCKET STREAM (SSE)
  // ============================================================================

  /**
   * GET /api/ext/trading/stream?token=xxx
   * Server-Sent Events endpoint for real-time price updates
   * Subscribes to WebSocket updates for positions + watchlist symbols
   * Note: Uses query parameter for token since EventSource doesn't support custom headers
   */
  fastify.get('/stream', async (request, reply) => {
    try {
      // The token (header, or ?token= because EventSource cannot send
      // headers) is verified by the extension route guard (manifest
      // "queryTokenRoutes"), which sets request.authUserId.
      const userId = request.authUserId;

      if (!userId) {
        reply.code(401);
        return reply.send({ error: 'Unauthorized' });
      }

      // Get active account
      const account = db
        .prepare(
          `
        SELECT
          ta.id, ta.api_key_credential_id, ta.api_secret_credential_id, ta.account_mode
        FROM trading_accounts ta
        WHERE ta.user_id = ? AND ta.is_active = 1 AND ta.is_default = 1
        LIMIT 1
      `
        )
        .get(userId);

      if (!account) {
        reply.code(404);
        return reply.send({ error: 'No active trading account found' });
      }

      // Decrypt API keys
      const apiKey = await credentialManager.getValue(account.api_key_credential_id);
      const apiSecret = await credentialManager.getValue(account.api_secret_credential_id);

      if (!apiKey || !apiSecret) {
        reply.code(500);
        return reply.send({ error: 'Failed to decrypt API credentials' });
      }

      // Get symbols to subscribe to
      const positions = db
        .prepare('SELECT DISTINCT symbol FROM trading_positions WHERE trading_account_id = ?')
        .all(account.id);

      const watchlist = db
        .prepare('SELECT DISTINCT symbol FROM trading_watchlist WHERE user_id = ?')
        .all(userId);

      const symbols = [
        ...positions.map(p => p.symbol),
        ...watchlist.map(w => w.symbol)
      ];

      if (symbols.length === 0) {
        reply.code(400);
        return reply.send({ error: 'No symbols to stream (add positions or watchlist symbols)' });
      }

      console.log(`[Trading WebSocket] Starting stream for ${symbols.length} symbols:`, symbols.join(', '));

      // SECURITY (F-08): never `Access-Control-Allow-Origin: *`. The raw SSE
      // response bypasses the core CORS plugin, so allow only the same
      // origins the core CORS config allows (the dashboard), else none.
      const requestOrigin = request.headers.origin;
      if (typeof requestOrigin === 'string' && streamAllowedOrigins().includes(requestOrigin)) {
        reply.raw.setHeader('Access-Control-Allow-Origin', requestOrigin);
        reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
        reply.raw.setHeader('Vary', 'Origin');
      }

      // Set up SSE headers
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');

      // Send initial connection event
      reply.raw.write(`data: ${JSON.stringify({ type: 'connected', symbols })}\n\n`);

      // Keep connection alive with heartbeat
      const heartbeat = setInterval(() => {
        reply.raw.write(`:heartbeat\n\n`);
      }, 30000); // Every 30 seconds

      // Create WebSocket connection with error handling
      let wsConnection;
      try {
        wsConnection = createRealtimeConnection(
          apiKey,
          apiSecret,
          symbols,
          (update) => {
            try {
              // Send SSE event to frontend
              reply.raw.write(`data: ${JSON.stringify(update)}\n\n`);
            } catch (writeError) {
              console.error('[Trading WebSocket] Failed to write SSE event:', writeError.message);
            }
          }
        );

        console.log('[Trading WebSocket] Successfully connected to Alpaca');
      } catch (wsError) {
        console.error('[Trading WebSocket] Alpaca connection failed:', wsError.message);
        // Send error event to frontend
        reply.raw.write(`data: ${JSON.stringify({
          type: 'error',
          message: 'Alpaca WebSocket connection failed. Real-time updates disabled.',
          error: wsError.message
        })}\n\n`);
      }

      // Handle client disconnect
      request.raw.on('close', () => {
        console.log('[Trading WebSocket] Client disconnected, closing WebSocket');
        clearInterval(heartbeat);
        if (wsConnection) {
          wsConnection.close();
        }
      });

    } catch (error) {
      console.error('[Trading WebSocket]', `Stream error: ${error.message}`);

      // If headers not sent yet, send error response
      if (!reply.raw.headersSent) {
        reply.code(500);
        return reply.send({ error: 'Failed to start real-time stream' });
      }
    }
  });

  // ============================================================================
  // OPTIONS TRADING ROUTES
  // ============================================================================

  // 1. GET Options Chain for Symbol
  fastify.get('/api/ext/trading/options/chain/:symbol', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { symbol } = request.params;
      const { expirationDate, strikePrice, optionType } = request.query;

      // Get active trading account
      const account = db.prepare(`
        SELECT ta.*, c.value as api_key, c2.value as api_secret
        FROM trading_accounts ta
        LEFT JOIN credentials c ON ta.api_key_credential_id = c.id
        LEFT JOIN credentials c2 ON ta.api_secret_credential_id = c2.id
        WHERE ta.user_id = ? AND ta.is_active = 1
      `).get(userId);

      if (!account) {
        return reply.code(404).send({ error: 'No active trading account found' });
      }

      const apiKey = account.api_key;
      const apiSecret = account.api_secret;

      if (!apiKey || !apiSecret) {
        return reply.code(400).send({ error: 'Invalid API credentials' });
      }

      // Get options chain from Alpaca
      const alpaca = createAlpacaClient(apiKey, apiSecret, account.mode === 'paper');
      const chain = await getOptionsChain(alpaca, symbol, {
        expirationDate,
        strikePrice,
        optionType
      });

      // Cache the chain data
      const now = new Date().toISOString();
      for (const contract of chain) {
        db.prepare(`
          INSERT OR REPLACE INTO trading_options_chain_cache (
            symbol, option_symbol, option_type, strike_price, expiration_date,
            bid, ask, last_price, volume, open_interest, implied_volatility,
            delta, gamma, theta, vega, rho, fetched_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          symbol,
          contract.symbol,
          contract.type,
          contract.strikePrice,
          contract.expirationDate,
          contract.bid || null,
          contract.ask || null,
          contract.lastPrice || null,
          contract.volume || 0,
          contract.openInterest || 0,
          contract.impliedVolatility || null,
          contract.greeks?.delta || null,
          contract.greeks?.gamma || null,
          contract.greeks?.theta || null,
          contract.greeks?.vega || null,
          contract.greeks?.rho || null,
          now
        );
      }

      return reply.send({ chain });
    } catch (error) {
      console.error('[Trading Options] Get chain error:', error);
      return reply.code(500).send({ error: error.message || 'Failed to fetch options chain' });
    }
  });

  // 2. GET Expiration Dates for Symbol
  fastify.get('/api/ext/trading/options/expirations/:symbol', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { symbol } = request.params;

      // Get active trading account
      const account = db.prepare(`
        SELECT ta.*, c.value as api_key, c2.value as api_secret
        FROM trading_accounts ta
        LEFT JOIN credentials c ON ta.api_key_credential_id = c.id
        LEFT JOIN credentials c2 ON ta.api_secret_credential_id = c2.id
        WHERE ta.user_id = ? AND ta.is_active = 1
      `).get(userId);

      if (!account) {
        return reply.code(404).send({ error: 'No active trading account found' });
      }

      const apiKey = account.api_key;
      const apiSecret = account.api_secret;

      if (!apiKey || !apiSecret) {
        return reply.code(400).send({ error: 'Invalid API credentials' });
      }

      // Get expiration dates from Alpaca
      const alpaca = createAlpacaClient(apiKey, apiSecret, account.mode === 'paper');
      const expirations = await getExpirationDates(alpaca, symbol);

      return reply.send({ expirations });
    } catch (error) {
      console.error('[Trading Options] Get expirations error:', error);
      return reply.code(500).send({ error: error.message || 'Failed to fetch expiration dates' });
    }
  });

  // 3. GET Specific Option Contract
  fastify.get('/api/ext/trading/options/contract/:optionSymbol', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { optionSymbol } = request.params;

      // Get active trading account
      const account = db.prepare(`
        SELECT ta.*, c.value as api_key, c2.value as api_secret
        FROM trading_accounts ta
        LEFT JOIN credentials c ON ta.api_key_credential_id = c.id
        LEFT JOIN credentials c2 ON ta.api_secret_credential_id = c2.id
        WHERE ta.user_id = ? AND ta.is_active = 1
      `).get(userId);

      if (!account) {
        return reply.code(404).send({ error: 'No active trading account found' });
      }

      const apiKey = account.api_key;
      const apiSecret = account.api_secret;

      if (!apiKey || !apiSecret) {
        return reply.code(400).send({ error: 'Invalid API credentials' });
      }

      // Get contract details from Alpaca
      const alpaca = createAlpacaClient(apiKey, apiSecret, account.mode === 'paper');
      const contract = await getOptionContract(alpaca, optionSymbol);

      return reply.send({ contract });
    } catch (error) {
      console.error('[Trading Options] Get contract error:', error);
      return reply.code(500).send({ error: error.message || 'Failed to fetch option contract' });
    }
  });

  // 4. POST Place Options Order
  fastify.post('/api/ext/trading/options/orders', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { optionSymbol, qty, side, orderType, limitPrice } = request.body;

      // Validate input
      if (!optionSymbol || !qty || !side || !orderType) {
        return reply.code(400).send({ error: 'Missing required fields' });
      }

      if (!['buy_to_open', 'buy_to_close', 'sell_to_open', 'sell_to_close'].includes(side)) {
        return reply.code(400).send({ error: 'Invalid side. Must be buy_to_open, buy_to_close, sell_to_open, or sell_to_close' });
      }

      if (!['market', 'limit'].includes(orderType)) {
        return reply.code(400).send({ error: 'Invalid order type. Must be market or limit' });
      }

      if (orderType === 'limit' && !limitPrice) {
        return reply.code(400).send({ error: 'Limit price required for limit orders' });
      }

      // Get active trading account
      const account = db.prepare(`
        SELECT ta.*, c.value as api_key, c2.value as api_secret
        FROM trading_accounts ta
        LEFT JOIN credentials c ON ta.api_key_credential_id = c.id
        LEFT JOIN credentials c2 ON ta.api_secret_credential_id = c2.id
        WHERE ta.user_id = ? AND ta.is_active = 1
      `).get(userId);

      if (!account) {
        return reply.code(404).send({ error: 'No active trading account found' });
      }

      const apiKey = account.api_key;
      const apiSecret = account.api_secret;

      if (!apiKey || !apiSecret) {
        return reply.code(400).send({ error: 'Invalid API credentials' });
      }

      // Place order via Alpaca
      const alpaca = createAlpacaClient(apiKey, apiSecret, account.mode === 'paper');
      const order = await placeOptionsOrder(alpaca, {
        optionSymbol,
        qty,
        side,
        orderType,
        limitPrice
      });

      // Save order to database
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO trading_options_orders (
          trading_account_id, option_symbol, qty, side, order_type,
          limit_price, status, alpaca_order_id, placed_at, placed_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user')
      `).run(
        account.id,
        optionSymbol,
        qty,
        side,
        orderType,
        limitPrice || null,
        order.status || 'pending',
        order.id,
        now
      );

      // Log activity
      db.prepare(`
        INSERT INTO trading_activity_log (
          trading_account_id, action, details, created_at
        ) VALUES (?, ?, ?, ?)
      `).run(
        account.id,
        'options_order_placed',
        JSON.stringify({ optionSymbol, qty, side, orderType, limitPrice }),
        now
      );

      return reply.send({ order });
    } catch (error) {
      console.error('[Trading Options] Place order error:', error);
      return reply.code(500).send({ error: error.message || 'Failed to place options order' });
    }
  });

  // 5. GET Options Orders History
  fastify.get('/api/ext/trading/options/orders', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { status, limit = 50 } = request.query;

      // Get active trading account
      const account = db.prepare(`
        SELECT id FROM trading_accounts
        WHERE user_id = ? AND is_active = 1
      `).get(userId);

      if (!account) {
        return reply.code(404).send({ error: 'No active trading account found' });
      }

      // Build query
      let query = `
        SELECT * FROM trading_options_orders
        WHERE trading_account_id = ?
      `;
      const params = [account.id];

      if (status) {
        query += ` AND status = ?`;
        params.push(status);
      }

      query += ` ORDER BY placed_at DESC LIMIT ?`;
      params.push(parseInt(limit));

      const orders = db.prepare(query).all(...params);

      return reply.send({ orders });
    } catch (error) {
      console.error('[Trading Options] Get orders error:', error);
      return reply.code(500).send({ error: error.message || 'Failed to fetch options orders' });
    }
  });

  // 6. GET Current Options Positions
  fastify.get('/api/ext/trading/options/positions', async (request, reply) => {
    try {
      const userId = getUserId(request);

      // Get active trading account
      const account = db.prepare(`
        SELECT ta.*, c.value as api_key, c2.value as api_secret
        FROM trading_accounts ta
        LEFT JOIN credentials c ON ta.api_key_credential_id = c.id
        LEFT JOIN credentials c2 ON ta.api_secret_credential_id = c2.id
        WHERE ta.user_id = ? AND ta.is_active = 1
      `).get(userId);

      if (!account) {
        return reply.code(404).send({ error: 'No active trading account found' });
      }

      const apiKey = account.api_key;
      const apiSecret = account.api_secret;

      if (!apiKey || !apiSecret) {
        return reply.code(400).send({ error: 'Invalid API credentials' });
      }

      // Get positions from Alpaca
      const alpaca = createAlpacaClient(apiKey, apiSecret, account.mode === 'paper');
      const positions = await getOptionsPositions(alpaca);

      // Update database with current positions
      const now = new Date().toISOString();

      // Clear old positions first
      db.prepare(`DELETE FROM trading_options_positions WHERE trading_account_id = ?`).run(account.id);

      // Insert current positions
      for (const pos of positions) {
        db.prepare(`
          INSERT INTO trading_options_positions (
            trading_account_id, symbol, option_symbol, option_type,
            strike_price, expiration_date, qty, side, avg_entry_price,
            current_price, market_value, unrealized_pl, unrealized_pl_percent,
            delta, gamma, theta, vega, rho, implied_volatility, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          account.id,
          pos.symbol,
          pos.optionSymbol || pos.symbol,
          pos.optionType || 'call',
          pos.strikePrice || 0,
          pos.expirationDate || '',
          pos.qty || 0,
          pos.side || 'long',
          pos.avg_entry_price || 0,
          pos.current_price || 0,
          pos.market_value || 0,
          pos.unrealized_pl || 0,
          pos.unrealized_plpc || 0,
          pos.greeks?.delta || null,
          pos.greeks?.gamma || null,
          pos.greeks?.theta || null,
          pos.greeks?.vega || null,
          pos.greeks?.rho || null,
          pos.impliedVolatility || null,
          now
        );
      }

      return reply.send({ positions });
    } catch (error) {
      console.error('[Trading Options] Get positions error:', error);
      return reply.code(500).send({ error: error.message || 'Failed to fetch options positions' });
    }
  });

  // 7. POST Calculate Greeks for Contract
  fastify.post('/api/ext/trading/options/greeks', async (request, reply) => {
    try {
      const {
        spotPrice,
        strikePrice,
        timeToExpiration,
        riskFreeRate,
        volatility,
        optionType
      } = request.body;

      // Validate input
      if (!spotPrice || !strikePrice || !timeToExpiration || !riskFreeRate || !volatility || !optionType) {
        return reply.code(400).send({ error: 'Missing required fields for Greeks calculation' });
      }

      if (!['call', 'put'].includes(optionType)) {
        return reply.code(400).send({ error: 'Option type must be call or put' });
      }

      // Calculate Greeks using Black-Scholes
      const greeks = calculateGreeks({
        S: spotPrice,
        K: strikePrice,
        T: timeToExpiration,
        r: riskFreeRate,
        sigma: volatility,
        type: optionType
      });

      return reply.send({ greeks });
    } catch (error) {
      console.error('[Trading Options] Calculate Greeks error:', error);
      return reply.code(500).send({ error: error.message || 'Failed to calculate Greeks' });
    }
  });

  // 8. GET Saved Strategies
  fastify.get('/api/ext/trading/options/strategies', async (request, reply) => {
    try {
      const userId = getUserId(request);

      // Get active trading account
      const account = db.prepare(`
        SELECT id FROM trading_accounts
        WHERE user_id = ? AND is_active = 1
      `).get(userId);

      if (!account) {
        return reply.code(404).send({ error: 'No active trading account found' });
      }

      const strategies = db.prepare(`
        SELECT * FROM trading_options_strategies
        WHERE trading_account_id = ?
        ORDER BY created_at DESC
      `).all(account.id);

      // Parse legs JSON
      const parsedStrategies = strategies.map(s => ({
        ...s,
        legs: JSON.parse(s.legs || '[]')
      }));

      return reply.send({ strategies: parsedStrategies });
    } catch (error) {
      console.error('[Trading Options] Get strategies error:', error);
      return reply.code(500).send({ error: error.message || 'Failed to fetch strategies' });
    }
  });

  // 9. POST Create New Strategy
  fastify.post('/api/ext/trading/options/strategies', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { name, strategyType, legs, notes } = request.body;

      if (!name || !strategyType || !legs || !Array.isArray(legs)) {
        return reply.code(400).send({ error: 'Missing required fields' });
      }

      // Get active trading account
      const account = db.prepare(`
        SELECT id FROM trading_accounts
        WHERE user_id = ? AND is_active = 1
      `).get(userId);

      if (!account) {
        return reply.code(404).send({ error: 'No active trading account found' });
      }

      // Calculate totals
      const maxProfit = legs.reduce((sum, leg) => sum + (leg.maxProfit || 0), 0);
      const maxLoss = legs.reduce((sum, leg) => sum + (leg.maxLoss || 0), 0);
      const netDebit = legs.reduce((sum, leg) => sum + (leg.debit || 0), 0);
      const netCredit = legs.reduce((sum, leg) => sum + (leg.credit || 0), 0);

      const now = new Date().toISOString();

      const result = db.prepare(`
        INSERT INTO trading_options_strategies (
          trading_account_id, name, strategy_type, legs, max_profit,
          max_loss, net_debit, net_credit, status, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)
      `).run(
        account.id,
        name,
        strategyType,
        JSON.stringify(legs),
        maxProfit,
        maxLoss,
        netDebit,
        netCredit,
        notes || null,
        now
      );

      const strategy = {
        id: result.lastInsertRowid,
        trading_account_id: account.id,
        name,
        strategy_type: strategyType,
        legs,
        max_profit: maxProfit,
        max_loss: maxLoss,
        net_debit: netDebit,
        net_credit: netCredit,
        status: 'planned',
        notes: notes || null,
        created_at: now
      };

      return reply.send({ strategy });
    } catch (error) {
      console.error('[Trading Options] Create strategy error:', error);
      return reply.code(500).send({ error: error.message || 'Failed to create strategy' });
    }
  });

  // 10. PUT Update Strategy
  fastify.put('/api/ext/trading/options/strategies/:id', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { id } = request.params;
      const { name, legs, status, notes } = request.body;

      // Get active trading account
      const account = db.prepare(`
        SELECT id FROM trading_accounts
        WHERE user_id = ? AND is_active = 1
      `).get(userId);

      if (!account) {
        return reply.code(404).send({ error: 'No active trading account found' });
      }

      // Check strategy exists and belongs to user
      const existing = db.prepare(`
        SELECT id FROM trading_options_strategies
        WHERE id = ? AND trading_account_id = ?
      `).get(id, account.id);

      if (!existing) {
        return reply.code(404).send({ error: 'Strategy not found' });
      }

      // Build update query
      const updates = [];
      const params = [];

      if (name !== undefined) {
        updates.push('name = ?');
        params.push(name);
      }

      if (legs !== undefined) {
        updates.push('legs = ?');
        params.push(JSON.stringify(legs));

        // Recalculate totals
        const maxProfit = legs.reduce((sum, leg) => sum + (leg.maxProfit || 0), 0);
        const maxLoss = legs.reduce((sum, leg) => sum + (leg.maxLoss || 0), 0);
        const netDebit = legs.reduce((sum, leg) => sum + (leg.debit || 0), 0);
        const netCredit = legs.reduce((sum, leg) => sum + (leg.credit || 0), 0);

        updates.push('max_profit = ?', 'max_loss = ?', 'net_debit = ?', 'net_credit = ?');
        params.push(maxProfit, maxLoss, netDebit, netCredit);
      }

      if (status !== undefined) {
        updates.push('status = ?');
        params.push(status);
      }

      if (notes !== undefined) {
        updates.push('notes = ?');
        params.push(notes);
      }

      if (updates.length === 0) {
        return reply.code(400).send({ error: 'No fields to update' });
      }

      params.push(id);

      db.prepare(`
        UPDATE trading_options_strategies
        SET ${updates.join(', ')}
        WHERE id = ?
      `).run(...params);

      // Return updated strategy
      const updated = db.prepare(`
        SELECT * FROM trading_options_strategies WHERE id = ?
      `).get(id);

      return reply.send({
        strategy: {
          ...updated,
          legs: JSON.parse(updated.legs || '[]')
        }
      });
    } catch (error) {
      console.error('[Trading Options] Update strategy error:', error);
      return reply.code(500).send({ error: error.message || 'Failed to update strategy' });
    }
  });

  // 11. DELETE Strategy
  fastify.delete('/api/ext/trading/options/strategies/:id', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { id } = request.params;

      // Get active trading account
      const account = db.prepare(`
        SELECT id FROM trading_accounts
        WHERE user_id = ? AND is_active = 1
      `).get(userId);

      if (!account) {
        return reply.code(404).send({ error: 'No active trading account found' });
      }

      // Check strategy exists and belongs to user
      const existing = db.prepare(`
        SELECT id FROM trading_options_strategies
        WHERE id = ? AND trading_account_id = ?
      `).get(id, account.id);

      if (!existing) {
        return reply.code(404).send({ error: 'Strategy not found' });
      }

      db.prepare(`DELETE FROM trading_options_strategies WHERE id = ?`).run(id);

      return reply.send({ success: true });
    } catch (error) {
      console.error('[Trading Options] Delete strategy error:', error);
      return reply.code(500).send({ error: error.message || 'Failed to delete strategy' });
    }
  });

  // 12. GET Options Analytics
  fastify.get('/api/ext/trading/options/analytics', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const { period = '30d' } = request.query;

      // Get active trading account
      const account = db.prepare(`
        SELECT id FROM trading_accounts
        WHERE user_id = ? AND is_active = 1
      `).get(userId);

      if (!account) {
        return reply.code(404).send({ error: 'No active trading account found' });
      }

      // Calculate date range
      const now = new Date();
      let startDate;

      switch (period) {
        case '7d':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        case '90d':
          startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
          break;
        default:
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      }

      const startDateStr = startDate.toISOString();

      // Get analytics data
      const totalTrades = db.prepare(`
        SELECT COUNT(*) as count FROM trading_options_orders
        WHERE trading_account_id = ? AND placed_at >= ?
      `).get(account.id, startDateStr)?.count || 0;

      const winningTrades = db.prepare(`
        SELECT COUNT(*) as count FROM trading_options_orders
        WHERE trading_account_id = ? AND placed_at >= ? AND filled_price > limit_price
      `).get(account.id, startDateStr)?.count || 0;

      const totalPL = db.prepare(`
        SELECT SUM(unrealized_pl) as total FROM trading_options_positions
        WHERE trading_account_id = ?
      `).get(account.id)?.total || 0;

      const avgDelta = db.prepare(`
        SELECT AVG(delta) as avg FROM trading_options_positions
        WHERE trading_account_id = ? AND delta IS NOT NULL
      `).get(account.id)?.avg || 0;

      const avgTheta = db.prepare(`
        SELECT AVG(theta) as avg FROM trading_options_positions
        WHERE trading_account_id = ? AND theta IS NOT NULL
      `).get(account.id)?.avg || 0;

      const mostTradedSymbols = db.prepare(`
        SELECT symbol, COUNT(*) as count
        FROM trading_options_orders
        WHERE trading_account_id = ? AND placed_at >= ?
        GROUP BY symbol
        ORDER BY count DESC
        LIMIT 5
      `).all(account.id, startDateStr);

      const analytics = {
        period,
        totalTrades,
        winningTrades,
        winRate: totalTrades > 0 ? ((winningTrades / totalTrades) * 100).toFixed(2) : 0,
        totalPL: totalPL.toFixed(2),
        avgDelta: avgDelta.toFixed(4),
        avgTheta: avgTheta.toFixed(4),
        mostTradedSymbols
      };

      // Save analytics snapshot
      const analyticsStr = JSON.stringify(analytics);
      const nowStr = new Date().toISOString();

      db.prepare(`
        INSERT INTO trading_options_analytics (
          trading_account_id, period, total_trades, winning_trades,
          total_pl, avg_delta, avg_theta, analytics_data, calculated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        account.id,
        period,
        totalTrades,
        winningTrades,
        totalPL,
        avgDelta,
        avgTheta,
        analyticsStr,
        nowStr
      );

      return reply.send({ analytics });
    } catch (error) {
      console.error('[Trading Options] Get analytics error:', error);
      return reply.code(500).send({ error: error.message || 'Failed to fetch analytics' });
    }
  });

  console.log('[Trading] ✅ 39 trading routes registered (27 stock + 12 options)');
}
