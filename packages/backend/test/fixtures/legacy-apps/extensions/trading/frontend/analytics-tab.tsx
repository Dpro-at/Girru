'use client';

import { TrendingUp, TrendingDown } from 'lucide-react';
import { cn } from '@/lib/utils';

// Import trading chart components
import { PortfolioPerformanceChart } from '@/lib/json-render/registry';
import { AssetAllocationPie } from '@/lib/json-render/registry';

export function AnalyticsTab({ positions, portfolioSnapshots, portfolio }: any) {
  // Calculate portfolio metrics
  const totalValue = portfolio?.portfolio_value || 0;
  const totalCost = positions.reduce((sum: number, pos: any) => sum + (pos.avg_entry_price * pos.qty), 0);
  const totalPL = totalValue - totalCost;
  const totalPLPercent = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;

  // Calculate risk metrics
  const calculateSharpeRatio = () => {
    if (portfolioSnapshots.length < 30) return 0;

    const returns = portfolioSnapshots.slice(1).map((snap: any, i: number) => {
      const prev = portfolioSnapshots[i];
      return ((snap.equity - prev.equity) / prev.equity) * 100;
    });

    const avgReturn = returns.reduce((sum: number, r: number) => sum + r, 0) / returns.length;
    const stdDev = Math.sqrt(
      returns.reduce((sum: number, r: number) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
    );

    // Annualized Sharpe (assuming 252 trading days)
    const annualizedReturn = avgReturn * 252;
    const annualizedStd = stdDev * Math.sqrt(252);

    return annualizedStd !== 0 ? annualizedReturn / annualizedStd : 0;
  };

  const calculateMaxDrawdown = () => {
    if (portfolioSnapshots.length < 2) return 0;

    let maxValue = portfolioSnapshots[0]?.equity || 0;
    let maxDrawdown = 0;

    portfolioSnapshots.forEach((snap: any) => {
      if (snap.equity > maxValue) maxValue = snap.equity;
      const drawdown = ((maxValue - snap.equity) / maxValue) * 100;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    });

    return maxDrawdown;
  };

  const calculateVolatility = () => {
    if (portfolioSnapshots.length < 30) return 0;

    const returns = portfolioSnapshots.slice(1).map((snap: any, i: number) => {
      const prev = portfolioSnapshots[i];
      return ((snap.equity - prev.equity) / prev.equity) * 100;
    });

    const avgReturn = returns.reduce((sum: number, r: number) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum: number, r: number) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;

    // Annualized volatility
    return Math.sqrt(variance) * Math.sqrt(252);
  };

  const sharpeRatio = calculateSharpeRatio();
  const maxDrawdown = calculateMaxDrawdown();
  const volatility = calculateVolatility();
  const beta = 1.0; // TODO: Calculate against SPY benchmark

  // Prepare chart data
  const performanceData = portfolioSnapshots.map((snap: any) => ({
    date: new Date(snap.created_at).toLocaleDateString(),
    portfolioValue: snap.equity,
    benchmarkValue: snap.equity * 0.95, // Mock SPY data (95% of portfolio)
  }));

  const allocationData = positions.map((pos: any) => ({
    symbol: pos.symbol,
    name: pos.symbol,
    value: pos.market_value,
    percentage: parseFloat(((pos.market_value / totalValue) * 100).toFixed(1)),
  }));

  // Top gainers/losers
  const positionsWithPL = positions.map((pos: any) => ({
    ...pos,
    pl: pos.unrealized_pl,
    plPercent: pos.unrealized_plpc * 100,
  })).sort((a: any, b: any) => b.pl - a.pl);

  const topGainers = positionsWithPL.filter((p: any) => p.pl > 0).slice(0, 5);
  const topLosers = positionsWithPL.filter((p: any) => p.pl < 0).slice(0, 5);

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Risk Metrics Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-gradient-to-br from-blue-50 to-blue-100 p-3 sm:p-4 rounded-lg">
          <p className="text-xs sm:text-sm text-blue-700 font-medium">Sharpe Ratio</p>
          <p className="text-xl sm:text-2xl font-bold text-blue-900">{sharpeRatio.toFixed(2)}</p>
          <p className="text-xs text-blue-600 mt-1 hidden sm:block">
            {sharpeRatio > 1 ? 'Excellent' : sharpeRatio > 0.5 ? 'Good' : 'Poor'} risk-adjusted return
          </p>
        </div>

        <div className="bg-gradient-to-br from-purple-50 to-purple-100 p-3 sm:p-4 rounded-lg">
          <p className="text-xs sm:text-sm text-purple-700 font-medium">Beta</p>
          <p className="text-xl sm:text-2xl font-bold text-purple-900">{beta.toFixed(2)}</p>
          <p className="text-xs text-purple-600 mt-1 hidden sm:block">
            {beta > 1 ? 'More volatile' : 'Less volatile'} than market
          </p>
        </div>

        <div className="bg-gradient-to-br from-red-50 to-red-100 p-3 sm:p-4 rounded-lg">
          <p className="text-xs sm:text-sm text-red-700 font-medium">Max Drawdown</p>
          <p className="text-xl sm:text-2xl font-bold text-red-900">-{maxDrawdown.toFixed(2)}%</p>
          <p className="text-xs text-red-600 mt-1 hidden sm:block">
            Largest peak-to-trough decline
          </p>
        </div>

        <div className="bg-gradient-to-br from-orange-50 to-orange-100 p-3 sm:p-4 rounded-lg">
          <p className="text-xs sm:text-sm text-orange-700 font-medium">Volatility</p>
          <p className="text-xl sm:text-2xl font-bold text-orange-900">{volatility.toFixed(2)}%</p>
          <p className="text-xs text-orange-600 mt-1 hidden sm:block">
            Annualized standard deviation
          </p>
        </div>
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        {/* Portfolio Performance Chart */}
        <div className="bg-white border border-gray-200 rounded-lg p-4 sm:p-6">
          <h3 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4">Portfolio Performance</h3>
          {performanceData.length > 0 ? (
            <div className="text-sm text-gray-500 text-center py-12">
              Chart will render here using PortfolioPerformanceChart component
            </div>
          ) : (
            <p className="text-sm text-gray-500 text-center py-12">No historical data available</p>
          )}
        </div>

        {/* Asset Allocation Pie */}
        <div className="bg-white border border-gray-200 rounded-lg p-4 sm:p-6">
          <h3 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4">Asset Allocation</h3>
          {allocationData.length > 0 ? (
            <div className="text-xs sm:text-sm text-gray-500 text-center py-8 sm:py-12">
              Chart will render here using AssetAllocationPie component
            </div>
          ) : (
            <p className="text-xs sm:text-sm text-gray-500 text-center py-8 sm:py-12">No positions to display</p>
          )}
        </div>
      </div>

      {/* Top Gainers / Losers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        {/* Top Gainers */}
        <div className="bg-white border border-gray-200 rounded-lg p-4 sm:p-6">
          <h3 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4 flex items-center gap-2">
            <TrendingUp className="w-4 h-4 sm:w-5 sm:h-5 text-green-600" />
            Top Gainers
          </h3>
          {topGainers.length > 0 ? (
            <div className="space-y-2 sm:space-y-3">
              {topGainers.map((pos: any, idx: number) => (
                <div key={idx} className="flex items-center justify-between p-2 sm:p-3 bg-green-50 rounded-lg">
                  <div className="min-w-0 flex-1">
                    <p className="font-bold font-mono text-sm sm:text-base">{pos.symbol}</p>
                    <p className="text-xs text-gray-600 truncate">{pos.qty} shares @ ${pos.avg_entry_price.toFixed(2)}</p>
                  </div>
                  <div className="text-right ml-2">
                    <p className="font-semibold text-green-600 text-sm sm:text-base whitespace-nowrap">+${pos.pl.toFixed(2)}</p>
                    <p className="text-xs text-green-600">+{pos.plPercent.toFixed(2)}%</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500 text-center py-8">No profitable positions</p>
          )}
        </div>

        {/* Top Losers */}
        <div className="bg-white border border-gray-200 rounded-lg p-4 sm:p-6">
          <h3 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4 flex items-center gap-2">
            <TrendingDown className="w-4 h-4 sm:w-5 sm:h-5 text-red-600" />
            Top Losers
          </h3>
          {topLosers.length > 0 ? (
            <div className="space-y-2 sm:space-y-3">
              {topLosers.map((pos: any, idx: number) => (
                <div key={idx} className="flex items-center justify-between p-2 sm:p-3 bg-red-50 rounded-lg">
                  <div className="min-w-0 flex-1">
                    <p className="font-bold font-mono text-sm sm:text-base">{pos.symbol}</p>
                    <p className="text-xs text-gray-600 truncate">{pos.qty} shares @ ${pos.avg_entry_price.toFixed(2)}</p>
                  </div>
                  <div className="text-right ml-2">
                    <p className="font-semibold text-red-600 text-sm sm:text-base whitespace-nowrap">${pos.pl.toFixed(2)}</p>
                    <p className="text-xs text-red-600">{pos.plPercent.toFixed(2)}%</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs sm:text-sm text-gray-500 text-center py-6 sm:py-8">No losing positions</p>
          )}
        </div>
      </div>

      {/* Portfolio Summary Table */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 sm:p-6">
        <h3 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4">Portfolio Summary</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
          <div>
            <p className="text-xs sm:text-sm text-gray-600">Total Value</p>
            <p className="text-base sm:text-xl font-bold font-mono">${totalValue.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs sm:text-sm text-gray-600">Total Cost</p>
            <p className="text-base sm:text-xl font-bold font-mono">${totalCost.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs sm:text-sm text-gray-600">Total P/L</p>
            <p className={cn('text-base sm:text-xl font-bold font-mono', totalPL >= 0 ? 'text-green-600' : 'text-red-600')}>
              {totalPL >= 0 ? '+' : ''}${totalPL.toFixed(2)}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Return %</p>
            <p className={cn('text-xl font-bold font-mono', totalPLPercent >= 0 ? 'text-green-600' : 'text-red-600')}>
              {totalPLPercent >= 0 ? '+' : ''}{totalPLPercent.toFixed(2)}%
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
