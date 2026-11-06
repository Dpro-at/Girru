'use client';

import { useState, useEffect } from 'react';
import {
  X,
  Plus,
  Trash2,
  Save,
  PlayCircle,
  TrendingUp,
  TrendingDown,
  Target,
  DollarSign,
  AlertTriangle,
  Info,
  Layers,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { config } from '@/lib/config';

interface StrategyLeg {
  id: string;
  action: 'buy' | 'sell';
  type: 'call' | 'put';
  strike: number;
  quantity: number;
  premium: number;
}

interface StrategyTemplate {
  name: string;
  description: string;
  legs: Omit<StrategyLeg, 'id'>[];
  category: string;
}

interface StrategyBuilderProps {
  isOpen: boolean;
  onClose: () => void;
  spotPrice?: number;
  symbol?: string;
}

const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  {
    name: 'Covered Call',
    description: 'Buy stock + Sell call. Generates income, limited upside.',
    category: 'Income',
    legs: [
      { action: 'buy', type: 'call', strike: 0, quantity: 1, premium: 0 },
      { action: 'sell', type: 'call', strike: 0, quantity: 1, premium: 0 },
    ],
  },
  {
    name: 'Bull Call Spread',
    description: 'Buy lower strike call + Sell higher strike call. Bullish, limited risk.',
    category: 'Bullish',
    legs: [
      { action: 'buy', type: 'call', strike: 0, quantity: 1, premium: 0 },
      { action: 'sell', type: 'call', strike: 0, quantity: 1, premium: 0 },
    ],
  },
  {
    name: 'Bear Put Spread',
    description: 'Buy higher strike put + Sell lower strike put. Bearish, limited risk.',
    category: 'Bearish',
    legs: [
      { action: 'buy', type: 'put', strike: 0, quantity: 1, premium: 0 },
      { action: 'sell', type: 'put', strike: 0, quantity: 1, premium: 0 },
    ],
  },
  {
    name: 'Iron Condor',
    description: '4-leg strategy. Profit from low volatility. Defined risk.',
    category: 'Neutral',
    legs: [
      { action: 'sell', type: 'put', strike: 0, quantity: 1, premium: 0 },
      { action: 'buy', type: 'put', strike: 0, quantity: 1, premium: 0 },
      { action: 'sell', type: 'call', strike: 0, quantity: 1, premium: 0 },
      { action: 'buy', type: 'call', strike: 0, quantity: 1, premium: 0 },
    ],
  },
  {
    name: 'Long Straddle',
    description: 'Buy call + Buy put at same strike. Profit from big moves either direction.',
    category: 'Volatile',
    legs: [
      { action: 'buy', type: 'call', strike: 0, quantity: 1, premium: 0 },
      { action: 'buy', type: 'put', strike: 0, quantity: 1, premium: 0 },
    ],
  },
  {
    name: 'Short Straddle',
    description: 'Sell call + Sell put at same strike. Profit from low volatility.',
    category: 'Neutral',
    legs: [
      { action: 'sell', type: 'call', strike: 0, quantity: 1, premium: 0 },
      { action: 'sell', type: 'put', strike: 0, quantity: 1, premium: 0 },
    ],
  },
  {
    name: 'Butterfly Spread',
    description: 'Limited risk, limited reward. Profit from low volatility at target price.',
    category: 'Neutral',
    legs: [
      { action: 'buy', type: 'call', strike: 0, quantity: 1, premium: 0 },
      { action: 'sell', type: 'call', strike: 0, quantity: 2, premium: 0 },
      { action: 'buy', type: 'call', strike: 0, quantity: 1, premium: 0 },
    ],
  },
];

