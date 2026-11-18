'use client';

import { useState } from 'react';
import { X, Calculator, TrendingUp, TrendingDown, Activity, Info } from 'lucide-react';
import { toast } from 'sonner';
import { config } from '@/lib/config';

interface GreeksCalculatorProps {
  isOpen: boolean;
  onClose: () => void;
}

interface GreeksResult {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
  optionPrice?: number;
}

export function GreeksCalculator({ isOpen, onClose }: GreeksCalculatorProps) {
  const [calculating, setCalculating] = useState(false);
  const [optionType, setOptionType] = useState<'call' | 'put'>('call');
  const [spotPrice, setSpotPrice] = useState('');
  const [strikePrice, setStrikePrice] = useState('');
  const [daysToExpiration, setDaysToExpiration] = useState('');
  const [volatility, setVolatility] = useState('');
  const [riskFreeRate, setRiskFreeRate] = useState('4.5'); // Default Fed rate
  const [result, setResult] = useState<GreeksResult | null>(null);

  const authHeaders = () => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  };

  const handleCalculate = async () => {
    // Validate inputs
    if (!spotPrice || !strikePrice || !daysToExpiration || !volatility) {
      toast.error('Please fill in all required fields');
      return;
    }

    const spot = parseFloat(spotPrice);
    const strike = parseFloat(strikePrice);
    const days = parseFloat(daysToExpiration);
    const vol = parseFloat(volatility) / 100; // Convert percentage to decimal
    const rate = parseFloat(riskFreeRate) / 100; // Convert percentage to decimal

    if (spot <= 0 || strike <= 0 || days <= 0 || vol <= 0) {
      toast.error('All values must be positive numbers');
      return;
    }

    setCalculating(true);
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/options/greeks`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          spotPrice: spot,
          strikePrice: strike,
          timeToExpiration: days / 365, // Convert days to years
          riskFreeRate: rate,
          volatility: vol,
          optionType,
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to calculate Greeks');
      }

      const data = await res.json();
      setResult(data.greeks);
      toast.success('Greeks calculated successfully');
    } catch (error: any) {
      console.error('Calculate Greeks error:', error);
      toast.error(error.message || 'Failed to calculate Greeks');
    } finally {
      setCalculating(false);
    }
  };

  const handleReset = () => {
    setSpotPrice('');
    setStrikePrice('');
    setDaysToExpiration('');
    setVolatility('');
    setRiskFreeRate('4.5');
    setResult(null);
  };

  const formatGreek = (value: number) => {
    return value.toFixed(4);
  };

  const getGreekDescription = (greek: string) => {
    switch (greek) {
      case 'delta':
        return 'Rate of change of option price with respect to underlying price. Range: 0 to 1 (calls), 0 to -1 (puts).';
      case 'gamma':
        return 'Rate of change of delta with respect to underlying price. Measures delta sensitivity.';
      case 'theta':
        return 'Rate of change of option price with respect to time (time decay). Usually negative.';
      case 'vega':
        return 'Rate of change of option price with respect to volatility. Always positive.';
      case 'rho':
        return 'Rate of change of option price with respect to risk-free interest rate.';
      default:
        return '';
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 sm:p-6 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Calculator className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg sm:text-xl font-bold text-gray-900">Greeks Calculator</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded-lg transition"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 sm:p-6 space-y-4 sm:space-y-6">
          {/* Info Banner */}
          <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm">
            <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="text-blue-800">
              Calculate option Greeks using the Black-Scholes model. Enter the parameters below to get Delta, Gamma, Theta, Vega, and Rho.
            </div>
          </div>

          {/* Option Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Option Type</label>
            <div className="flex gap-2">
              <button
                onClick={() => setOptionType('call')}
                className={`flex-1 px-4 py-2 rounded-lg border-2 transition font-medium ${
                  optionType === 'call'
                    ? 'border-green-600 bg-green-50 text-green-700'
                    : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
                }`}
              >
                <TrendingUp className="w-4 h-4 inline-block mr-1.5" />
                Call Option
              </button>
              <button
                onClick={() => setOptionType('put')}
                className={`flex-1 px-4 py-2 rounded-lg border-2 transition font-medium ${
                  optionType === 'put'
                    ? 'border-red-600 bg-red-50 text-red-700'
                    : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
                }`}
              >
                <TrendingDown className="w-4 h-4 inline-block mr-1.5" />
                Put Option
              </button>
            </div>
          </div>

          {/* Input Fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Spot Price */}
            <div>
              <label htmlFor="spotPrice" className="block text-sm font-medium text-gray-700 mb-1">
                Spot Price <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">$</span>
                <input
                  id="spotPrice"
                  type="number"
                  step="0.01"
                  value={spotPrice}
                  onChange={(e) => setSpotPrice(e.target.value)}
                  placeholder="150.00"
                  className="w-full pl-7 pr-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <p className="text-xs text-gray-500 mt-1">Current underlying stock price</p>
            </div>

            {/* Strike Price */}
            <div>
              <label htmlFor="strikePrice" className="block text-sm font-medium text-gray-700 mb-1">
                Strike Price <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">$</span>
                <input
                  id="strikePrice"
                  type="number"
                  step="0.01"
                  value={strikePrice}
                  onChange={(e) => setStrikePrice(e.target.value)}
                  placeholder="155.00"
                  className="w-full pl-7 pr-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <p className="text-xs text-gray-500 mt-1">Option contract strike price</p>
            </div>

            {/* Days to Expiration */}
            <div>
              <label htmlFor="daysToExpiration" className="block text-sm font-medium text-gray-700 mb-1">
                Days to Expiration <span className="text-red-500">*</span>
              </label>
              <input
                id="daysToExpiration"
                type="number"
                step="1"
                value={daysToExpiration}
                onChange={(e) => setDaysToExpiration(e.target.value)}
                placeholder="30"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">Time remaining until expiration</p>
            </div>

            {/* Implied Volatility */}
            <div>
              <label htmlFor="volatility" className="block text-sm font-medium text-gray-700 mb-1">
                Implied Volatility <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <input
                  id="volatility"
                  type="number"
                  step="0.1"
                  value={volatility}
                  onChange={(e) => setVolatility(e.target.value)}
                  placeholder="25"
                  className="w-full pl-3 pr-8 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <span className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500">%</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">Annual volatility percentage</p>
            </div>

            {/* Risk-Free Rate */}
            <div className="sm:col-span-2">
              <label htmlFor="riskFreeRate" className="block text-sm font-medium text-gray-700 mb-1">
                Risk-Free Interest Rate
              </label>
              <div className="relative max-w-xs">
                <input
                  id="riskFreeRate"
                  type="number"
                  step="0.1"
                  value={riskFreeRate}
                  onChange={(e) => setRiskFreeRate(e.target.value)}
                  placeholder="4.5"
                  className="w-full pl-3 pr-8 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <span className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500">%</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">Federal funds rate (default: 4.5%)</p>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2">
            <button
              onClick={handleCalculate}
              disabled={calculating}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {calculating ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  <span>Calculating...</span>
                </>
              ) : (
                <>
                  <Calculator className="w-4 h-4" />
                  <span>Calculate Greeks</span>
                </>
              )}
            </button>
            <button
              onClick={handleReset}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition font-medium"
            >
              Reset
            </button>
          </div>

          {/* Results */}
          {result && (
            <div className="border-t border-gray-200 pt-6">
              <div className="flex items-center gap-2 mb-4">
                <Activity className="w-5 h-5 text-green-600" />
                <h3 className="text-lg font-bold text-gray-900">Greeks Results</h3>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* Delta */}
                <div className="p-4 bg-gradient-to-br from-blue-50 to-blue-100 border border-blue-200 rounded-lg">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-blue-700">Delta (Δ)</span>
                    <span className="text-2xl font-bold text-blue-900">{formatGreek(result.delta)}</span>
                  </div>
                  <p className="text-xs text-blue-600">{getGreekDescription('delta')}</p>
                </div>

                {/* Gamma */}
                <div className="p-4 bg-gradient-to-br from-purple-50 to-purple-100 border border-purple-200 rounded-lg">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-purple-700">Gamma (Γ)</span>
                    <span className="text-2xl font-bold text-purple-900">{formatGreek(result.gamma)}</span>
                  </div>
                  <p className="text-xs text-purple-600">{getGreekDescription('gamma')}</p>
                </div>

                {/* Theta */}
                <div className="p-4 bg-gradient-to-br from-orange-50 to-orange-100 border border-orange-200 rounded-lg">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-orange-700">Theta (Θ)</span>
                    <span className="text-2xl font-bold text-orange-900">{formatGreek(result.theta)}</span>
                  </div>
                  <p className="text-xs text-orange-600">{getGreekDescription('theta')}</p>
                </div>

                {/* Vega */}
                <div className="p-4 bg-gradient-to-br from-green-50 to-green-100 border border-green-200 rounded-lg">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-green-700">Vega (ν)</span>
                    <span className="text-2xl font-bold text-green-900">{formatGreek(result.vega)}</span>
                  </div>
                  <p className="text-xs text-green-600">{getGreekDescription('vega')}</p>
                </div>

                {/* Rho */}
                <div className="p-4 bg-gradient-to-br from-pink-50 to-pink-100 border border-pink-200 rounded-lg sm:col-span-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-pink-700">Rho (ρ)</span>
                    <span className="text-2xl font-bold text-pink-900">{formatGreek(result.rho)}</span>
                  </div>
                  <p className="text-xs text-pink-600">{getGreekDescription('rho')}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200 p-4 sm:p-6 bg-gray-50">
          <p className="text-xs text-gray-600 text-center">
            Greeks calculated using the Black-Scholes model. Results are theoretical and may differ from actual market values.
          </p>
        </div>
      </div>
    </div>
  );
}
