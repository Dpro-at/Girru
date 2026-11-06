/**
 * Trading Extension - Portfolio Sync Service
 *
 * Background service that automatically syncs portfolio data from Alpaca every 1 minute
 *
 * Features:
 * - Fetches account info (cash, equity, buying power)
 * - Fetches current positions (holdings)
 * - Saves snapshots to database for historical tracking
 * - Updates last_synced_at timestamp
 * - Runs for all active accounts
 * - Error handling per account (one failure doesn't stop others)
 */

import {
  createAlpacaClient,
  getAccountInfo,
  getPositions,
  isMarketOpen,
} from './alpaca-client.js';
import { randomBytes } from 'crypto';

let syncInterval = null;
let apiRef = null;

/**
 * Start portfolio sync service
 * @param {ExtensionApi} api - Extension API
 */
export function startPortfolioSync(api) {
  apiRef = api;

  // Run immediately on startup
  syncAllAccounts();

  // Then run every 1 minute (60000ms)
  syncInterval = setInterval(() => {
    syncAllAccounts();
  }, 60000);

  api.log('info', '✅ Portfolio sync service started (1 minute interval)');
}

/**
 * Stop portfolio sync service
 */
export function stopPortfolioSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
    if (apiRef) {
      apiRef.log('info', 'Portfolio sync service stopped');
    }
  }
}

/**
 * Sync all active accounts
 */
async function syncAllAccounts() {
  if (!apiRef) return;

  const api = apiRef;
  const db = api.db;
  const credentialManager = api.credentialManager;

  try {
    // Get all active accounts
    const accounts = db
      .prepare(
        `
      SELECT
        id, user_id, platform, account_name, account_mode,
        api_key_credential_id, api_secret_credential_id
      FROM trading_accounts
      WHERE is_active = 1
    `
      )
      .all();

    if (accounts.length === 0) {
      return; // No accounts to sync
    }

    api.log('info', `🔄 Syncing ${accounts.length} trading account(s)...`);

    let successCount = 0;
    let failureCount = 0;

    // Sync each account
    for (const account of accounts) {
      try {
        await syncAccount(api, db, credentialManager, account);
        successCount++;
      } catch (error) {
        failureCount++;
        api.log(
          'error',
          `Failed to sync account ${account.account_name}: ${error.message}`
        );
      }
    }

    api.log(
      'info',
      `✅ Portfolio sync complete: ${successCount} success, ${failureCount} failed`
    );
  } catch (error) {
    api.log('error', `Portfolio sync error: ${error.message}`);
  }
}

/**
 * Sync single account
 * @param {ExtensionApi} api - Extension API
 * @param {Database} db - Database instance
 * @param {CredentialManager} credentialManager - Credential manager
 * @param {Object} account - Account record
 */
async function syncAccount(api, db, credentialManager, account) {
  // Decrypt credentials
  const apiKey = await credentialManager.getValue(account.api_key_credential_id);
  const apiSecret = await credentialManager.getValue(account.api_secret_credential_id);

  // Create Alpaca client
  const alpaca = createAlpacaClient(apiKey, apiSecret, account.account_mode);

  // Check if market is open (optional optimization)
  const marketOpen = await isMarketOpen(alpaca);

  // Fetch account info
  const accountInfo = await getAccountInfo(alpaca);

  // Fetch positions
  const positions = await getPositions(alpaca);

  const now = new Date().toISOString();

  // ============================================================================
  // Save Portfolio Snapshot
  // ============================================================================

  const snapshotId = randomBytes(16).toString('hex');

  // Calculate P&L (if we have previous snapshot)
  const previousSnapshot = db
    .prepare(
      `
    SELECT portfolio_value
    FROM trading_portfolio_snapshots
    WHERE trading_account_id = ?
    ORDER BY snapshot_at DESC
    LIMIT 1
  `
    )
    .get(account.id);

  let profitLoss = null;
  let profitLossPercent = null;

  if (previousSnapshot && previousSnapshot.portfolio_value > 0) {
    profitLoss = accountInfo.portfolio_value - previousSnapshot.portfolio_value;
    profitLossPercent = (profitLoss / previousSnapshot.portfolio_value) * 100;
  }

  db.prepare(
    `
    INSERT INTO trading_portfolio_snapshots (
      id, trading_account_id, cash, portfolio_value, equity, buying_power,
      profit_loss, profit_loss_percent, snapshot_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    snapshotId,
    account.id,
    accountInfo.cash,
    accountInfo.portfolio_value,
    accountInfo.equity,
    accountInfo.buying_power,
    profitLoss,
    profitLossPercent,
    now
  );

  // ============================================================================
  // Update Positions
  // ============================================================================

  // Clear old positions
  db.prepare('DELETE FROM trading_positions WHERE trading_account_id = ?').run(
    account.id
  );

  // Insert current positions
  for (const pos of positions) {
    const posId = randomBytes(16).toString('hex');

    db.prepare(
      `
      INSERT INTO trading_positions (
        id, trading_account_id, symbol, asset_class, qty, avg_entry_price,
        current_price, market_value, unrealized_pl, unrealized_plpc, side,
        updated_at
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

  // ============================================================================
  // Update Account Metadata
  // ============================================================================

  db.prepare(
    `
    UPDATE trading_accounts
    SET
      alpaca_account_id = ?,
      account_status = ?,
      account_blocked = ?,
      trade_suspended_by_user = ?,
      last_synced_at = ?,
      updated_at = ?
    WHERE id = ?
  `
  ).run(
    accountInfo.id,
    accountInfo.status,
    accountInfo.account_blocked ? 1 : 0,
    accountInfo.trade_suspended_by_user ? 1 : 0,
    now,
    now,
    account.id
  );

  api.log(
    'info',
    `✅ Synced ${account.account_name}: $${accountInfo.portfolio_value.toFixed(2)} | ${positions.length} positions | Market ${marketOpen ? 'OPEN' : 'CLOSED'}`
  );
}

/**
 * Sync specific account by ID (for manual sync endpoint)
 * @param {ExtensionApi} api - Extension API
 * @param {string} accountId - Account ID
 */
export async function syncAccountById(api, accountId) {
  const db = api.db;
  const credentialManager = api.credentialManager;

  const account = db
    .prepare(
      `
    SELECT
      id, user_id, platform, account_name, account_mode,
      api_key_credential_id, api_secret_credential_id
    FROM trading_accounts
    WHERE id = ?
  `
    )
    .get(accountId);

  if (!account) {
    throw new Error('Account not found');
  }

  await syncAccount(api, db, credentialManager, account);
}
