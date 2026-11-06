'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw,
  TrendingUp,
  TrendingDown,
  X,
  DollarSign,
  Activity,
  Target,
  Calendar,
  AlertCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { config } from '@/lib/config';

interface OptionsPosition {
  id: number;
  symbol: string;
  option_symbol: string;
  option_type: 'call' | 'put';
  strike_price: number;
  expiration_date: string;
  qty: number;
  side: 'long' | 'short';
  avg_entry_price: number;
  current_price: number;
  market_value: number;
  unrealized_pl: number;
  unrealized_pl_percent: number;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  implied_volatility: number | null;
  updated_at: string;
}

export function OptionsPositions() {
  const [positions, setPositions] = useState<OptionsPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showGreeks, setShowGreeks] = useState(false);

  const authHeaders = useCallback(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }, []);

  useEffect(() => {
    loadPositions();
  }, []);

  const loadPositions = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/options/positions`, {
        headers: authHeaders(),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to load positions');
      }

      const data = await res.json();
      setPositions(data.positions || []);
    } catch (error: any) {
      console.error('Load positions error:', error);
      toast.error(error.message || 'Failed to load options positions');
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadPositions();
    setRefreshing(false);
    toast.success('Positions refreshed');
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatPrice = (price: number) => {
    return `$${price.toFixed(2)}`;
  };

  const formatPercent = (value: number) => {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}%`;
  };

  const formatGreek = (value: number | null) => {
    return value !== null ? value.toFixed(4) : '-';
  };

  const getTotalValue = () => {
    return positions.reduce((sum, pos) => sum + pos.market_value, 0);
  };

  const getTotalPL = () => {
    return positions.reduce((sum, pos) => sum + pos.unrealized_pl, 0);
  };

  const getTotalPLPercent = () => {
    const totalValue = getTotalValue();
    const totalPL = getTotalPL();
    const totalCost = totalValue - totalPL;
    return totalCost > 0 ? (totalPL / totalCost) * 100 : 0;
  };

  if (loading && positions.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const totalValue = getTotalValue();
  const totalPL = getTotalPL();
  const totalPLPercent = getTotalPLPercent();

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h3 className="text-lg font-bold text-gray-900">Options Positions</h3>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm flex items-center gap-1.5 disabled:opacity-50"
          >
            <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
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
        </div>
      </div>

      {/* Summary Cards */}
      {positions.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign className="w-4 h-4 text-blue-600" />
              <span className="text-xs font-medium text-blue-700">Total Value</span>
            </div>
            <div className="text-2xl font-bold text-blue-900">{formatPrice(totalValue)}</div>
          </div>

          <div
            className={cn(
              'p-4 border rounded-lg',
              totalPL >= 0 ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
            )}
          >
            <div className="flex items-center gap-2 mb-1">
              {totalPL >= 0 ? (
                <TrendingUp className="w-4 h-4 text-green-600" />
              ) : (
                <TrendingDown className="w-4 h-4 text-red-600" />
              )}
              <span
                className={cn(
                  'text-xs font-medium',
                  totalPL >= 0 ? 'text-green-700' : 'text-red-700'
                )}
              >
                Total P/L
              </span>
            </div>
            <div
              className={cn(
                'text-2xl font-bold',
                totalPL >= 0 ? 'text-green-900' : 'text-red-900'
              )}
            >
              {formatPrice(totalPL)}
            </div>
          </div>

          <div
            className={cn(
              'p-4 border rounded-lg',
              totalPLPercent >= 0 ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
            )}
          >
            <div className="flex items-center gap-2 mb-1">
              <Target className="w-4 h-4 text-purple-600" />
              <span className="text-xs font-medium text-purple-700">P/L %</span>
            </div>
            <div
              className={cn(
                'text-2xl font-bold',
                totalPLPercent >= 0 ? 'text-green-900' : 'text-red-900'
              )}
            >
              {formatPercent(totalPLPercent)}
            </div>
          </div>
        </div>
      )}

      {/* Positions Table */}
      {positions.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg border border-gray-200">
          <Target className="w-12 h-12 text-gray-400 mx-auto mb-3" />
          <p className="text-sm text-gray-600">
            No options positions. Place your first order to see positions here.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto -mx-2 sm:mx-0">
          <div className="inline-block min-w-full align-middle">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Contract
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Strike
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Exp
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Qty
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Entry
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Current
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Value
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    P/L
                  </th>
                  {showGreeks && (
                    <>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Delta
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Theta
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        IV
                      </th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {positions.map((pos) => (
                  <tr key={pos.id} className="hover:bg-gray-50 transition">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">
                      {pos.symbol}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'px-2 py-1 rounded text-xs font-medium',
                          pos.option_type === 'call'
                            ? 'bg-green-100 text-green-700'
                            : 'bg-red-100 text-red-700'
                        )}
                      >
                        {pos.option_type === 'call' ? (
                          <>
                            <TrendingUp className="w-3 h-3 inline-block mr-1" />
                            Call
                          </>
                        ) : (
                          <>
                            <TrendingDown className="w-3 h-3 inline-block mr-1" />
                            Put
                          </>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">
                      ${pos.strike_price.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {formatDate(pos.expiration_date)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-900">
                      {pos.qty}
                      <span className="ml-1 text-xs text-gray-500">
                        ({pos.side === 'long' ? 'L' : 'S'})
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-900">
                      {formatPrice(pos.avg_entry_price)}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-blue-600">
                      {formatPrice(pos.current_price)}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">
                      {formatPrice(pos.market_value)}
                    </td>
                    <td className="px-4 py-3">
                      <div
                        className={cn(
                          'text-sm font-bold',
                          pos.unrealized_pl >= 0 ? 'text-green-600' : 'text-red-600'
                        )}
                      >
                        {formatPrice(pos.unrealized_pl)}
                      </div>
                      <div
                        className={cn(
                          'text-xs',
                          pos.unrealized_pl_percent >= 0 ? 'text-green-500' : 'text-red-500'
                        )}
                      >
                        {formatPercent(pos.unrealized_pl_percent)}
                      </div>
                    </td>
                    {showGreeks && (
                      <>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {formatGreek(pos.delta)}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {formatGreek(pos.theta)}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {pos.implied_volatility !== null
                            ? `${(pos.implied_volatility * 100).toFixed(1)}%`
                            : '-'}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Info Banner */}
      <div className="flex items-start gap-2 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm">
        <AlertCircle className="w-4 h-4 text-yellow-600 flex-shrink-0 mt-0.5" />
        <div className="text-yellow-800">
          Positions are updated automatically when you refresh. Greeks may not be available for all contracts.
          Close positions using the Options Chain or Orders interface.
        </div>
      </div>
    </div>
  );
}
