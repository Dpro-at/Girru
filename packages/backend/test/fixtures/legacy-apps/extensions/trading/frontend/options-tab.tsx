'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Calculator,
  RefreshCw,
  Search,
  X,
  TrendingUp,
  TrendingDown,
  ChevronDown,
  ChevronUp,
  Target,
  Calendar,
  DollarSign,
  Activity,
  AlertCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { config } from '@/lib/config';
import { GreeksCalculator } from './greeks-calculator';
import { StrategyBuilder } from './strategy-builder';
import { OptionsOrderDialog } from './options-order-dialog';
import { OptionsOrdersHistory } from './options-orders-history';
import { OptionsPositions } from './options-positions';
import { OptionsAnalytics } from './options-analytics';

interface OptionContract {
  symbol: string;
  strikePrice: number;
  expirationDate: string;
  type: 'call' | 'put';
  bid: number;
  ask: number;
  lastPrice: number;
  volume: number;
  openInterest: number;
  impliedVolatility: number;
  greeks?: {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    rho: number;
  };
}

interface OptionsChainData {
  calls: OptionContract[];
  puts: OptionContract[];
}

export function OptionsTab() {
  const [subTab, setSubTab] = useState<'chain' | 'positions' | 'orders' | 'analytics'>('chain');
  const [symbol, setSymbol] = useState('AAPL');
  const [symbolInput, setSymbolInput] = useState('AAPL');
  const [expirations, setExpirations] = useState<string[]>([]);
  const [selectedExpiration, setSelectedExpiration] = useState('');
  const [chain, setChain] = useState<OptionsChainData>({ calls: [], puts: [] });
  const [loading, setLoading] = useState(false);
  const [loadingExpirations, setLoadingExpirations] = useState(false);
  const [spotPrice, setSpotPrice] = useState(0);
  const [showGreeks, setShowGreeks] = useState(false);
  const [showCalculator, setShowCalculator] = useState(false);
  const [showStrategyBuilder, setShowStrategyBuilder] = useState(false);
  const [showOrderDialog, setShowOrderDialog] = useState(false);
  const [selectedContract, setSelectedContract] = useState<OptionContract | null>(null);

  const authHeaders = useCallback(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }, []);

  // Load expiration dates when symbol changes
  useEffect(() => {
    if (symbol) {
      loadExpirations();
    }
  }, [symbol]);

  // Load options chain when expiration changes
  useEffect(() => {
    if (symbol && selectedExpiration) {
      loadOptionsChain();
    }
  }, [symbol, selectedExpiration]);

  const loadExpirations = async () => {
    setLoadingExpirations(true);
    try {
      const res = await fetch(
        `${config.backendUrl}/api/ext/trading/options/expirations/${symbol}`,
        { headers: authHeaders() }
      );

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to load expirations');
      }

      const data = await res.json();
      setExpirations(data.expirations || []);

      // Auto-select first expiration
      if (data.expirations && data.expirations.length > 0) {
        setSelectedExpiration(data.expirations[0]);
      }
    } catch (error: any) {
      console.error('Load expirations error:', error);
      toast.error(error.message || 'Failed to load expiration dates');
    } finally {
      setLoadingExpirations(false);
    }
  };

  const loadOptionsChain = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (selectedExpiration) params.append('expirationDate', selectedExpiration);

      const res = await fetch(
        `${config.backendUrl}/api/ext/trading/options/chain/${symbol}?${params.toString()}`,
        { headers: authHeaders() }
      );

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to load options chain');
      }

      const data = await res.json();
      const rawChain = data.chain || [];

      // Split into calls and puts
      const calls = rawChain.filter((c: OptionContract) => c.type === 'call');
      const puts = rawChain.filter((c: OptionContract) => c.type === 'put');

      // Sort by strike price
      calls.sort((a: OptionContract, b: OptionContract) => a.strikePrice - b.strikePrice);
      puts.sort((a: OptionContract, b: OptionContract) => a.strikePrice - b.strikePrice);

      setChain({ calls, puts });

      // Get spot price from first contract (approximation)
      if (rawChain.length > 0) {
        const atm = rawChain.find((c: OptionContract) =>
          Math.abs(c.strikePrice - (c.lastPrice * 100)) < 5
        );
        if (atm) {
          setSpotPrice(atm.strikePrice);
        }
      }
    } catch (error: any) {
      console.error('Load options chain error:', error);
      toast.error(error.message || 'Failed to load options chain');
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = () => {
    if (symbolInput.trim()) {
      setSymbol(symbolInput.trim().toUpperCase());
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const handleRefresh = () => {
    loadOptionsChain();
    toast.success('Options chain refreshed');
  };

  const getMoneyness = (strikePrice: number, type: 'call' | 'put') => {
    if (!spotPrice) return 'atm';

    if (type === 'call') {
      if (strikePrice < spotPrice) return 'itm'; // In-the-money
      if (strikePrice > spotPrice) return 'otm'; // Out-of-the-money
      return 'atm'; // At-the-money
    } else {
      if (strikePrice > spotPrice) return 'itm';
      if (strikePrice < spotPrice) return 'otm';
      return 'atm';
    }
  };

  const getMoneynessColor = (moneyness: string) => {
    switch (moneyness) {
      case 'itm':
        return 'bg-green-50 border-green-200';
      case 'atm':
        return 'bg-yellow-50 border-yellow-200';
      case 'otm':
        return 'bg-gray-50 border-gray-200';
      default:
        return 'bg-white';
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatPrice = (price: number) => {
    return price ? `$${price.toFixed(2)}` : '-';
  };

  const formatPercent = (value: number) => {
    return value ? `${(value * 100).toFixed(2)}%` : '-';
  };

  const formatGreek = (value: number) => {
    return value ? value.toFixed(4) : '-';
  };

  if (loading && !chain.calls.length) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
        <div className="flex items-center gap-2">
          <Calculator className="w-5 h-5 text-blue-600" />
          <h2 className="text-lg sm:text-xl font-bold text-gray-900">Options Chain</h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm flex items-center gap-1.5 disabled:opacity-50"
          >
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
            <span className="hidden sm:inline">Refresh</span>
          </button>

          <button
            onClick={() => setShowGreeks(!showGreeks)}
            className={cn(
              'px-3 py-1.5 rounded-lg transition text-sm flex items-center gap-1.5',
              showGreeks
                ? 'bg-green-600 text-white hover:bg-green-700'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            )}
          >
            <Activity className="w-4 h-4" />
            <span className="hidden sm:inline">Greeks</span>
          </button>

          <button
            onClick={() => setShowCalculator(true)}
            className="px-3 py-1.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition text-sm flex items-center gap-1.5"
          >
            <Calculator className="w-4 h-4" />
            <span className="hidden sm:inline">Calculator</span>
          </button>

          <button
            onClick={() => setShowStrategyBuilder(true)}
            className="px-3 py-1.5 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition text-sm flex items-center gap-1.5"
          >
            <Target className="w-4 h-4" />
            <span className="hidden sm:inline">Strategies</span>
          </button>
        </div>
      </div>

      {/* Sub-Tabs */}
      <div className="border-b border-gray-200">
        <div className="flex space-x-6">
          <button
            onClick={() => setSubTab('chain')}
            className={cn(
              'pb-3 text-sm font-medium border-b-2 transition-colors',
              subTab === 'chain'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            )}
          >
            Options Chain
          </button>
          <button
            onClick={() => setSubTab('positions')}
            className={cn(
              'pb-3 text-sm font-medium border-b-2 transition-colors',
              subTab === 'positions'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            )}
          >
            Positions
          </button>
          <button
            onClick={() => setSubTab('orders')}
            className={cn(
              'pb-3 text-sm font-medium border-b-2 transition-colors',
              subTab === 'orders'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            )}
          >
            Orders
          </button>
          <button
            onClick={() => setSubTab('analytics')}
            className={cn(
              'pb-3 text-sm font-medium border-b-2 transition-colors',
              subTab === 'analytics'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            )}
          >
            Analytics
          </button>
        </div>
      </div>

      {/* Search & Filters (only show for chain tab) */}
      {subTab === 'chain' && (
      <>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Symbol Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
            onKeyPress={handleKeyPress}
            placeholder="Symbol (e.g., AAPL)"
            className="w-full pl-10 pr-10 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {symbolInput && (
            <button
              onClick={handleSearch}
              className="absolute right-2 top-1/2 transform -translate-y-1/2 px-2 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700"
            >
              Go
            </button>
          )}
        </div>

        {/* Expiration Selector */}
        <div className="relative">
          <Calendar className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
          <select
            value={selectedExpiration}
            onChange={(e) => setSelectedExpiration(e.target.value)}
            disabled={loadingExpirations}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none bg-white disabled:opacity-50"
          >
            {expirations.length === 0 ? (
              <option>Loading expirations...</option>
            ) : (
              expirations.map((exp) => (
                <option key={exp} value={exp}>
                  {formatDate(exp)}
                </option>
              ))
            )}
          </select>
          <ChevronDown className="absolute right-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        </div>

        {/* Spot Price Display */}
        {spotPrice > 0 && (
          <div className="flex items-center gap-2 px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg">
            <Target className="w-4 h-4 text-blue-600" />
            <div className="flex-1">
              <div className="text-xs text-blue-600 font-medium">Spot Price</div>
              <div className="text-sm font-bold text-blue-900">${spotPrice.toFixed(2)}</div>
            </div>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-4 bg-green-100 border border-green-300 rounded"></div>
          <span className="text-gray-600">ITM (In-the-Money)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-4 bg-yellow-100 border border-yellow-300 rounded"></div>
          <span className="text-gray-600">ATM (At-the-Money)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-4 bg-gray-100 border border-gray-300 rounded"></div>
          <span className="text-gray-600">OTM (Out-of-the-Money)</span>
        </div>
      </div>

      {/* Options Chain Table */}
      {chain.calls.length === 0 && chain.puts.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg border border-gray-200">
          <Calculator className="w-12 h-12 text-gray-400 mx-auto mb-3" />
          <p className="text-sm text-gray-600">
            {symbol
              ? 'No options data available. Try a different symbol or expiration date.'
              : 'Enter a symbol to view options chain'}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto -mx-2 sm:mx-0">
          <div className="inline-block min-w-full align-middle">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  {/* Calls Header */}
                  <th colSpan={showGreeks ? 9 : 5} className="px-3 py-3 text-center text-xs font-semibold text-green-700 uppercase tracking-wider border-r-2 border-gray-300">
                    Calls
                  </th>
                  {/* Strike */}
                  <th className="px-3 py-3 text-center text-xs font-semibold text-gray-700 uppercase tracking-wider border-r-2 border-gray-300">
                    Strike
                  </th>
                  {/* Puts Header */}
                  <th colSpan={showGreeks ? 9 : 5} className="px-3 py-3 text-center text-xs font-semibold text-red-700 uppercase tracking-wider">
                    Puts
                  </th>
                </tr>
                <tr className="bg-gray-100">
                  {/* Calls Columns */}
                  <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Bid</th>
                  <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Ask</th>
                  <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Last</th>
                  <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Vol</th>
                  <th className="px-2 py-2 text-left text-xs font-medium text-gray-600 border-r-2 border-gray-300">OI</th>
                  {showGreeks && (
                    <>
                      <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Delta</th>
                      <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Gamma</th>
                      <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Theta</th>
                      <th className="px-2 py-2 text-left text-xs font-medium text-gray-600 border-r-2 border-gray-300">Vega</th>
                    </>
                  )}
                  {/* Strike */}
                  <th className="px-3 py-2 text-center text-xs font-semibold text-gray-900 border-r-2 border-gray-300">$</th>
                  {/* Puts Columns */}
                  <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Bid</th>
                  <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Ask</th>
                  <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Last</th>
                  <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Vol</th>
                  <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">OI</th>
                  {showGreeks && (
                    <>
                      <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Delta</th>
                      <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Gamma</th>
                      <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Theta</th>
                      <th className="px-2 py-2 text-left text-xs font-medium text-gray-600">Vega</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {chain.calls.map((call, idx) => {
                  const put = chain.puts[idx];
                  const callMoneyness = getMoneyness(call.strikePrice, 'call');
                  const putMoneyness = put ? getMoneyness(put.strikePrice, 'put') : 'otm';

                  return (
                    <tr key={call.strikePrice} className="hover:bg-gray-50 transition">
                      {/* Call Data */}
                      <td className={cn('px-2 py-2 text-xs', getMoneynessColor(callMoneyness))}>{formatPrice(call.bid)}</td>
                      <td className={cn('px-2 py-2 text-xs', getMoneynessColor(callMoneyness))}>{formatPrice(call.ask)}</td>
                      <td className={cn('px-2 py-2 text-xs font-medium', getMoneynessColor(callMoneyness))}>{formatPrice(call.lastPrice)}</td>
                      <td className={cn('px-2 py-2 text-xs text-gray-600', getMoneynessColor(callMoneyness))}>{call.volume?.toLocaleString() || '-'}</td>
                      <td className={cn('px-2 py-2 text-xs text-gray-600 border-r-2 border-gray-300', getMoneynessColor(callMoneyness))}>{call.openInterest?.toLocaleString() || '-'}</td>
                      {showGreeks && (
                        <>
                          <td className={cn('px-2 py-2 text-xs', getMoneynessColor(callMoneyness))}>{formatGreek(call.greeks?.delta || 0)}</td>
                          <td className={cn('px-2 py-2 text-xs', getMoneynessColor(callMoneyness))}>{formatGreek(call.greeks?.gamma || 0)}</td>
                          <td className={cn('px-2 py-2 text-xs', getMoneynessColor(callMoneyness))}>{formatGreek(call.greeks?.theta || 0)}</td>
                          <td className={cn('px-2 py-2 text-xs border-r-2 border-gray-300', getMoneynessColor(callMoneyness))}>{formatGreek(call.greeks?.vega || 0)}</td>
                        </>
                      )}
                      {/* Strike */}
                      <td className="px-3 py-2 text-center text-sm font-bold text-gray-900 border-r-2 border-gray-300 bg-gray-50">
                        ${call.strikePrice.toFixed(2)}
                      </td>
                      {/* Put Data */}
                      {put ? (
                        <>
                          <td className={cn('px-2 py-2 text-xs', getMoneynessColor(putMoneyness))}>{formatPrice(put.bid)}</td>
                          <td className={cn('px-2 py-2 text-xs', getMoneynessColor(putMoneyness))}>{formatPrice(put.ask)}</td>
                          <td className={cn('px-2 py-2 text-xs font-medium', getMoneynessColor(putMoneyness))}>{formatPrice(put.lastPrice)}</td>
                          <td className={cn('px-2 py-2 text-xs text-gray-600', getMoneynessColor(putMoneyness))}>{put.volume?.toLocaleString() || '-'}</td>
                          <td className={cn('px-2 py-2 text-xs text-gray-600', getMoneynessColor(putMoneyness))}>{put.openInterest?.toLocaleString() || '-'}</td>
                          {showGreeks && (
                            <>
                              <td className={cn('px-2 py-2 text-xs', getMoneynessColor(putMoneyness))}>{formatGreek(put.greeks?.delta || 0)}</td>
                              <td className={cn('px-2 py-2 text-xs', getMoneynessColor(putMoneyness))}>{formatGreek(put.greeks?.gamma || 0)}</td>
                              <td className={cn('px-2 py-2 text-xs', getMoneynessColor(putMoneyness))}>{formatGreek(put.greeks?.theta || 0)}</td>
                              <td className={cn('px-2 py-2 text-xs', getMoneynessColor(putMoneyness))}>{formatGreek(put.greeks?.vega || 0)}</td>
                            </>
                          )}
                        </>
                      ) : (
                        <>
                          <td colSpan={showGreeks ? 9 : 5} className="px-2 py-2 text-xs text-center text-gray-400">No data</td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Info Banner */}
      <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs sm:text-sm">
        <AlertCircle className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
        <div className="text-blue-800">
          <strong>Options Trading:</strong> Options involve risk and are not suitable for all investors.
          Ensure you understand the risks before trading. Click on a contract to view details and place orders.
        </div>
      </div>
      </>
      )}

      {/* Positions Tab */}
      {subTab === 'positions' && <OptionsPositions />}

      {/* Orders History Tab */}
      {subTab === 'orders' && <OptionsOrdersHistory />}

      {/* Analytics Tab */}
      {subTab === 'analytics' && <OptionsAnalytics />}

      {/* Greeks Calculator Modal */}
      <GreeksCalculator isOpen={showCalculator} onClose={() => setShowCalculator(false)} />

      {/* Strategy Builder Modal */}
      <StrategyBuilder
        isOpen={showStrategyBuilder}
        onClose={() => setShowStrategyBuilder(false)}
        spotPrice={spotPrice}
        symbol={symbol}
      />

      {/* Options Order Dialog */}
      <OptionsOrderDialog
        isOpen={showOrderDialog}
        onClose={() => {
          setShowOrderDialog(false);
          setSelectedContract(null);
        }}
        symbol={symbol}
        strikePrice={selectedContract?.strikePrice || 0}
        expirationDate={selectedContract?.expirationDate || ''}
        optionType={selectedContract?.type || 'call'}
        currentPrice={selectedContract?.lastPrice || 0}
      />
    </div>
  );
}
