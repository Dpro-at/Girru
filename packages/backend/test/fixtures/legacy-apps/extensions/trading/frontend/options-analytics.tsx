'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  BarChart3,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Target,
  Activity,
  DollarSign,
  Percent,
  Calendar,
  Award,
  AlertCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { config } from '@/lib/config';

interface OptionsAnalytics {
  period: string;
  totalTrades: number;
  winningTrades: number;
  winRate: string;
  totalPL: string;
  avgDelta: string;
  avgTheta: string;
  mostTradedSymbols: Array<{ symbol: string; count: number }>;
}

export function OptionsAnalytics() {
  const [analytics, setAnalytics] = useState<OptionsAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [period, setPeriod] = useState<'7d' | '30d' | '90d'>('30d');

  const authHeaders = useCallback(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }, []);

  useEffect(() => {
    loadAnalytics();
  }, [period]);

  const loadAnalytics = async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `${config.backendUrl}/api/ext/trading/options/analytics?period=${period}`,
        { headers: authHeaders() }
      );

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to load analytics');
      }

      const data = await res.json();
      setAnalytics(data.analytics);
    } catch (error: any) {
      console.error('Load analytics error:', error);
      toast.error(error.message || 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadAnalytics();
    setRefreshing(false);
    toast.success('Analytics refreshed');
  };

  if (loading && !analytics) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const winRate = analytics ? parseFloat(analytics.winRate) : 0;
  const totalPL = analytics ? parseFloat(analytics.totalPL) : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-blue-600" />
          <h3 className="text-lg font-bold text-gray-900">Options Analytics</h3>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Period Selector */}
          <div className="flex gap-1 p-1 bg-gray-100 rounded-lg">
            {(['7d', '30d', '90d'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={cn(
                  'px-3 py-1 rounded text-sm font-medium transition',
                  period === p
                    ? 'bg-white text-blue-600 shadow-sm'
                    : 'text-gray-600 hover:text-gray-900'
                )}
              >
                {p === '7d' ? '7 Days' : p === '30d' ? '30 Days' : '90 Days'}
              </button>
            ))}
          </div>

          {/* Refresh Button */}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm flex items-center gap-1.5 disabled:opacity-50"
          >
            <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {!analytics || analytics.totalTrades === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg border border-gray-200">
          <BarChart3 className="w-12 h-12 text-gray-400 mx-auto mb-3" />
          <p className="text-sm text-gray-600">
            No trading data available for the selected period. Start trading to see analytics.
          </p>
        </div>
      ) : (
        <>
          {/* Key Metrics */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Total Trades */}
            <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <Activity className="w-5 h-5 text-blue-600" />
                <span className="text-sm font-medium text-blue-700">Total Trades</span>
              </div>
              <div className="text-3xl font-bold text-blue-900">{analytics.totalTrades}</div>
              <div className="text-xs text-blue-600 mt-1">
                {analytics.winningTrades} winning trades
              </div>
            </div>

            {/* Win Rate */}
            <div
              className={cn(
                'p-4 border rounded-lg',
                winRate >= 50 ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'
              )}
            >
              <div className="flex items-center gap-2 mb-2">
                <Award className={cn('w-5 h-5', winRate >= 50 ? 'text-green-600' : 'text-yellow-600')} />
                <span
                  className={cn(
                    'text-sm font-medium',
                    winRate >= 50 ? 'text-green-700' : 'text-yellow-700'
                  )}
                >
                  Win Rate
                </span>
              </div>
              <div
                className={cn(
                  'text-3xl font-bold',
                  winRate >= 50 ? 'text-green-900' : 'text-yellow-900'
                )}
              >
                {winRate.toFixed(1)}%
              </div>
              <div
                className={cn('text-xs mt-1', winRate >= 50 ? 'text-green-600' : 'text-yellow-600')}
              >
                {winRate >= 50 ? 'Above average' : 'Below average'}
              </div>
            </div>

            {/* Total P/L */}
            <div
              className={cn(
                'p-4 border rounded-lg',
                totalPL >= 0 ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
              )}
            >
              <div className="flex items-center gap-2 mb-2">
                {totalPL >= 0 ? (
                  <TrendingUp className="w-5 h-5 text-green-600" />
                ) : (
                  <TrendingDown className="w-5 h-5 text-red-600" />
                )}
                <span
                  className={cn(
                    'text-sm font-medium',
                    totalPL >= 0 ? 'text-green-700' : 'text-red-700'
                  )}
                >
                  Total P/L
                </span>
              </div>
              <div
                className={cn(
                  'text-3xl font-bold',
                  totalPL >= 0 ? 'text-green-900' : 'text-red-900'
                )}
              >
                ${Math.abs(totalPL).toFixed(2)}
              </div>
              <div className={cn('text-xs mt-1', totalPL >= 0 ? 'text-green-600' : 'text-red-600')}>
                {totalPL >= 0 ? 'Profit' : 'Loss'}
              </div>
            </div>

            {/* Portfolio Greeks */}
            <div className="p-4 bg-purple-50 border border-purple-200 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <Target className="w-5 h-5 text-purple-600" />
                <span className="text-sm font-medium text-purple-700">Avg Delta</span>
              </div>
              <div className="text-3xl font-bold text-purple-900">
                {parseFloat(analytics.avgDelta).toFixed(3)}
              </div>
              <div className="text-xs text-purple-600 mt-1">
                Theta: {parseFloat(analytics.avgTheta).toFixed(3)}
              </div>
            </div>
          </div>

          {/* Most Traded Symbols */}
          {analytics.mostTradedSymbols && analytics.mostTradedSymbols.length > 0 && (
            <div className="p-6 bg-white border border-gray-200 rounded-lg">
              <h4 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <Award className="w-4 h-4 text-gray-600" />
                Most Traded Symbols ({period})
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                {analytics.mostTradedSymbols.map((item, index) => (
                  <div
                    key={item.symbol}
                    className="flex items-center justify-between p-3 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 transition"
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className={cn(
                          'w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold',
                          index === 0
                            ? 'bg-yellow-100 text-yellow-700'
                            : index === 1
                            ? 'bg-gray-200 text-gray-700'
                            : index === 2
                            ? 'bg-orange-100 text-orange-700'
                            : 'bg-blue-100 text-blue-700'
                        )}
                      >
                        #{index + 1}
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-gray-900">{item.symbol}</div>
                        <div className="text-xs text-gray-500">{item.count} trades</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Performance Summary */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Trading Stats */}
            <div className="p-6 bg-white border border-gray-200 rounded-lg">
              <h4 className="text-sm font-semibold text-gray-900 mb-4">Trading Performance</h4>
              <div className="space-y-3">
                <div className="flex items-center justify-between py-2 border-b border-gray-100">
                  <span className="text-sm text-gray-600">Total Trades</span>
                  <span className="text-sm font-semibold text-gray-900">
                    {analytics.totalTrades}
                  </span>
                </div>
                <div className="flex items-center justify-between py-2 border-b border-gray-100">
                  <span className="text-sm text-gray-600">Winning Trades</span>
                  <span className="text-sm font-semibold text-green-600">
                    {analytics.winningTrades}
                  </span>
                </div>
                <div className="flex items-center justify-between py-2 border-b border-gray-100">
                  <span className="text-sm text-gray-600">Losing Trades</span>
                  <span className="text-sm font-semibold text-red-600">
                    {analytics.totalTrades - analytics.winningTrades}
                  </span>
                </div>
                <div className="flex items-center justify-between py-2">
                  <span className="text-sm text-gray-600">Win Rate</span>
                  <span
                    className={cn(
                      'text-sm font-semibold',
                      winRate >= 50 ? 'text-green-600' : 'text-yellow-600'
                    )}
                  >
                    {winRate.toFixed(2)}%
                  </span>
                </div>
              </div>
            </div>

            {/* Greeks Summary */}
            <div className="p-6 bg-white border border-gray-200 rounded-lg">
              <h4 className="text-sm font-semibold text-gray-900 mb-4">Portfolio Greeks</h4>
              <div className="space-y-3">
                <div className="flex items-center justify-between py-2 border-b border-gray-100">
                  <span className="text-sm text-gray-600">Avg Delta</span>
                  <span className="text-sm font-semibold text-gray-900">
                    {parseFloat(analytics.avgDelta).toFixed(4)}
                  </span>
                </div>
                <div className="flex items-center justify-between py-2 border-b border-gray-100">
                  <span className="text-sm text-gray-600">Avg Theta</span>
                  <span className="text-sm font-semibold text-gray-900">
                    {parseFloat(analytics.avgTheta).toFixed(4)}
                  </span>
                </div>
                <div className="flex items-center justify-between py-2">
                  <span className="text-sm text-gray-600">Total P/L</span>
                  <span
                    className={cn(
                      'text-sm font-semibold',
                      totalPL >= 0 ? 'text-green-600' : 'text-red-600'
                    )}
                  >
                    ${Math.abs(totalPL).toFixed(2)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Info Banner */}
          <div className="flex items-start gap-2 p-4 bg-blue-50 border border-blue-200 rounded-lg text-sm">
            <AlertCircle className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="text-blue-800">
              <strong>Analytics Period:</strong> Showing data for the last {period === '7d' ? '7 days' : period === '30d' ? '30 days' : '90 days'}.
              Analytics are calculated based on your completed trades and current positions.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