export function StrategyBuilder({ isOpen, onClose, spotPrice = 150, symbol = 'STOCK' }: StrategyBuilderProps) {
  const [strategyName, setStrategyName] = useState('');
  const [legs, setLegs] = useState<StrategyLeg[]>([]);
  const [saving, setSaving] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [notes, setNotes] = useState('');

  const authHeaders = () => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  };

  const generateId = () => Math.random().toString(36).substr(2, 9);

  const addLeg = () => {
    setLegs([
      ...legs,
      {
        id: generateId(),
        action: 'buy',
        type: 'call',
        strike: spotPrice,
        quantity: 1,
        premium: 0,
      },
    ]);
  };

  const removeLeg = (id: string) => {
    setLegs(legs.filter((leg) => leg.id !== id));
  };

  const updateLeg = (id: string, field: keyof StrategyLeg, value: any) => {
    setLegs(legs.map((leg) => (leg.id === id ? { ...leg, [field]: value } : leg)));
  };

  const loadTemplate = (template: StrategyTemplate) => {
    setStrategyName(template.name);
    setSelectedTemplate(template.name);
    setLegs(
      template.legs.map((leg) => ({
        ...leg,
        id: generateId(),
        strike: spotPrice,
      }))
    );
    setNotes(template.description);
  };

  const calculateMaxProfit = () => {
    if (legs.length === 0) return 0;

    let maxProfit = 0;
    legs.forEach((leg) => {
      if (leg.action === 'sell') {
        maxProfit += leg.premium * leg.quantity * 100; // Credit received
      } else {
        maxProfit -= leg.premium * leg.quantity * 100; // Debit paid
      }
    });

    return maxProfit;
  };

  const calculateMaxLoss = () => {
    if (legs.length === 0) return 0;

    // Simplified calculation - actual calculation depends on strategy type
    const strikes = legs.map((leg) => leg.strike);
    const maxStrike = Math.max(...strikes);
    const minStrike = Math.min(...strikes);
    const spreadWidth = (maxStrike - minStrike) * 100;

    const netDebit = legs.reduce((sum, leg) => {
      return sum + (leg.action === 'buy' ? leg.premium * leg.quantity * 100 : -leg.premium * leg.quantity * 100);
    }, 0);

    // Max loss is typically net debit for debit spreads
    return Math.abs(netDebit);
  };

  const calculateNetDebit = () => {
    return legs.reduce((sum, leg) => {
      return sum + (leg.action === 'buy' ? leg.premium * leg.quantity * 100 : 0);
    }, 0);
  };

  const calculateNetCredit = () => {
    return legs.reduce((sum, leg) => {
      return sum + (leg.action === 'sell' ? leg.premium * leg.quantity * 100 : 0);
    }, 0);
  };

  const handleSave = async () => {
    if (!strategyName.trim()) {
      toast.error('Please enter a strategy name');
      return;
    }

    if (legs.length === 0) {
      toast.error('Please add at least one leg to the strategy');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/options/strategies`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          name: strategyName,
          strategyType: selectedTemplate || 'Custom',
          legs: legs.map((leg) => ({
            action: leg.action,
            type: leg.type,
            strike: leg.strike,
            quantity: leg.quantity,
            premium: leg.premium,
          })),
          notes,
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to save strategy');
      }

      toast.success('Strategy saved successfully');
      onClose();
    } catch (error: any) {
      console.error('Save strategy error:', error);
      toast.error(error.message || 'Failed to save strategy');
    } finally {
      setSaving(false);
    }
  };

  const handleExecute = () => {
    if (legs.length === 0) {
      toast.error('Please add at least one leg to execute');
      return;
    }

    toast.info('Strategy execution will be implemented in the Orders interface');
    // This will be wired to the Options Orders interface
  };

  const handleReset = () => {
    setStrategyName('');
    setLegs([]);
    setSelectedTemplate(null);
    setNotes('');
  };

  if (!isOpen) return null;

  const maxProfit = calculateMaxProfit();
  const maxLoss = calculateMaxLoss();
  const netDebit = calculateNetDebit();
  const netCredit = calculateNetCredit();

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-xl max-w-6xl w-full my-8">
        {/* Header */}
        <div className="flex items-center justify-between p-4 sm:p-6 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Layers className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg sm:text-xl font-bold text-gray-900">Options Strategy Builder</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg transition">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 sm:p-6 space-y-6 max-h-[calc(100vh-300px)] overflow-y-auto">
          {/* Info Banner */}
          <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm">
            <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="text-blue-800">
              Build multi-leg options strategies by selecting a template or adding legs manually. View profit/loss calculations and save for later execution.
            </div>
          </div>

          {/* Strategy Templates */}
          <div>
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Strategy Templates</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {STRATEGY_TEMPLATES.map((template) => (
                <button
                  key={template.name}
                  onClick={() => loadTemplate(template)}
                  className={cn(
                    'p-3 border-2 rounded-lg text-left transition hover:border-blue-400',
                    selectedTemplate === template.name
                      ? 'border-blue-600 bg-blue-50'
                      : 'border-gray-200 bg-white'
                  )}
                >
                  <div className="text-xs font-semibold text-gray-900 mb-1">{template.name}</div>
                  <div className="text-xs text-gray-600 line-clamp-2">{template.description}</div>
                  <div className="mt-2">
                    <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-700 rounded-full">
                      {template.category}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Strategy Name & Notes */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="strategyName" className="block text-sm font-medium text-gray-700 mb-1">
                Strategy Name <span className="text-red-500">*</span>
              </label>
              <input
                id="strategyName"
                type="text"
                value={strategyName}
                onChange={(e) => setStrategyName(e.target.value)}
                placeholder="My Bull Call Spread"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label htmlFor="notes" className="block text-sm font-medium text-gray-700 mb-1">
                Notes (Optional)
              </label>
              <input
                id="notes"
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Strategy notes..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Legs */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-900">Strategy Legs</h3>
              <button
                onClick={addLeg}
                className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition text-sm flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>Add Leg</span>
              </button>
            </div>

            {legs.length === 0 ? (
              <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
                <Layers className="w-12 h-12 text-gray-400 mx-auto mb-2" />
                <p className="text-sm text-gray-600">
                  No legs added. Select a template or click Add Leg to start building your strategy.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {legs.map((leg, index) => (
                  <div key={leg.id} className="p-4 border border-gray-300 rounded-lg bg-gray-50">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-sm font-semibold text-gray-700">Leg {index + 1}</span>
                      <button
                        onClick={() => removeLeg(leg.id)}
                        className="p-1 hover:bg-red-100 rounded transition"
                      >
                        <Trash2 className="w-4 h-4 text-red-600" />
                      </button>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                      {/* Action */}
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Action</label>
                        <select
                          value={leg.action}
                          onChange={(e) => updateLeg(leg.id, 'action', e.target.value)}
                          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          <option value="buy">Buy</option>
                          <option value="sell">Sell</option>
                        </select>
                      </div>

                      {/* Type */}
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
                        <select
                          value={leg.type}
                          onChange={(e) => updateLeg(leg.id, 'type', e.target.value)}
                          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          <option value="call">Call</option>
                          <option value="put">Put</option>
                        </select>
                      </div>

                      {/* Strike */}
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Strike</label>
                        <input
                          type="number"
                          step="0.01"
                          value={leg.strike}
                          onChange={(e) => updateLeg(leg.id, 'strike', parseFloat(e.target.value) || 0)}
                          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>

                      {/* Quantity */}
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Qty</label>
                        <input
                          type="number"
                          step="1"
                          value={leg.quantity}
                          onChange={(e) => updateLeg(leg.id, 'quantity', parseInt(e.target.value) || 1)}
                          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>

                      {/* Premium */}
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Premium</label>
                        <input
                          type="number"
                          step="0.01"
                          value={leg.premium}
                          onChange={(e) => updateLeg(leg.id, 'premium', parseFloat(e.target.value) || 0)}
                          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Profit/Loss Summary */}
          {legs.length > 0 && (
            <div className="border-t border-gray-200 pt-6">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Strategy Summary</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                  <div className="flex items-center gap-1.5 mb-1">
                    <TrendingUp className="w-4 h-4 text-green-600" />
                    <span className="text-xs font-medium text-green-700">Max Profit</span>
                  </div>
                  <div className="text-lg font-bold text-green-900">
                    ${Math.abs(maxProfit).toFixed(2)}
                  </div>
                </div>

                <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                  <div className="flex items-center gap-1.5 mb-1">
                    <TrendingDown className="w-4 h-4 text-red-600" />
                    <span className="text-xs font-medium text-red-700">Max Loss</span>
                  </div>
                  <div className="text-lg font-bold text-red-900">
                    ${maxLoss.toFixed(2)}
                  </div>
                </div>

                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <div className="flex items-center gap-1.5 mb-1">
                    <DollarSign className="w-4 h-4 text-blue-600" />
                    <span className="text-xs font-medium text-blue-700">Net Debit</span>
                  </div>
                  <div className="text-lg font-bold text-blue-900">
                    ${netDebit.toFixed(2)}
                  </div>
                </div>

                <div className="p-3 bg-purple-50 border border-purple-200 rounded-lg">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Target className="w-4 h-4 text-purple-600" />
                    <span className="text-xs font-medium text-purple-700">Net Credit</span>
                  </div>
                  <div className="text-lg font-bold text-purple-900">
                    ${netCredit.toFixed(2)}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Risk Warning */}
          {legs.length > 0 && (
            <div className="flex items-start gap-2 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm">
              <AlertTriangle className="w-4 h-4 text-yellow-600 flex-shrink-0 mt-0.5" />
              <div className="text-yellow-800">
                <strong>Risk Warning:</strong> These calculations are estimates. Actual profit/loss depends on execution prices, commissions, and market conditions. Always verify before executing.
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="border-t border-gray-200 p-4 sm:p-6 bg-gray-50 flex flex-wrap gap-2 justify-end">
          <button
            onClick={handleReset}
            className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition font-medium"
          >
            Reset
          </button>
          <button
            onClick={handleExecute}
            disabled={executing || legs.length === 0}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-medium disabled:opacity-50 flex items-center gap-2"
          >
            <PlayCircle className="w-4 h-4" />
            <span>Execute</span>
          </button>
          <button
            onClick={handleSave}
            disabled={saving || legs.length === 0}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium disabled:opacity-50 flex items-center gap-2"
          >
            {saving ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                <span>Saving...</span>
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                <span>Save Strategy</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
