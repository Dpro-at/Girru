'use client';

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { config } from '@/lib/config';
import dynamic from 'next/dynamic';
import {
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Plus,
  DollarSign,
  Wallet,
  PieChart,
  Activity,
  PlayCircle,
  StopCircle,
  Target,
  AlertCircle,
  Search,
  X,
  Calculator,
  CheckCircle,
  Maximize,
  BarChart3,
  CandlestickChart,
  LineChart,
  Wifi,
  WifiOff,
} from 'lucide-react';

// Dynamic import for TradingView widget (client-side only)
const TradingViewWidget = dynamic(
  () => import('react-tradingview-embed').then((mod) => mod.default),
  { ssr: false }
);

// Tab Components
import { AnalyticsTab } from './analytics-tab';
import { WatchlistTab } from './watchlist-tab';
import { NewsTab } from './news-tab';
import { OptionsTab } from './options-tab';

/**
 * Trading Dashboard Page
 *
 * Complete stock and crypto trading interface with:
 * - Account management (connect Alpaca accounts)
 * - Portfolio overview (cash, equity, buying power, P&L)
 * - Positions (current holdings)
 * - Order management (place orders, view history)
 * - AI Trading strategies (3 modes: Assistant, Semi-Auto, Full-Auto)
 */

export default function TradingPage() {
  // Auth helper
  const authHeaders = () => {
    const token = localStorage.getItem('auth_token');
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  };

  // State
  const [accounts, setAccounts] = useState([]);
  const [activeAccount, setActiveAccount] = useState(null);
  const [portfolio, setPortfolio] = useState(null);
  const [positions, setPositions] = useState([]);
  const [portfolioSnapshots, setPortfolioSnapshots] = useState([]);
  const [orders, setOrders] = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [signals, setSignals] = useState([]);
  const [watchlist, setWatchlist] = useState([]);
  const [activeTab, setActiveTab] = useState('positions'); // positions, trade, orders, strategies, analytics
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [showConnectDialog, setShowConnectDialog] = useState(false);

  // WebSocket state for real-time updates
  const [wsConnected, setWsConnected] = useState(false);
  const [wsError, setWsError] = useState(null);
  const [realtimePrices, setRealtimePrices] = useState({}); // { symbol: { bid, ask, price, timestamp } }

  // Load data on mount
  useEffect(() => {
    loadAccounts();
  }, []);

  useEffect(() => {
    if (activeAccount) {
      loadPortfolio();
      loadPortfolioSnapshots();
      loadPositions();
      loadOrders();
      loadStrategies();
      loadSignals();
      loadWatchlist();
    }
  }, [activeAccount]);

  // ============================================================================
  // WEBSOCKET REAL-TIME CONNECTION
  // ============================================================================

  useEffect(() => {
    if (!activeAccount || (positions.length === 0 && watchlist.length === 0)) {
      setWsConnected(false);
      setWsError(null);
      return;
    }

    console.log('[WebSocket] Connecting to real-time stream...');
    setWsError(null);

    const token = localStorage.getItem('auth_token');
    const streamUrl = `${config.backendUrl}/api/ext/trading/stream${token ? `?token=${token}` : ''}`;
    const eventSource = new EventSource(streamUrl);

    eventSource.onopen = () => {
      console.log('[WebSocket] Connected');
      setWsConnected(true);
      setWsError(null);
    };

    eventSource.onmessage = (event) => {
      try {
        const update = JSON.parse(event.data);

        if (update.type === 'connected') {
          console.log('[WebSocket] Subscribed to symbols:', update.symbols);
          toast.success(`Real-time updates connected (${update.symbols.length} symbols)`);
        } else if (update.type === 'error') {
          console.error('[WebSocket] Alpaca error:', update.message);
          setWsError(update.message);
          toast.error(update.message);
        } else if (update.type === 'trade' || update.type === 'quote') {
          // Update real-time prices
          setRealtimePrices((prev) => ({
            ...prev,
            [update.symbol]: {
              bid: update.bid || update.price,
              ask: update.ask || update.price,
              price: update.price || (update.bid + update.ask) / 2,
              timestamp: update.timestamp,
            },
          }));

          // Update positions with new prices
          setPositions((prev) =>
            prev.map((pos) => {
              if (pos.symbol === update.symbol) {
                const newPrice = update.price || (update.bid + update.ask) / 2;
                const marketValue = pos.qty * newPrice;
                const unrealizedPL = (newPrice - pos.avg_entry_price) * pos.qty;
                const unrealizedPLPC = ((newPrice - pos.avg_entry_price) / pos.avg_entry_price) * 100;

                return {
                  ...pos,
                  current_price: newPrice,
                  market_value: marketValue,
                  unrealized_pl: unrealizedPL,
                  unrealized_plpc: unrealizedPLPC,
                };
              }
              return pos;
            })
          );
        }
      } catch (error) {
        console.error('[WebSocket] Parse error:', error);
      }
    };

    eventSource.onerror = (error) => {
      console.error('[WebSocket] Connection error:', error);
      setWsConnected(false);
      setWsError('Connection lost');
      eventSource.close();

      // Auto-reconnect after 5 seconds
      setTimeout(() => {
        console.log('[WebSocket] Reconnecting...');
        setWsError(null);
      }, 5000);
    };

    // Cleanup on unmount or dependency change
    return () => {
      console.log('[WebSocket] Disconnecting');
      eventSource.close();
      setWsConnected(false);
    };
  }, [activeAccount, positions.length, watchlist.length]);

  // ============================================================================
  // DATA LOADING
  // ============================================================================

  async function loadAccounts() {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/accounts`, {
        headers: authHeaders(),
      });

      if (!res.ok) throw new Error('Failed to load accounts');

      const data = await res.json();
      setAccounts(data.accounts || []);

      // Set active account (default or first)
      const defaultAccount = data.accounts?.find((a) => a.is_default) || data.accounts?.[0];
      setActiveAccount(defaultAccount || null);

      setLoading(false);
    } catch (error) {
      console.error('Load accounts error:', error);
      toast.error('Failed to load accounts');
      setLoading(false);
    }
  }

  async function loadPortfolio() {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/portfolio`, {
        headers: authHeaders(),
      });

      if (!res.ok) throw new Error('Failed to load portfolio');

      const data = await res.json();
      setPortfolio(data.portfolio);
    } catch (error) {
      console.error('Load portfolio error:', error);
    }
  }

  async function loadPortfolioSnapshots() {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/portfolio/snapshots?days=90`, {
        headers: authHeaders(),
      });

      if (!res.ok) throw new Error('Failed to load portfolio history');

      const data = await res.json();
      setPortfolioSnapshots(data.snapshots || []);
    } catch (error) {
      console.error('Load portfolio snapshots error:', error);
    }
  }

  async function loadPositions() {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/positions`, {
        headers: authHeaders(),
      });

      if (!res.ok) throw new Error('Failed to load positions');

      const data = await res.json();
      setPositions(data.positions || []);
    } catch (error) {
      console.error('Load positions error:', error);
    }
  }

  async function loadOrders() {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/orders?status=all&limit=50`, {
        headers: authHeaders(),
      });

      if (!res.ok) throw new Error('Failed to load orders');

      const data = await res.json();
      setOrders(data.orders || []);
    } catch (error) {
      console.error('Load orders error:', error);
    }
  }

  async function loadStrategies() {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/strategies`, {
        headers: authHeaders(),
      });

      if (!res.ok) throw new Error('Failed to load strategies');

      const data = await res.json();
      setStrategies(data.strategies || []);
    } catch (error) {
      console.error('Load strategies error:', error);
    }
  }

  async function loadSignals() {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/signals?status=pending`, {
        headers: authHeaders(),
      });

      if (!res.ok) throw new Error('Failed to load signals');

      const data = await res.json();
      setSignals(data.signals || []);
    } catch (error) {
      console.error('Load signals error:', error);
    }
  }

  async function loadWatchlist() {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/watchlist`, {
        headers: authHeaders(),
      });

      if (!res.ok) throw new Error('Failed to load watchlist');

      const data = await res.json();
      setWatchlist(data.watchlist || []);
    } catch (error) {
      console.error('Load watchlist error:', error);
    }
  }

  // ============================================================================
  // ACTIONS
  // ============================================================================

  async function handleSync() {
    setSyncing(true);
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/sync`, {
        method: 'POST',
        headers: authHeaders(),
      });

      if (!res.ok) throw new Error('Sync failed');

      toast.success('Portfolio synced successfully');
      loadPortfolio();
      loadPositions();
    } catch (error) {
      console.error('Sync error:', error);
      toast.error('Failed to sync portfolio');
    } finally {
      setSyncing(false);
    }
  }

  async function handlePlaceOrder(orderData) {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/orders`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(orderData),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to place order');
      }

      const data = await res.json();
      toast.success(`Order placed: ${orderData.side.toUpperCase()} ${orderData.qty} ${orderData.symbol}`);

      loadOrders();
      loadPositions();
      loadPortfolio();

      return data;
    } catch (error) {
      console.error('Place order error:', error);
      toast.error(error.message);
      throw error;
    }
  }

  async function handleSellPosition(symbol, qty) {
    try {
      const orderData = {
        symbol,
        qty,
        side: 'sell',
        order_type: 'market',
        time_in_force: 'day',
      };

      await handlePlaceOrder(orderData);
      toast.success(`Sold ${qty} shares of ${symbol}`);
    } catch (error) {
      console.error('Sell position error:', error);
      toast.error('Failed to sell position');
    }
  }

  async function handleCancelOrder(orderId) {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/orders/${orderId}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });

      if (!res.ok) throw new Error('Failed to cancel order');

      toast.success('Order cancelled');
      loadOrders();
    } catch (error) {
      console.error('Cancel order error:', error);
      toast.error('Failed to cancel order');
    }
  }

  async function handleStartStrategy(strategyId) {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/strategies/${strategyId}/start`, {
        method: 'POST',
        headers: authHeaders(),
      });

      if (!res.ok) throw new Error('Failed to start strategy');

      toast.success('Strategy started');
      loadStrategies();
    } catch (error) {
      console.error('Start strategy error:', error);
      toast.error(error.message);
    }
  }

  async function handleStopStrategy(strategyId) {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/strategies/${strategyId}/stop`, {
        method: 'POST',
        headers: authHeaders(),
      });

      if (!res.ok) throw new Error('Failed to stop strategy');

      toast.success('Strategy stopped');
      loadStrategies();
    } catch (error) {
      console.error('Stop strategy error:', error);
      toast.error('Failed to stop strategy');
    }
  }

  async function handleExecuteSignal(signalId) {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/signals/${signalId}/execute`, {
        method: 'POST',
        headers: authHeaders(),
      });

      if (!res.ok) throw new Error('Failed to execute signal');

      toast.success('Signal executed');
      loadSignals();
      loadOrders();
      loadPositions();
    } catch (error) {
      console.error('Execute signal error:', error);
      toast.error(error.message);
    }
  }

  async function handleRejectSignal(signalId) {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/signals/${signalId}/reject`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason: 'User rejected' }),
      });

      if (!res.ok) throw new Error('Failed to reject signal');

      toast.success('Signal rejected');
      loadSignals();
    } catch (error) {
      console.error('Reject signal error:', error);
      toast.error('Failed to reject signal');
    }
  }

  // ============================================================================
  // RENDER
  // ============================================================================

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!activeAccount) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-md mx-auto text-center">
          <TrendingUp className="w-16 h-16 mx-auto mb-4 text-gray-400" />
          <h1 className="text-2xl font-bold mb-2">No Trading Account Connected</h1>
          <p className="text-gray-600 mb-6">
            Connect your Alpaca account to start trading stocks and cryptocurrencies.
          </p>
          <button
            onClick={() => setShowConnectDialog(true)}
            className="inline-flex items-center px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus className="w-5 h-5 mr-2" />
            Connect Account
          </button>
        </div>

        {showConnectDialog && (
          <ConnectAccountDialog
            onClose={() => setShowConnectDialog(false)}
            onSuccess={() => {
              setShowConnectDialog(false);
              loadAccounts();
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="container mx-auto px-2 sm:px-4 py-4 sm:py-6 space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-0">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <TrendingUp className="w-6 h-6 sm:w-8 sm:h-8 text-blue-600 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-bold">Trading</h1>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <span className="text-xs sm:text-sm text-gray-600 truncate">{activeAccount.account_name}</span>
              <span
                className={`px-2 py-0.5 text-xs font-medium rounded flex-shrink-0 ${
                  activeAccount.account_mode === 'paper'
                    ? 'bg-green-100 text-green-800'
                    : 'bg-red-100 text-red-800'
                }`}
              >
                {activeAccount.account_mode === 'paper' ? 'Paper' : 'Live'}
              </span>

              {/* WebSocket Connection Status */}
              {(positions.length > 0 || watchlist.length > 0) && (
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {wsConnected ? (
                    <>
                      <Wifi className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-green-600" />
                      <span className="text-xs text-green-600 font-medium">Live</span>
                    </>
                  ) : wsError ? (
                    <>
                      <WifiOff className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-red-600" />
                      <span className="text-xs text-red-600 font-medium hidden sm:inline">{wsError}</span>
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-gray-400 animate-spin" />
                      <span className="text-xs text-gray-400 font-medium hidden sm:inline">Connecting...</span>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleSync}
            disabled={syncing}
            className="inline-flex items-center justify-center px-3 sm:px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 flex-1 sm:flex-initial text-sm"
          >
            <RefreshCw className={`w-4 h-4 sm:mr-2 ${syncing ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Sync</span>
          </button>
          <button
            onClick={() => setShowConnectDialog(true)}
            className="inline-flex items-center justify-center px-3 sm:px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex-1 sm:flex-initial text-sm"
          >
            <Plus className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Connect Account</span>
          </button>
        </div>
      </div>

      {/* Warning */}
      {activeAccount.account_mode === 'live' && (
        <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
          <AlertCircle className="w-5 h-5 text-red-600 mt-0.5" />
          <div className="text-sm text-red-800">
            <strong>Live Trading Mode:</strong> You are trading with real money. All orders will
            be executed immediately. Please trade responsibly.
          </div>
        </div>
      )}

      {/* Portfolio Overview */}
      {portfolio && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <MetricCard
            icon={<DollarSign className="w-5 h-5" />}
            label="Cash"
            value={`$${portfolio.cash.toFixed(2)}`}
            color="blue"
          />
          <MetricCard
            icon={<PieChart className="w-5 h-5" />}
            label="Portfolio Value"
            value={`$${portfolio.portfolio_value.toFixed(2)}`}
            color="purple"
          />
          <MetricCard
            icon={<Wallet className="w-5 h-5" />}
            label="Buying Power"
            value={`$${portfolio.buying_power.toFixed(2)}`}
            color="green"
          />
          <MetricCard
            icon={<Activity className="w-5 h-5" />}
            label="Equity"
            value={`$${portfolio.equity.toFixed(2)}`}
            color="orange"
          />
        </div>
      )}

      {/* Pending Signals Alert */}
      {signals.length > 0 && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <div className="flex items-center gap-3">
            <Target className="w-5 h-5 text-blue-600 flex-shrink-0" />
            <div>
              <p className="font-medium text-blue-900 text-sm sm:text-base">
                {signals.length} Pending Trading Signal{signals.length > 1 ? 's' : ''}
              </p>
              <p className="text-xs sm:text-sm text-blue-700">AI strategy generated new trading opportunities</p>
            </div>
          </div>
          <button
            onClick={() => setActiveTab('strategies')}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm w-full sm:w-auto"
          >
            Review Signals
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-gray-200 -mx-2 sm:mx-0">
        <div className="flex space-x-4 sm:space-x-8 overflow-x-auto px-2 sm:px-0 scrollbar-hide">
          {['positions', 'trade', 'orders', 'options', 'watchlist', 'news', 'strategies', 'analytics'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap flex-shrink-0 ${
                activeTab === tab
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3 sm:p-6">
        {activeTab === 'positions' && (
          <PositionsTab positions={positions} onSellPosition={handleSellPosition} />
        )}
        {activeTab === 'trade' && (
          <TradeTab onPlaceOrder={handlePlaceOrder} watchlist={watchlist} portfolio={portfolio} />
        )}
        {activeTab === 'orders' && <OrdersTab orders={orders} onCancel={handleCancelOrder} />}
        {activeTab === 'options' && <OptionsTab />}
        {activeTab === 'watchlist' && <WatchlistTab priceUpdates={realtimePrices} />}
        {activeTab === 'news' && <NewsTab />}
        {activeTab === 'strategies' && (
          <StrategiesTab
            strategies={strategies}
            signals={signals}
            onStartStrategy={handleStartStrategy}
            onStopStrategy={handleStopStrategy}
            onExecuteSignal={handleExecuteSignal}
            onRejectSignal={handleRejectSignal}
          />
        )}
        {activeTab === 'analytics' && (
          <AnalyticsTab
            positions={positions}
            portfolioSnapshots={portfolioSnapshots}
            portfolio={portfolio}
          />
        )}
      </div>

      {showConnectDialog && (
        <ConnectAccountDialog
          onClose={() => setShowConnectDialog(false)}
          onSuccess={() => {
            setShowConnectDialog(false);
            loadAccounts();
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// COMPONENTS
// ============================================================================

function MetricCard({ icon, label, value, color }) {
  const colors = {
    blue: 'bg-blue-50 text-blue-600',
    purple: 'bg-purple-50 text-purple-600',
    green: 'bg-green-50 text-green-600',
    orange: 'bg-orange-50 text-orange-600',
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-gray-600">{label}</span>
        <div className={`p-2 rounded-lg ${colors[color]}`}>{icon}</div>
      </div>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}

// Position Details Modal Component
function PositionDetailsModal({ position, onClose, onSell }) {
  const [sellQty, setSellQty] = useState('');
  const [priceHistory, setPriceHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [showTransactions, setShowTransactions] = useState(false);

  const costBasis = parseFloat(position.qty) * position.avg_entry_price;
  const totalReturn = ((position.current_price - position.avg_entry_price) / position.avg_entry_price) * 100;
  const todaysPL = position.change_today || 0;

  // Load price history (mock data for now - in production, fetch from Alpaca API)
  useEffect(() => {
    // Simulate loading 30-day price history
    setTimeout(() => {
      const mockHistory = [];
      const basePrice = position.avg_entry_price;
      for (let i = 30; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const variance = (Math.random() - 0.5) * basePrice * 0.1; // +/- 10% variance
        mockHistory.push({
          date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          price: basePrice + variance + (position.current_price - basePrice) * ((30 - i) / 30),
        });
      }
      setPriceHistory(mockHistory);
      setLoadingHistory(false);
    }, 500);
  }, [position]);

  async function handleQuickSell(percentage) {
    const qtyToSell = (parseFloat(position.qty) * percentage) / 100;
    const confirmMsg = `Sell ${percentage}% (${qtyToSell.toFixed(2)} shares) of ${position.symbol}?`;
    if (window.confirm(confirmMsg)) {
      await onSell(position.symbol, qtyToSell);
      onClose();
    }
  }

  async function handleCustomSell() {
    const qty = parseFloat(sellQty);
    if (isNaN(qty) || qty <= 0 || qty > parseFloat(position.qty)) {
      toast.error('Invalid quantity');
      return;
    }
    const confirmMsg = `Sell ${qty.toFixed(2)} shares of ${position.symbol}?`;
    if (window.confirm(confirmMsg)) {
      await onSell(position.symbol, qty);
      onClose();
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-gradient-to-r from-blue-600 to-indigo-600 text-white px-6 py-4 rounded-t-lg">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold">{position.symbol}</h2>
              <p className="text-blue-100 text-sm">{parseFloat(position.qty).toFixed(2)} shares</p>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-white/20 rounded-lg transition-colors"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Position Summary */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-sm text-gray-600 mb-1">Avg Entry Price</p>
              <p className="text-2xl font-bold text-gray-900">${position.avg_entry_price.toFixed(2)}</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-sm text-gray-600 mb-1">Current Price</p>
              <p className="text-2xl font-bold text-gray-900">${position.current_price.toFixed(2)}</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-sm text-gray-600 mb-1">Market Value</p>
              <p className="text-2xl font-bold text-gray-900">${position.market_value.toFixed(2)}</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-sm text-gray-600 mb-1">Cost Basis</p>
              <p className="text-2xl font-bold text-gray-900">${costBasis.toFixed(2)}</p>
            </div>
          </div>

          {/* P/L Summary */}
          <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-4 border border-blue-200">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-gray-600 mb-1">Today's P/L</p>
                <div className="flex items-center gap-2">
                  {todaysPL >= 0 ? (
                    <TrendingUp className="w-5 h-5 text-green-600" />
                  ) : (
                    <TrendingDown className="w-5 h-5 text-red-600" />
                  )}
                  <span className={`text-xl font-bold ${todaysPL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    ${Math.abs(todaysPL).toFixed(2)}
                  </span>
                </div>
              </div>
              <div>
                <p className="text-sm text-gray-600 mb-1">Total P/L</p>
                <div className="flex items-center gap-2">
                  {position.unrealized_pl >= 0 ? (
                    <TrendingUp className="w-5 h-5 text-green-600" />
                  ) : (
                    <TrendingDown className="w-5 h-5 text-red-600" />
                  )}
                  <div className="flex flex-col">
                    <span className={`text-xl font-bold ${position.unrealized_pl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      ${Math.abs(position.unrealized_pl).toFixed(2)}
                    </span>
                    <span className={`text-sm ${position.unrealized_pl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {totalReturn >= 0 ? '+' : ''}{totalReturn.toFixed(2)}%
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Mini Price Chart */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-3">30-Day Price History</h3>
            {loadingHistory ? (
              <div className="h-48 bg-gray-50 rounded-lg flex items-center justify-center">
                <RefreshCw className="w-6 h-6 text-gray-400 animate-spin" />
              </div>
            ) : (
              <div className="h-48 bg-gray-50 rounded-lg p-4">
                {/* Simple line representation (in production, use recharts) */}
                <div className="h-full flex items-end gap-1">
                  {priceHistory.map((point, idx) => {
                    const minPrice = Math.min(...priceHistory.map((p) => p.price));
                    const maxPrice = Math.max(...priceHistory.map((p) => p.price));
                    const height = ((point.price - minPrice) / (maxPrice - minPrice)) * 100;
                    const color = point.price >= position.avg_entry_price ? 'bg-green-500' : 'bg-red-500';
                    return (
                      <div
                        key={idx}
                        className={`flex-1 ${color} rounded-t`}
                        style={{ height: `${height}%` }}
                        title={`${point.date}: $${point.price.toFixed(2)}`}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Quick Sell Section */}
          <div className="border-t border-gray-200 pt-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Quick Sell</h3>
            <div className="space-y-3">
              {/* Quick Sell Buttons */}
              <div className="flex gap-2">
                <button
                  onClick={() => handleQuickSell(25)}
                  className="flex-1 px-4 py-2 bg-orange-100 hover:bg-orange-200 text-orange-700 rounded-lg font-medium transition-colors"
                >
                  Sell 25%
                </button>
                <button
                  onClick={() => handleQuickSell(50)}
                  className="flex-1 px-4 py-2 bg-orange-100 hover:bg-orange-200 text-orange-700 rounded-lg font-medium transition-colors"
                >
                  Sell 50%
                </button>
                <button
                  onClick={() => handleQuickSell(100)}
                  className="flex-1 px-4 py-2 bg-red-100 hover:bg-red-200 text-red-700 rounded-lg font-medium transition-colors"
                >
                  Close Position
                </button>
              </div>

              {/* Custom Quantity Sell */}
              <div className="flex gap-2">
                <input
                  type="number"
                  value={sellQty}
                  onChange={(e) => setSellQty(e.target.value)}
                  placeholder="Enter quantity"
                  min="0.01"
                  max={position.qty}
                  step="0.01"
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <button
                  onClick={handleCustomSell}
                  className="px-6 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
                >
                  Sell
                </button>
              </div>
              <p className="text-xs text-gray-500">
                Max: {parseFloat(position.qty).toFixed(2)} shares
              </p>
            </div>
          </div>

          {/* Transaction History Button */}
          <button
            onClick={() => setShowTransactions(!showTransactions)}
            className="w-full px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
          >
            {showTransactions ? 'Hide' : 'View'} Transaction History
            {showTransactions ? '▲' : '▼'}
          </button>

          {/* Transaction History */}
          {showTransactions && (
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-sm text-gray-600 italic">
                Transaction history for {position.symbol} will be fetched from backend API
                (Orders filtered by symbol)
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="bg-gray-50 px-6 py-4 rounded-b-lg border-t border-gray-200">
          <button
            onClick={onClose}
            className="w-full px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-lg font-medium transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function PositionsTab({ positions, onSellPosition }) {
  const [sortBy, setSortBy] = useState('symbol'); // symbol, qty, value, pl, pl_today
  const [sortDirection, setSortDirection] = useState('asc'); // asc, desc
  const [selectedPosition, setSelectedPosition] = useState(null);
  const [sellPercentage, setSellPercentage] = useState(100);

  if (positions.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <PieChart className="w-12 h-12 mx-auto mb-3 opacity-50" />
        <p>No positions yet. Start trading to see your holdings here.</p>
      </div>
    );
  }

  // Sort positions
  const sortedPositions = [...positions].sort((a, b) => {
    let aValue, bValue;

    switch (sortBy) {
      case 'symbol':
        aValue = a.symbol;
        bValue = b.symbol;
        break;
      case 'qty':
        aValue = parseFloat(a.qty);
        bValue = parseFloat(b.qty);
        break;
      case 'value':
        aValue = a.market_value;
        bValue = b.market_value;
        break;
      case 'pl':
        aValue = a.unrealized_pl;
        bValue = b.unrealized_pl;
        break;
      case 'pl_today':
        aValue = a.change_today || 0;
        bValue = b.change_today || 0;
        break;
      default:
        aValue = a.symbol;
        bValue = b.symbol;
    }

    if (sortDirection === 'asc') {
      return aValue > bValue ? 1 : -1;
    } else {
      return aValue < bValue ? 1 : -1;
    }
  });

  // Handle column header click for sorting
  function handleSort(column) {
    if (sortBy === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(column);
      setSortDirection('asc');
    }
  }

  // Handle quick sell buttons
  async function handleQuickSell(position, percentage) {
    const qtyToSell = (parseFloat(position.qty) * percentage) / 100;
    const confirm = window.confirm(
      `Sell ${percentage}% (${qtyToSell.toFixed(2)} shares) of ${position.symbol}?`
    );
    if (confirm && onSellPosition) {
      await onSellPosition(position.symbol, qtyToSell);
    }
  }

  // Sortable column header component
  function SortableHeader({ column, label, align = 'left' }) {
    const isActive = sortBy === column;
    return (
      <th
        className={`px-4 py-3 text-${align} text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 transition-colors`}
        onClick={() => handleSort(column)}
      >
        <div className={`flex items-center gap-1 ${align === 'right' ? 'justify-end' : ''}`}>
          <span>{label}</span>
          {isActive && (
            <span className="text-blue-600">
              {sortDirection === 'asc' ? '↑' : '↓'}
            </span>
          )}
        </div>
      </th>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead>
          <tr className="bg-gray-50">
            <SortableHeader column="symbol" label="Symbol" />
            <SortableHeader column="qty" label="Qty" align="right" />
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Avg Entry</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Current</th>
            <SortableHeader column="value" label="Market Value" align="right" />
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Cost Basis</th>
            <SortableHeader column="pl_today" label="Today's P/L" align="right" />
            <SortableHeader column="pl" label="Total P/L" align="right" />
            <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Actions</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {sortedPositions.map((pos) => {
            const costBasis = parseFloat(pos.qty) * pos.avg_entry_price;
            const todaysPL = pos.change_today || 0; // Today's change (if available from API)
            const todaysPLPercent = todaysPL / costBasis * 100 || 0;

            return (
              <tr
                key={pos.symbol}
                className="hover:bg-blue-50 transition-colors cursor-pointer"
                onClick={() => setSelectedPosition(pos)}
              >
                <td className="px-4 py-3 font-bold text-gray-900">{pos.symbol}</td>
                <td className="px-4 py-3 text-right font-mono">{parseFloat(pos.qty).toFixed(2)}</td>
                <td className="px-4 py-3 text-right font-mono text-gray-600">
                  ${pos.avg_entry_price.toFixed(2)}
                </td>
                <td className="px-4 py-3 text-right font-mono font-medium">
                  ${pos.current_price.toFixed(2)}
                </td>
                <td className="px-4 py-3 text-right font-mono font-bold">
                  ${pos.market_value.toFixed(2)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-gray-600">
                  ${costBasis.toFixed(2)}
                </td>

                {/* Today's P/L */}
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-1">
                    {todaysPL >= 0 ? (
                      <TrendingUp className="w-3.5 h-3.5 text-green-600" />
                    ) : (
                      <TrendingDown className="w-3.5 h-3.5 text-red-600" />
                    )}
                    <span className={`font-mono text-sm ${todaysPL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      ${Math.abs(todaysPL).toFixed(2)}
                    </span>
                  </div>
                </td>

                {/* Total P/L */}
                <td className="px-4 py-3 text-right">
                  <div className="flex flex-col items-end">
                    <div className="flex items-center gap-1">
                      {pos.unrealized_pl >= 0 ? (
                        <TrendingUp className="w-4 h-4 text-green-600" />
                      ) : (
                        <TrendingDown className="w-4 h-4 text-red-600" />
                      )}
                      <span className={`font-mono font-bold ${pos.unrealized_pl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        ${Math.abs(pos.unrealized_pl).toFixed(2)}
                      </span>
                    </div>
                    <span className={`text-xs font-mono ${pos.unrealized_pl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {pos.unrealized_plpc >= 0 ? '+' : ''}{pos.unrealized_plpc.toFixed(2)}%
                    </span>
                  </div>
                </td>

                {/* Quick Action Buttons */}
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-center gap-1">
                    <button
                      onClick={() => handleQuickSell(pos, 25)}
                      className="px-2 py-1 text-xs bg-orange-100 hover:bg-orange-200 text-orange-700 rounded transition-colors"
                      title="Sell 25%"
                    >
                      25%
                    </button>
                    <button
                      onClick={() => handleQuickSell(pos, 50)}
                      className="px-2 py-1 text-xs bg-orange-100 hover:bg-orange-200 text-orange-700 rounded transition-colors"
                      title="Sell 50%"
                    >
                      50%
                    </button>
                    <button
                      onClick={() => handleQuickSell(pos, 100)}
                      className="px-2 py-1 text-xs bg-red-100 hover:bg-red-200 text-red-700 rounded transition-colors font-medium"
                      title="Close Position (Sell 100%)"
                    >
                      All
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Position Details Modal - Full Implementation */}
      {selectedPosition && (
        <PositionDetailsModal
          position={selectedPosition}
          onClose={() => setSelectedPosition(null)}
          onSell={handleSellPosition}
        />
      )}
    </div>
  );
}

// TradingView Chart Component
function TradingViewChart({ symbol }) {
  const [timeframe, setTimeframe] = useState(() => {
    return localStorage.getItem('trading_chart_timeframe') || 'D';
  });
  const [chartType, setChartType] = useState(() => {
    return localStorage.getItem('trading_chart_type') || '1';
  });
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Save settings to localStorage when changed
  useEffect(() => {
    localStorage.setItem('trading_chart_timeframe', timeframe);
  }, [timeframe]);

  useEffect(() => {
    localStorage.setItem('trading_chart_type', chartType);
  }, [chartType]);

  // Convert Alpaca symbol format to TradingView format
  function formatSymbolForTV(symbol) {
    // Crypto symbols: BTC/USD -> BTCUSD, ETH/USD -> ETHUSD
    if (symbol.includes('/')) {
      const base = symbol.split('/')[0];
      return `CRYPTO:${base}USD`;
    }
    // Stock symbols: AAPL -> NASDAQ:AAPL (default to NASDAQ, will auto-correct)
    return `NASDAQ:${symbol}`;
  }

  const tvSymbol = formatSymbolForTV(symbol);

  // Timeframe options
  const timeframes = [
    { value: '1', label: '1m' },
    { value: '5', label: '5m' },
    { value: '15', label: '15m' },
    { value: '60', label: '1h' },
    { value: 'D', label: '1d' },
    { value: 'W', label: '1w' },
    { value: 'M', label: '1M' },
  ];

  // Chart type options (TradingView chart types)
  const chartTypes = [
    { value: '1', label: 'Candlestick', icon: CandlestickChart },
    { value: '0', label: 'Bar', icon: BarChart3 },
    { value: '3', label: 'Line', icon: LineChart },
    { value: '9', label: 'Area', icon: Activity },
  ];

  const currentChartType = chartTypes.find((t) => t.value === chartType) || chartTypes[0];

  return (
    <div className={`bg-white rounded-lg border border-gray-200 overflow-hidden ${
      isFullscreen ? 'fixed inset-0 z-50' : ''
    }`}>
      {/* Chart Controls */}
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center gap-4">
          {/* Chart Type Selector */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-700">Type:</span>
            <div className="flex gap-1">
              {chartTypes.map((type) => {
                const Icon = type.icon;
                return (
                  <button
                    key={type.value}
                    onClick={() => setChartType(type.value)}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 ${
                      chartType === type.value
                        ? 'bg-blue-600 text-white'
                        : 'bg-white text-gray-700 hover:bg-gray-100'
                    }`}
                    title={type.label}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">{type.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Timeframe Selector */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-700">Timeframe:</span>
            <div className="flex gap-1">
              {timeframes.map((tf) => (
                <button
                  key={tf.value}
                  onClick={() => setTimeframe(tf.value)}
                  className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    timeframe === tf.value
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  {tf.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Fullscreen Toggle */}
        <button
          onClick={() => setIsFullscreen(!isFullscreen)}
          className="p-2 rounded-md hover:bg-white text-gray-700 transition-colors"
          title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
        >
          <Maximize className="w-4 h-4" />
        </button>
      </div>

      {/* TradingView Chart Widget */}
      <div className={`bg-white ${isFullscreen ? 'h-[calc(100vh-60px)]' : 'h-[500px]'}`}>
        <TradingViewWidget
          widgetType="widget"
          symbol={tvSymbol}
          interval={timeframe}
          theme="light"
          locale="en"
          timezone="America/New_York"
          style={chartType}
          toolbar_bg="#f1f3f6"
          enable_publishing={false}
          hide_top_toolbar={false}
          hide_legend={false}
          save_image={true}
          container_id="tradingview_chart"
          autosize
        />
      </div>
    </div>
  );
}

// Live Price Display Component
function LivePriceDisplay({ symbol, onPriceChange, realtimePrice }) {
  const [price, setPrice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [priceChange, setPriceChange] = useState(0);

  const authHeaders = () => {
    const token = localStorage.getItem('auth_token');
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  };

  // Update price from WebSocket real-time data
  useEffect(() => {
    if (realtimePrice) {
      const prevPrice = price?.bid_price || 0;
      const newPrice = realtimePrice.bid || realtimePrice.price || 0;
      const change = newPrice - prevPrice;

      setPrice({
        bid_price: realtimePrice.bid,
        ask_price: realtimePrice.ask,
        timestamp: realtimePrice.timestamp,
      });

      setPriceChange(change);

      if (onPriceChange) {
        onPriceChange(newPrice);
      }

      // Auto-clear price change indicator after 2 seconds
      setTimeout(() => setPriceChange(0), 2000);
    }
  }, [realtimePrice]);

  // Fetch live price (fallback when WebSocket not connected)
  async function fetchPrice() {
    if (!symbol) {
      setPrice(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `${config.backendUrl}/api/ext/trading/quote/${symbol}`,
        { headers: authHeaders() }
      );

      if (!res.ok) throw new Error('Failed to fetch price');

      const data = await res.json();

      if (data.quote) {
        // Calculate price change if we have previous price
        if (price && price.ask_price) {
          const change = data.quote.ask_price - price.ask_price;
          setPriceChange(change);
        }

        setPrice(data.quote);

        // Notify parent component of price change
        if (onPriceChange && data.quote.ask_price) {
          onPriceChange(data.quote.ask_price);
        }
      }
    } catch (error) {
      console.error('Price fetch error:', error);
      setError('Failed to fetch price');
    } finally {
      setLoading(false);
    }
  }

  // Initial fetch (only once when symbol changes, WebSocket will handle real-time updates)
  useEffect(() => {
    // Only fetch if WebSocket price is not available (fallback)
    if (!realtimePrice && symbol) {
      fetchPrice();
    }
  }, [symbol]);

  if (!symbol) return null;

  if (loading && !price) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <RefreshCw className="w-4 h-4 animate-spin" />
        <span>Loading price...</span>
      </div>
    );
  }

  if (error && !price) {
    return (
      <div className="flex items-center gap-2 text-sm text-red-500">
        <AlertCircle className="w-4 h-4" />
        <span>{error}</span>
      </div>
    );
  }

  if (!price) return null;

  const isPriceUp = priceChange > 0;
  const isPriceDown = priceChange < 0;

  return (
    <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-600">Live Price</span>
          {loading && <RefreshCw className="w-3 h-3 animate-spin text-gray-400" />}
        </div>
        <span className="text-xs text-gray-400">Auto-refresh: 5s</span>
      </div>

      <div className="space-y-2">
        {/* Current Price (Ask) */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600">Ask Price:</span>
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold text-gray-900">
              ${price.ask_price?.toFixed(2) || 'N/A'}
            </span>
            {isPriceUp && (
              <div className="flex items-center text-green-600">
                <TrendingUp className="w-4 h-4" />
                <span className="text-xs ml-1">+${Math.abs(priceChange).toFixed(2)}</span>
              </div>
            )}
            {isPriceDown && (
              <div className="flex items-center text-red-600">
                <TrendingDown className="w-4 h-4" />
                <span className="text-xs ml-1">-${Math.abs(priceChange).toFixed(2)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Bid/Ask Spread */}
        <div className="grid grid-cols-2 gap-3 pt-2 border-t border-gray-200">
          <div>
            <span className="text-xs text-gray-500">Bid</span>
            <p className="text-sm font-medium text-gray-900">
              ${price.bid_price?.toFixed(2) || 'N/A'}
            </p>
            <p className="text-xs text-gray-500">
              Size: {price.bid_size || 0}
            </p>
          </div>
          <div>
            <span className="text-xs text-gray-500">Ask</span>
            <p className="text-sm font-medium text-gray-900">
              ${price.ask_price?.toFixed(2) || 'N/A'}
            </p>
            <p className="text-xs text-gray-500">
              Size: {price.ask_size || 0}
            </p>
          </div>
        </div>

        {/* Timestamp */}
        {price.timestamp && (
          <div className="text-xs text-gray-400 pt-2 border-t border-gray-200">
            Last updated: {new Date(price.timestamp).toLocaleTimeString()}
          </div>
        )}
      </div>
    </div>
  );
}

// Stock Search Input with Autocomplete
function StockSearchInput({ value, onChange, onSelect }) {
  const [searchQuery, setSearchQuery] = useState(value || '');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [searchTimeout, setSearchTimeout] = useState(null);

  const authHeaders = () => {
    const token = localStorage.getItem('auth_token');
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  };

  // Debounced search function
  async function searchStocks(query) {
    if (!query || query.length < 1) {
      setSearchResults([]);
      setShowDropdown(false);
      return;
    }

    setIsSearching(true);
    setShowDropdown(true);

    try {
      // Search via backend (which calls Alpaca API)
      const res = await fetch(
        `${config.backendUrl}/api/ext/trading/assets/search?query=${encodeURIComponent(query)}`,
        { headers: authHeaders() }
      );

      if (!res.ok) throw new Error('Search failed');

      const data = await res.json();
      setSearchResults(data.assets || []);
    } catch (error) {
      console.error('Stock search error:', error);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }

  // Handle input change with debounce
  function handleInputChange(e) {
    const query = e.target.value.toUpperCase();
    setSearchQuery(query);
    onChange(query);

    // Clear existing timeout
    if (searchTimeout) clearTimeout(searchTimeout);

    // Set new timeout for search (300ms debounce)
    const timeout = setTimeout(() => {
      searchStocks(query);
    }, 300);

    setSearchTimeout(timeout);
  }

  // Handle stock selection
  function handleSelect(asset) {
    setSearchQuery(asset.symbol);
    onChange(asset.symbol);
    onSelect(asset);
    setShowDropdown(false);
    setSearchResults([]);
  }

  // Handle click outside to close dropdown
  useEffect(() => {
    function handleClickOutside(e) {
      if (!e.target.closest('.stock-search-container')) {
        setShowDropdown(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative stock-search-container">
      <div className="relative">
        <input
          type="text"
          value={searchQuery}
          onChange={handleInputChange}
          onFocus={() => {
            if (searchResults.length > 0) setShowDropdown(true);
          }}
          placeholder="Search stocks (AAPL, TSLA, MSFT...)"
          className="w-full px-3 py-2 pl-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent uppercase"
          required
        />
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        {searchQuery && (
          <button
            type="button"
            onClick={() => {
              setSearchQuery('');
              onChange('');
              setSearchResults([]);
              setShowDropdown(false);
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Dropdown */}
      {showDropdown && (searchResults.length > 0 || isSearching) && (
        <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-64 overflow-y-auto">
          {isSearching ? (
            <div className="px-4 py-3 text-center text-gray-500">
              <RefreshCw className="w-4 h-4 animate-spin inline mr-2" />
              Searching...
            </div>
          ) : searchResults.length > 0 ? (
            <div className="py-1">
              {searchResults.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => handleSelect(asset)}
                  className="w-full px-4 py-2 text-left hover:bg-gray-50 flex items-center justify-between"
                >
                  <div>
                    <div className="font-medium text-gray-900">{asset.symbol}</div>
                    <div className="text-sm text-gray-500">{asset.name}</div>
                  </div>
                  <div className="text-xs text-gray-400">{asset.exchange}</div>
                </button>
              ))}
            </div>
          ) : (
            <div className="px-4 py-3 text-center text-gray-500">No results found</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * OrderPreviewModal - Confirmation dialog before placing order
 * Shows complete order details and requires user confirmation
 */
function OrderPreviewModal({ isOpen, onClose, onConfirm, preview, submitting }) {
  if (!isOpen || !preview) return null;

  const hasSufficientFunds = preview.estimated_cost <= preview.buying_power;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">Confirm Order</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            disabled={submitting}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          {/* Symbol & Asset Name */}
          <div className="text-center pb-4 border-b border-gray-100">
            <div className="text-2xl font-bold text-gray-900">{preview.symbol}</div>
            {preview.asset_name && (
              <div className="text-sm text-gray-500 mt-1">{preview.asset_name}</div>
            )}
          </div>

          {/* Order Details */}
          <div className="space-y-3">
            {/* Side & Quantity */}
            <div className="flex justify-between items-center">
              <span className="text-sm text-gray-600">Action:</span>
              <span className={`text-base font-semibold ${
                preview.side === 'buy' ? 'text-green-600' : 'text-red-600'
              }`}>
                {preview.side === 'buy' ? 'BUY' : 'SELL'} {preview.qty} shares
              </span>
            </div>

            {/* Order Type */}
            <div className="flex justify-between items-center">
              <span className="text-sm text-gray-600">Order Type:</span>
              <span className="text-base font-medium text-gray-900 capitalize">
                {preview.order_type}
                {preview.order_type === 'limit' && preview.limit_price && (
                  <span className="text-sm text-gray-500 ml-1">
                    @ ${preview.limit_price.toFixed(2)}
                  </span>
                )}
              </span>
            </div>

            {/* Time in Force */}
            <div className="flex justify-between items-center">
              <span className="text-sm text-gray-600">Duration:</span>
              <span className="text-base font-medium text-gray-900 uppercase">
                {preview.time_in_force}
              </span>
            </div>

            {/* Current Price */}
            {preview.current_price && (
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-600">Current Price:</span>
                <span className="text-base font-medium text-gray-900">
                  ${preview.current_price.toFixed(2)}
                </span>
              </div>
            )}

            {/* Advanced Order Class */}
            {preview.order_class && preview.order_class !== 'simple' && (
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-600">Order Class:</span>
                <span className="text-base font-medium text-blue-600 capitalize">
                  {preview.order_class.replace('_', ' ')}
                </span>
              </div>
            )}

            {/* Bracket Order Details */}
            {preview.order_class === 'bracket' && (
              <div className="bg-gradient-to-r from-blue-50 to-green-50 border border-blue-200 rounded-lg p-3 space-y-2">
                <div className="font-semibold text-sm text-gray-700">Bracket Order Levels:</div>
                {preview.take_profit && (
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-green-700">Take Profit:</span>
                    <span className="font-mono font-semibold text-green-700">
                      ${preview.take_profit.limit_price.toFixed(2)}
                    </span>
                  </div>
                )}
                {preview.stop_loss && (
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-red-700">Stop Loss:</span>
                    <span className="font-mono font-semibold text-red-700">
                      ${preview.stop_loss.stop_price.toFixed(2)}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Trailing Stop Details */}
            {preview.order_class === 'trailing_stop' && (
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-3">
                <div className="font-semibold text-sm text-purple-900 mb-1">Trailing Stop:</div>
                {preview.trail_amount && (
                  <div className="text-sm text-purple-700">
                    Trail by: <span className="font-mono font-semibold">${preview.trail_amount.toFixed(2)}</span>
                  </div>
                )}
                {preview.trail_percent && (
                  <div className="text-sm text-purple-700">
                    Trail by: <span className="font-mono font-semibold">{preview.trail_percent}%</span>
                  </div>
                )}
              </div>
            )}

            {/* OCO Order Details */}
            {preview.order_class === 'oco' && preview.oco_order && (
              <div className="bg-orange-50 border border-orange-200 rounded-lg p-3">
                <div className="font-semibold text-sm text-orange-900 mb-1">OCO (One-Cancels-Other):</div>
                <div className="text-sm text-orange-700">
                  Second Order: <span className="capitalize font-semibold">{preview.oco_order.type}</span> @ <span className="font-mono">${preview.oco_order.price.toFixed(2)}</span>
                </div>
              </div>
            )}

            {/* Estimated Cost */}
            <div className="flex justify-between items-center pt-3 border-t border-gray-100">
              <span className="text-sm font-medium text-gray-700">Estimated Cost:</span>
              <span className="text-lg font-bold text-gray-900">
                ${preview.estimated_cost.toFixed(2)}
              </span>
            </div>

            {/* Buying Power */}
            <div className="flex justify-between items-center">
              <span className="text-sm text-gray-600">Available Buying Power:</span>
              <span className="text-sm font-medium text-gray-700">
                ${preview.buying_power.toFixed(2)}
              </span>
            </div>

            {/* Remaining Balance */}
            <div className="flex justify-between items-center">
              <span className="text-sm text-gray-600">After Order:</span>
              <span className={`text-sm font-semibold ${
                hasSufficientFunds ? 'text-green-600' : 'text-red-600'
              }`}>
                ${(preview.buying_power - preview.estimated_cost).toFixed(2)}
              </span>
            </div>
          </div>

          {/* Warning if insufficient funds */}
          {!hasSufficientFunds && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3">
              <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-red-800">
                <strong>Insufficient Funds!</strong>
                <br />
                You need ${(preview.estimated_cost - preview.buying_power).toFixed(2)} more to place this order.
              </div>
            </div>
          )}

          {/* Info Note */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800">
            <strong>Note:</strong> The actual execution price may differ from the estimated cost,
            especially for market orders. Limit orders execute only at your specified price or better.
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-6 border-t border-gray-200">
          <button
            onClick={onClose}
            disabled={submitting}
            className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={submitting || !hasSufficientFunds}
            className={`flex-1 px-4 py-2.5 rounded-lg font-medium text-white disabled:opacity-50 ${
              preview.side === 'buy'
                ? 'bg-green-600 hover:bg-green-700'
                : 'bg-red-600 hover:bg-red-700'
            }`}
          >
            {submitting ? 'Placing Order...' : 'Confirm Order'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * OrderCostCalculator - Real-time order cost calculation
 * Shows: Total Cost, Available Buying Power, Remaining Balance
 * Warns if insufficient funds
 */
function OrderCostCalculator({ qty, price, side, orderType, limitPrice, portfolio }) {
  // Calculate effective price (market uses current price, limit uses limit price)
  const effectivePrice = orderType === 'limit' && limitPrice ? parseFloat(limitPrice) : price;

  // Calculate total cost
  const totalCost = qty && effectivePrice ? parseFloat(qty) * effectivePrice : 0;

  // Get buying power (for buy orders) or equity (for sell orders)
  const availableFunds = portfolio ? (side === 'buy' ? portfolio.buying_power : portfolio.equity) : 0;

  // Calculate remaining balance after order
  const remainingBalance = availableFunds - totalCost;

  // Check if user has sufficient funds
  const hasSufficientFunds = remainingBalance >= 0;

  // Don't show calculator if no price or qty
  if (!effectivePrice || !qty || qty <= 0) {
    return null;
  }

  return (
    <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-4 border border-blue-200">
      <h4 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
        <Calculator className="w-4 h-4" />
        Order Cost Estimate
      </h4>

      <div className="space-y-2.5">
        {/* Total Cost */}
        <div className="flex justify-between items-center">
          <span className="text-sm text-gray-600">Total Cost:</span>
          <span className="text-base font-bold text-gray-900">
            ${totalCost.toFixed(2)}
          </span>
        </div>

        {/* Calculation breakdown */}
        <div className="text-xs text-gray-500 border-t border-blue-100 pt-2">
          {qty} shares × ${effectivePrice.toFixed(2)} = ${totalCost.toFixed(2)}
        </div>

        {/* Available Funds */}
        <div className="flex justify-between items-center border-t border-blue-100 pt-2">
          <span className="text-sm text-gray-600">
            {side === 'buy' ? 'Buying Power:' : 'Portfolio Value:'}
          </span>
          <span className="text-sm font-medium text-gray-700">
            ${availableFunds.toFixed(2)}
          </span>
        </div>

        {/* Remaining Balance */}
        <div className="flex justify-between items-center pb-2">
          <span className="text-sm text-gray-600">After Order:</span>
          <span className={`text-sm font-semibold ${
            hasSufficientFunds ? 'text-green-600' : 'text-red-600'
          }`}>
            ${remainingBalance.toFixed(2)}
          </span>
        </div>

        {/* Insufficient Funds Warning */}
        {!hasSufficientFunds && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-md p-2.5 mt-2">
            <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-red-800">
              <strong>Insufficient Funds!</strong>
              <br />
              You need ${Math.abs(remainingBalance).toFixed(2)} more to place this order.
            </div>
          </div>
        )}

        {/* Success Indicator */}
        {hasSufficientFunds && totalCost > 0 && (
          <div className="flex items-center gap-2 text-xs text-green-700 mt-2">
            <CheckCircle className="w-3.5 h-3.5" />
            Sufficient funds available
          </div>
        )}
      </div>
    </div>
  );
}

function TradeTab({ onPlaceOrder, watchlist, portfolio }) {
  const [symbol, setSymbol] = useState('');
  const [selectedAsset, setSelectedAsset] = useState(null);
  const [qty, setQty] = useState('1');
  const [side, setSide] = useState('buy');
  const [orderType, setOrderType] = useState('market');
  const [limitPrice, setLimitPrice] = useState('');
  const [timeInForce, setTimeInForce] = useState('day');
  const [submitting, setSubmitting] = useState(false);
  const [currentPrice, setCurrentPrice] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [orderPreview, setOrderPreview] = useState(null);

  // Advanced Order Types State
  const [orderClass, setOrderClass] = useState('simple'); // simple, bracket, trailing_stop, oco
  const [takeProfitPrice, setTakeProfitPrice] = useState('');
  const [stopLossPrice, setStopLossPrice] = useState('');
  const [trailAmount, setTrailAmount] = useState('');
  const [trailPercent, setTrailPercent] = useState('');
  const [ocoOrderType, setOcoOrderType] = useState('limit');
  const [ocoPrice, setOcoPrice] = useState('');

  // Show preview dialog instead of placing order directly
  async function handleSubmit(e) {
    e.preventDefault();

    // Calculate estimated cost
    const effectivePrice = orderType === 'limit' && limitPrice ? parseFloat(limitPrice) : currentPrice;
    const estimatedCost = qty && effectivePrice ? parseFloat(qty) * effectivePrice : 0;

    // Build preview data
    const preview = {
      symbol: symbol.toUpperCase(),
      asset_name: selectedAsset?.name || symbol,
      qty: parseFloat(qty),
      side,
      order_type: orderType,
      time_in_force: timeInForce,
      limit_price: limitPrice ? parseFloat(limitPrice) : null,
      stop_price: (orderType === 'stop' || orderType === 'stop_limit') && stopLossPrice ? parseFloat(stopLossPrice) : null,
      current_price: currentPrice,
      estimated_cost: estimatedCost,
      buying_power: portfolio?.buying_power || 0,

      // Advanced order class
      order_class: orderClass,
      take_profit: orderClass === 'bracket' && takeProfitPrice ? { limit_price: parseFloat(takeProfitPrice) } : null,
      stop_loss: orderClass === 'bracket' && stopLossPrice ? { stop_price: parseFloat(stopLossPrice) } : null,
      trail_amount: orderClass === 'trailing_stop' && trailAmount ? parseFloat(trailAmount) : null,
      trail_percent: orderClass === 'trailing_stop' && trailPercent ? parseFloat(trailPercent) : null,
      oco_order: orderClass === 'oco' && ocoPrice ? {
        type: ocoOrderType,
        price: parseFloat(ocoPrice)
      } : null,
    };

    setOrderPreview(preview);
    setShowPreview(true);
  }

  // Confirm and place order
  async function handleConfirmOrder() {
    setSubmitting(true);
    setShowPreview(false);

    try {
      const orderData = {
        symbol: orderPreview.symbol,
        qty: orderPreview.qty,
        side: orderPreview.side,
        order_type: orderPreview.order_type,
        limit_price: orderPreview.limit_price || undefined,
        stop_price: orderPreview.stop_price || undefined,
        time_in_force: orderPreview.time_in_force,
        order_class: orderPreview.order_class !== 'simple' ? orderPreview.order_class : undefined,
      };

      // Add bracket order parameters
      if (orderPreview.order_class === 'bracket') {
        orderData.take_profit = orderPreview.take_profit;
        orderData.stop_loss = orderPreview.stop_loss;
      }

      // Add trailing stop parameters
      if (orderPreview.order_class === 'trailing_stop') {
        if (orderPreview.trail_amount) {
          orderData.trail_amount = orderPreview.trail_amount;
        } else if (orderPreview.trail_percent) {
          orderData.trail_percent = orderPreview.trail_percent;
        }
      }

      // Add OCO parameters
      if (orderPreview.order_class === 'oco') {
        orderData.oco_order = orderPreview.oco_order;
      }

      await onPlaceOrder(orderData);

      // Reset form
      setSymbol('');
      setQty('1');
      setLimitPrice('');
      setStopLossPrice('');
      setTimeInForce('day');
      setOrderClass('simple');
      setTakeProfitPrice('');
      setTrailAmount('');
      setTrailPercent('');
      setOcoPrice('');
      setOrderPreview(null);
    } catch (error) {
      // Error already handled by parent
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <h3 className="text-lg font-semibold mb-4">Place Order</h3>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Symbol</label>
          <StockSearchInput
            value={symbol}
            onChange={setSymbol}
            onSelect={(asset) => {
              setSymbol(asset.symbol);
              setSelectedAsset(asset);
            }}
          />
          {selectedAsset && (
            <p className="mt-1 text-sm text-gray-500">
              {selectedAsset.name} ({selectedAsset.exchange})
            </p>
          )}
        </div>

        {/* TradingView Chart */}
        {symbol && (
          <div className="my-6">
            <TradingViewChart symbol={symbol} />
          </div>
        )}

        {/* Live Price Display */}
        {symbol && (
          <div>
            <LivePriceDisplay
              symbol={symbol}
              onPriceChange={setCurrentPrice}
              realtimePrice={realtimePrices[symbol]}
            />
          </div>
        )}

        {/* Order Cost Calculator */}
        {symbol && currentPrice && (
          <OrderCostCalculator
            qty={qty}
            price={currentPrice}
            side={side}
            orderType={orderType}
            limitPrice={limitPrice}
            portfolio={portfolio}
          />
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label>
            <input
              type="number"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              min="0.01"
              step="0.01"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Side</label>
            <select
              value={side}
              onChange={(e) => setSide(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Order Type</label>
            <select
              value={orderType}
              onChange={(e) => setOrderType(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="market">Market</option>
              <option value="limit">Limit</option>
              <option value="stop">Stop</option>
              <option value="stop_limit">Stop Limit</option>
            </select>
          </div>

          {orderType === 'limit' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Limit Price</label>
              <input
                type="number"
                value={limitPrice}
                onChange={(e) => setLimitPrice(e.target.value)}
                min="0.01"
                step="0.01"
                placeholder="0.00"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required={orderType === 'limit'}
              />
            </div>
          )}

          {orderType === 'stop' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Stop Price</label>
              <input
                type="number"
                value={stopLossPrice}
                onChange={(e) => setStopLossPrice(e.target.value)}
                min="0.01"
                step="0.01"
                placeholder="0.00"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required={orderType === 'stop'}
              />
            </div>
          )}

          {orderType === 'stop_limit' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Stop Price</label>
                <input
                  type="number"
                  value={stopLossPrice}
                  onChange={(e) => setStopLossPrice(e.target.value)}
                  min="0.01"
                  step="0.01"
                  placeholder="0.00"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required={orderType === 'stop_limit'}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Limit Price</label>
                <input
                  type="number"
                  value={limitPrice}
                  onChange={(e) => setLimitPrice(e.target.value)}
                  min="0.01"
                  step="0.01"
                  placeholder="0.00"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required={orderType === 'stop_limit'}
                />
              </div>
            </>
          )}
        </div>

        {/* Advanced Order Class */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Order Class</label>
          <select
            value={orderClass}
            onChange={(e) => setOrderClass(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="simple">Simple Order</option>
            <option value="bracket">Bracket Order (Take Profit + Stop Loss)</option>
            <option value="trailing_stop">Trailing Stop</option>
            <option value="oco">OCO (One-Cancels-Other)</option>
          </select>
          <p className="mt-1 text-xs text-gray-500">
            {orderClass === 'simple' && 'Standard order execution'}
            {orderClass === 'bracket' && 'Set both take profit and stop loss levels simultaneously'}
            {orderClass === 'trailing_stop' && 'Stop loss that follows price movement'}
            {orderClass === 'oco' && 'Place two orders; if one executes, the other is canceled'}
          </p>
        </div>

        {/* Bracket Order Fields */}
        {orderClass === 'bracket' && side === 'buy' && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-3">
            <h4 className="font-semibold text-sm text-blue-900">Bracket Order Settings</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-blue-700 mb-1">Take Profit Price</label>
                <input
                  type="number"
                  value={takeProfitPrice}
                  onChange={(e) => setTakeProfitPrice(e.target.value)}
                  min="0.01"
                  step="0.01"
                  placeholder={currentPrice ? (currentPrice * 1.05).toFixed(2) : '0.00'}
                  className="w-full px-3 py-2 border border-blue-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required={orderClass === 'bracket'}
                />
                <p className="mt-1 text-xs text-blue-600">Sell when price reaches this level (profit)</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-red-700 mb-1">Stop Loss Price</label>
                <input
                  type="number"
                  value={stopLossPrice}
                  onChange={(e) => setStopLossPrice(e.target.value)}
                  min="0.01"
                  step="0.01"
                  placeholder={currentPrice ? (currentPrice * 0.95).toFixed(2) : '0.00'}
                  className="w-full px-3 py-2 border border-red-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                  required={orderClass === 'bracket'}
                />
                <p className="mt-1 text-xs text-red-600">Sell when price drops to this level (protection)</p>
              </div>
            </div>
          </div>
        )}

        {/* Trailing Stop Fields */}
        {orderClass === 'trailing_stop' && (
          <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 space-y-3">
            <h4 className="font-semibold text-sm text-purple-900">Trailing Stop Settings</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-purple-700 mb-1">Trail Amount ($)</label>
                <input
                  type="number"
                  value={trailAmount}
                  onChange={(e) => {
                    setTrailAmount(e.target.value);
                    setTrailPercent(''); // Clear percent when amount is set
                  }}
                  min="0.01"
                  step="0.01"
                  placeholder="5.00"
                  className="w-full px-3 py-2 border border-purple-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  disabled={!!trailPercent}
                />
                <p className="mt-1 text-xs text-purple-600">Fixed dollar amount to trail</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-purple-700 mb-1">Trail Percent (%)</label>
                <input
                  type="number"
                  value={trailPercent}
                  onChange={(e) => {
                    setTrailPercent(e.target.value);
                    setTrailAmount(''); // Clear amount when percent is set
                  }}
                  min="0.01"
                  step="0.01"
                  max="100"
                  placeholder="5.0"
                  className="w-full px-3 py-2 border border-purple-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  disabled={!!trailAmount}
                />
                <p className="mt-1 text-xs text-purple-600">Percentage to trail</p>
              </div>
            </div>
            <p className="text-xs text-purple-700 bg-purple-100 p-2 rounded">
              Stop loss automatically adjusts as price moves in your favor
            </p>
          </div>
        )}

        {/* OCO Order Fields */}
        {orderClass === 'oco' && (
          <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 space-y-3">
            <h4 className="font-semibold text-sm text-orange-900">OCO (One-Cancels-Other) Settings</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-orange-700 mb-1">Second Order Type</label>
                <select
                  value={ocoOrderType}
                  onChange={(e) => setOcoOrderType(e.target.value)}
                  className="w-full px-3 py-2 border border-orange-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                >
                  <option value="limit">Limit</option>
                  <option value="stop">Stop</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-orange-700 mb-1">
                  {ocoOrderType === 'limit' ? 'Limit Price' : 'Stop Price'}
                </label>
                <input
                  type="number"
                  value={ocoPrice}
                  onChange={(e) => setOcoPrice(e.target.value)}
                  min="0.01"
                  step="0.01"
                  placeholder="0.00"
                  className="w-full px-3 py-2 border border-orange-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                  required={orderClass === 'oco'}
                />
              </div>
            </div>
            <p className="text-xs text-orange-700 bg-orange-100 p-2 rounded">
              When one order executes, the other is automatically canceled
            </p>
          </div>
        )}

        {/* Time in Force */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Time in Force
            <span className="ml-1 text-xs text-gray-500">(Order Duration)</span>
          </label>
          <select
            value={timeInForce}
            onChange={(e) => setTimeInForce(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="day">Day - Valid until market close</option>
            <option value="gtc">GTC - Good Till Canceled</option>
            <option value="ioc">IOC - Immediate or Cancel</option>
            <option value="fok">FOK - Fill or Kill (all or nothing)</option>
          </select>

          {/* Help text based on selected option */}
          <div className="mt-2 text-xs text-gray-600 bg-gray-50 rounded p-2 border border-gray-200">
            {timeInForce === 'day' && (
              <p>
                <strong>Day Order:</strong> Valid only during the current trading session.
                Automatically canceled if not filled by market close (4:00 PM ET).
              </p>
            )}
            {timeInForce === 'gtc' && (
              <p>
                <strong>Good Till Canceled:</strong> Remains active until filled or manually canceled.
                No automatic expiration. Best for patient limit orders.
              </p>
            )}
            {timeInForce === 'ioc' && (
              <p>
                <strong>Immediate or Cancel:</strong> Executes immediately for the available quantity.
                Any unfilled portion is canceled instantly. Good for large orders.
              </p>
            )}
            {timeInForce === 'fok' && (
              <p>
                <strong>Fill or Kill:</strong> Must fill the entire order immediately or cancel completely.
                All-or-nothing execution. No partial fills allowed.
              </p>
            )}
          </div>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className={`w-full py-3 rounded-lg font-medium text-white ${
            side === 'buy'
              ? 'bg-green-600 hover:bg-green-700'
              : 'bg-red-600 hover:bg-red-700'
          } disabled:opacity-50`}
        >
          {submitting ? 'Placing Order...' : `${side === 'buy' ? 'Buy' : 'Sell'} ${symbol || '...'}`}
        </button>
      </form>

      {watchlist.length > 0 && (
        <div className="mt-8">
          <h4 className="text-sm font-medium text-gray-700 mb-3">Watchlist</h4>
          <div className="flex flex-wrap gap-2">
            {watchlist.map((item) => (
              <button
                key={item.symbol}
                onClick={() => setSymbol(item.symbol)}
                className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium"
              >
                {item.symbol}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Order Preview Modal */}
      <OrderPreviewModal
        isOpen={showPreview}
        onClose={() => setShowPreview(false)}
        onConfirm={handleConfirmOrder}
        preview={orderPreview}
        submitting={submitting}
      />
    </div>
  );
}

function OrdersTab({ orders, onCancel }) {
  if (orders.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <Activity className="w-12 h-12 mx-auto mb-3 opacity-50" />
        <p>No orders yet. Place your first order to see it here.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead>
          <tr className="bg-gray-50">
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Symbol</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Side</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Qty</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Filled Price</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Time</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Action</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {orders.map((order) => (
            <tr key={order.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 font-medium">{order.symbol}</td>
              <td className="px-4 py-3">
                <span
                  className={`px-2 py-1 text-xs font-medium rounded ${
                    order.side === 'buy'
                      ? 'bg-green-100 text-green-800'
                      : 'bg-red-100 text-red-800'
                  }`}
                >
                  {order.side.toUpperCase()}
                </span>
              </td>
              <td className="px-4 py-3">{order.qty}</td>
              <td className="px-4 py-3">{order.order_type}</td>
              <td className="px-4 py-3">
                <span
                  className={`px-2 py-1 text-xs font-medium rounded ${
                    order.status === 'filled'
                      ? 'bg-green-100 text-green-800'
                      : order.status === 'canceled'
                      ? 'bg-gray-100 text-gray-800'
                      : 'bg-blue-100 text-blue-800'
                  }`}
                >
                  {order.status}
                </span>
              </td>
              <td className="px-4 py-3">
                {order.filled_avg_price ? `$${order.filled_avg_price.toFixed(2)}` : '-'}
              </td>
              <td className="px-4 py-3 text-sm text-gray-500">
                {new Date(order.submitted_at).toLocaleString()}
              </td>
              <td className="px-4 py-3">
                {order.status === 'new' || order.status === 'pending_new' ? (
                  <button
                    onClick={() => onCancel(order.id)}
                    className="text-red-600 hover:text-red-800 text-sm font-medium"
                  >
                    Cancel
                  </button>
                ) : (
                  <span className="text-gray-400 text-sm">-</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StrategiesTab({ strategies, signals, onStartStrategy, onStopStrategy, onExecuteSignal, onRejectSignal }) {
  return (
    <div className="space-y-6">
      {/* Pending Signals */}
      {signals.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-4">Pending Signals ({signals.length})</h3>
          <div className="space-y-3">
            {signals.map((signal) => (
              <div
                key={signal.id}
                className="border border-blue-200 rounded-lg p-4 bg-blue-50"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-bold text-lg">{signal.symbol}</span>
                      <span
                        className={`px-2 py-1 text-xs font-medium rounded ${
                          signal.signal_type === 'buy'
                            ? 'bg-green-100 text-green-800'
                            : 'bg-red-100 text-red-800'
                        }`}
                      >
                        {signal.signal_type.toUpperCase()}
                      </span>
                      <span className="text-sm text-gray-600">
                        @ ${signal.current_price.toFixed(2)}
                      </span>
                    </div>
                    <p className="text-sm text-gray-700 mb-2">{signal.reason}</p>
                    <div className="flex items-center gap-4 text-xs text-gray-600">
                      <span>Qty: {signal.recommended_qty}</span>
                      <span>Confidence: {(signal.confidence * 100).toFixed(0)}%</span>
                      <span>Strategy: {signal.strategy_name}</span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => onExecuteSignal(signal.id)}
                      className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm"
                    >
                      Execute
                    </button>
                    <button
                      onClick={() => onRejectSignal(signal.id)}
                      className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-sm"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Strategies List */}
      <div>
        <h3 className="text-lg font-semibold mb-4">Trading Strategies</h3>

        {strategies.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <Target className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p>No strategies yet. Create your first AI trading strategy.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {strategies.map((strategy) => (
              <div key={strategy.id} className="border border-gray-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <h4 className="font-semibold">{strategy.strategy_name}</h4>
                    <p className="text-sm text-gray-600">
                      {strategy.strategy_type.replace('_', ' ')} • {strategy.execution_mode}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`px-2 py-1 text-xs font-medium rounded ${
                        strategy.status === 'active'
                          ? 'bg-green-100 text-green-800'
                          : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {strategy.status}
                    </span>
                    {strategy.status === 'active' ? (
                      <button
                        onClick={() => onStopStrategy(strategy.id)}
                        className="p-2 text-red-600 hover:bg-red-50 rounded-lg"
                      >
                        <StopCircle className="w-4 h-4" />
                      </button>
                    ) : (
                      <button
                        onClick={() => onStartStrategy(strategy.id)}
                        className="p-2 text-green-600 hover:bg-green-50 rounded-lg"
                      >
                        <PlayCircle className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-4 text-xs text-gray-600">
                  <span>Symbols: {strategy.symbols.join(', ')}</span>
                  {strategy.win_rate !== null && (
                    <span>Win Rate: {strategy.win_rate.toFixed(1)}%</span>
                  )}
                  <span>Total Trades: {strategy.total_trades}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectAccountDialog({ onClose, onSuccess }) {
  const authHeaders = () => {
    const token = localStorage.getItem('auth_token');
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  };

  const [formData, setFormData] = useState({
    account_name: '',
    account_mode: 'paper',
    api_key: '',
    api_secret: '',
  });
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);

    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/accounts`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          platform: 'alpaca',
          ...formData,
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to connect account');
      }

      toast.success('Account connected successfully');
      onSuccess();
    } catch (error) {
      console.error('Connect account error:', error);
      toast.error(error.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="p-6">
          <h2 className="text-xl font-bold mb-4 text-gray-900 dark:text-white">Connect Trading Account</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Account Name
              </label>
              <input
                type="text"
                value={formData.account_name}
                onChange={(e) => setFormData({ ...formData, account_name: e.target.value })}
                placeholder="My Paper Account"
                className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-800 dark:text-white dark:border-gray-600"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Mode</label>
              <select
                value={formData.account_mode}
                onChange={(e) => setFormData({ ...formData, account_mode: e.target.value })}
                className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-800 dark:text-white dark:border-gray-600"
              >
                <option value="paper">Paper Trading (Demo)</option>
                <option value="live">Live Trading (Real Money)</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">API Key</label>
              <input
                type="password"
                value={formData.api_key}
                onChange={(e) => setFormData({ ...formData, api_key: e.target.value })}
                placeholder="PK..."
                className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-800 dark:text-white dark:border-gray-600"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">API Secret</label>
              <input
                type="password"
                value={formData.api_secret}
                onChange={(e) => setFormData({ ...formData, api_secret: e.target.value })}
                placeholder="..."
                className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-800 dark:text-white dark:border-gray-600"
                required
              />
            </div>

            <div className="text-xs text-gray-500 dark:text-gray-400">
              Get your API keys from{' '}
              <a
                href="https://alpaca.markets"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                alpaca.markets
              </a>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-900 dark:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {submitting ? 'Connecting...' : 'Connect'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
