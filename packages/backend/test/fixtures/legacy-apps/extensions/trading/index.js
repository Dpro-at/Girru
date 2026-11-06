/**
 * Trading Extension - Entry Point
 *
 * Complete stock & crypto trading system with AI-powered strategies
 *
 * Features:
 * - Manual Trading (Paper + Live)
 * - AI Assistant Mode (chat-based suggestions)
 * - Semi-Automated Trading (AI signals + user approval)
 * - Fully Automated Trading (AI executes autonomously)
 * - 4 Built-in Strategies: MA Crossover, RSI, Breakout, AI-Powered
 * - Real-time WebSocket price updates
 * - Multi-platform support (Alpaca MVP, Binance/IBKR future)
 *
 * ⚠️ PURE JAVASCRIPT ONLY - NO TYPESCRIPT
 */

import { registerTradingRoutes } from './src/routes.js';
import { tradingExecuteTool, tradingAnalyzeTool } from './src/tool.js';
import { startPortfolioSync, stopPortfolioSync } from './src/portfolio-sync.js';
import { startStrategyRunner, stopStrategyRunner } from './src/trading-bot.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default {
  id: 'trading',
  name: 'Stock & Crypto Trading',
  version: '1.0.0',

  /**
   * Called when extension is enabled at startup
   * @param {ExtensionApi} api - Extension API interface
   */
  async register(api) {
    api.log('info', 'Trading Extension starting...');

    try {
      // 1. Run database migrations
      api.log('info', 'Running database migrations...');
      await api.runMigrations([
        join(__dirname, 'migrations', '001_trading_tables.sql'),
      ]);
      api.log('info', 'Database migrations completed');

      // 2. Register API routes
      api.log('info', 'Registering API routes...');
      api.registerRoutes(registerTradingRoutes);
      api.log('info', 'API routes registered (25 endpoints)');

      // 3. Register AI tools
      api.log('info', 'Registering AI tools...');
      api.registerTool(tradingExecuteTool);
      api.registerTool(tradingAnalyzeTool);
      api.log('info', 'AI tools registered: trading_execute, trading_analyze');

      // 4. Start background services
      api.log('info', 'Starting background services...');

      // Portfolio sync (every 1 minute)
      startPortfolioSync(api);
      api.log('info', 'Portfolio sync service started (60s interval)');

      // Strategy runner (every 1 minute)
      startStrategyRunner(api);
      api.log('info', 'Strategy runner service started (60s interval)');

      api.log('info', '✅ Trading Extension ready - All systems operational');
      api.log('info', '   - Manual Trading: ✓');
      api.log('info', '   - AI Assistant: ✓');
      api.log('info', '   - Semi-Auto Trading: ✓');
      api.log('info', '   - Full-Auto Trading: ✓');
      api.log('info', '   - Real-time WebSocket: ✓');
      api.log('info', '   - Paper + Live Trading: ✓');

    } catch (error) {
      api.log('error', `Failed to initialize Trading Extension: ${error.message}`);
      api.log('error', error.stack);
      throw error;
    }
  },

  /**
   * Called when extension is disabled
   * @param {ExtensionApi} api - Extension API interface
   */
  async onDisable(api) {
    api.log('info', 'Trading Extension shutting down...');

    try {
      // Stop background services
      stopPortfolioSync();
      stopStrategyRunner();
      api.log('info', 'Background services stopped');

      // Unregister tools
      api.unregisterTool('trading_execute');
      api.unregisterTool('trading_analyze');
      api.log('info', 'AI tools unregistered');

      api.log('info', '✅ Trading Extension disabled cleanly');

    } catch (error) {
      api.log('error', `Error during shutdown: ${error.message}`);
    }
  },
};
