'use client';

import { useState } from 'react';
import { X, ShoppingCart, TrendingUp, TrendingDown, AlertTriangle, DollarSign, Calendar } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { config } from '@/lib/config';

interface OptionsOrderDialogProps {
  isOpen: boolean;
  onClose: () => void;
  symbol?: string;
  strikePrice?: number;
  expirationDate?: string;
  optionType?: 'call' | 'put';
  currentPrice?: number;
}

export function OptionsOrderDialog({
  isOpen,
  onClose,
  symbol = '',
  strikePrice = 0,
  expirationDate = '',
  optionType = 'call',
  currentPrice = 0,
}: OptionsOrderDialogProps) {
  const [side, setSide] = useState<'buy_to_open' | 'buy_to_close' | 'sell_to_open' | 'sell_to_close'>('buy_to_open');
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [quantity, setQuantity] = useState(1);
  const [limitPrice, setLimitPrice] = useState(currentPrice);
  const [placing, setPlacing] = useState(false);

  const authHeaders = () => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  };

  const handlePlaceOrder = async () => {
    if (!symbol || !strikePrice || !expirationDate) {
      toast.error('Missing required contract information');
      return;
    }

    if (quantity <= 0) {
      toast.error('Quantity must be greater than 0');
      return;
    }

    if (orderType === 'limit' && limitPrice <= 0) {
      toast.error('Limit price must be greater than 0');
      return;
    }

    setPlacing(true);
    try {
      const optionSymbol = `${symbol}${expirationDate.replace(/-/g, '')}${optionType.toUpperCase()}${strikePrice}`;

      const res = await fetch(`${config.backendUrl}/api/ext/trading/options/orders`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          optionSymbol,
          qty: quantity,
          side,
          orderType,
          limitPrice: orderType === 'limit' ? limitPrice : undefined,
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to place order');
      }

      const data = await res.json();
      toast.success(`Order placed successfully! Order ID: ${data.order.id}`);
      onClose();
    } catch (error: any) {
      console.error('Place order error:', error);
      toast.error(error.message || 'Failed to place order');
    } finally {
      setPlacing(false);
    }
  };

  const calculateEstimatedCost = () => {
    const price = orderType === 'limit' ? limitPrice : currentPrice;
    return price * quantity * 100; // 100 shares per contract
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  if (!isOpen) return null;

  const estimatedCost = calculateEstimatedCost();
  const isBuy = side.startsWith('buy');

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full">
        {/* Header */}
        <div className="flex items-center justify-between p-4 sm:p-6 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg sm:text-xl font-bold text-gray-900">Place Options Order</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg transition">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 sm:p-6 space-y-4">
          {/* Contract Details */}
          <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
            <h3 className="text-sm font-semibold text-gray-900 mb-2">Contract Details</h3>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-gray-600">Symbol:</span>
                <span className="ml-2 font-semibold text-gray-900">{symbol}</span>
              </div>
              <div>
                <span className="text-gray-600">Type:</span>
                <span className={cn('ml-2 font-semibold', optionType === 'call' ? 'text-green-700' : 'text-red-700')}>
                  {optionType === 'call' ? (
                    <>
                      <TrendingUp className="w-3.5 h-3.5 inline-block mr-1" />
                      Call
                    </>
                  ) : (
                    <>
                      <TrendingDown className="w-3.5 h-3.5 inline-block mr-1" />
                      Put
                    </>
                  )}
                </span>
              </div>
              <div>
                <span className="text-gray-600">Strike:</span>
                <span className="ml-2 font-semibold text-gray-900">${strikePrice.toFixed(2)}</span>
              </div>
              <div>
                <span className="text-gray-600">Expiration:</span>
                <span className="ml-2 font-semibold text-gray-900">{formatDate(expirationDate)}</span>
              </div>
              <div className="col-span-2">
                <span className="text-gray-600">Current Price:</span>
                <span className="ml-2 font-semibold text-blue-600">${currentPrice.toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Order Parameters */}
          <div className="space-y-3">
            {/* Side */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Order Side</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setSide('buy_to_open')}
                  className={cn(
                    'px-4 py-2 rounded-lg border-2 transition font-medium text-sm',
                    side === 'buy_to_open'
                      ? 'border-green-600 bg-green-50 text-green-700'
                      : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
                  )}
                >
                  Buy to Open
                </button>
                <button
                  onClick={() => setSide('sell_to_open')}
                  className={cn(
                    'px-4 py-2 rounded-lg border-2 transition font-medium text-sm',
                    side === 'sell_to_open'
                      ? 'border-red-600 bg-red-50 text-red-700'
                      : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
                  )}
                >
                  Sell to Open
                </button>
                <button
                  onClick={() => setSide('buy_to_close')}
                  className={cn(
                    'px-4 py-2 rounded-lg border-2 transition font-medium text-sm',
                    side === 'buy_to_close'
                      ? 'border-blue-600 bg-blue-50 text-blue-700'
                      : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
                  )}
                >
                  Buy to Close
                </button>
                <button
                  onClick={() => setSide('sell_to_close')}
                  className={cn(
                    'px-4 py-2 rounded-lg border-2 transition font-medium text-sm',
                    side === 'sell_to_close'
                      ? 'border-purple-600 bg-purple-50 text-purple-700'
                      : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
                  )}
                >
                  Sell to Close
                </button>
              </div>
            </div>

            {/* Order Type */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Order Type</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setOrderType('market')}
                  className={cn(
                    'px-4 py-2 rounded-lg border-2 transition font-medium',
                    orderType === 'market'
                      ? 'border-blue-600 bg-blue-50 text-blue-700'
                      : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
                  )}
                >
                  Market
                </button>
                <button
                  onClick={() => setOrderType('limit')}
                  className={cn(
                    'px-4 py-2 rounded-lg border-2 transition font-medium',
                    orderType === 'limit'
                      ? 'border-blue-600 bg-blue-50 text-blue-700'
                      : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
                  )}
                >
                  Limit
                </button>
              </div>
            </div>

            {/* Quantity */}
            <div>
              <label htmlFor="quantity" className="block text-sm font-medium text-gray-700 mb-1">
                Quantity (Contracts)
              </label>
              <input
                id="quantity"
                type="number"
                step="1"
                min="1"
                value={quantity}
                onChange={(e) => setQuantity(parseInt(e.target.value) || 1)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Limit Price (only for limit orders) */}
            {orderType === 'limit' && (
              <div>
                <label htmlFor="limitPrice" className="block text-sm font-medium text-gray-700 mb-1">
                  Limit Price (per contract)
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">$</span>
                  <input
                    id="limitPrice"
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={limitPrice}
                    onChange={(e) => setLimitPrice(parseFloat(e.target.value) || 0)}
                    className="w-full pl-7 pr-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
            )}

            {/* Estimated Cost */}
            <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <DollarSign className="w-5 h-5 text-blue-600" />
                  <span className="text-sm font-medium text-blue-700">
                    Estimated {isBuy ? 'Cost' : 'Credit'}
                  </span>
                </div>
                <span className="text-2xl font-bold text-blue-900">
                  ${estimatedCost.toFixed(2)}
                </span>
              </div>
              <p className="text-xs text-blue-600 mt-1">
                {quantity} contract{quantity !== 1 ? 's' : ''} × ${orderType === 'limit' ? limitPrice.toFixed(2) : currentPrice.toFixed(2)} × 100 shares
              </p>
            </div>
          </div>

          {/* Warning */}
          <div className="flex items-start gap-2 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm">
            <AlertTriangle className="w-4 h-4 text-yellow-600 flex-shrink-0 mt-0.5" />
            <div className="text-yellow-800">
              <strong>Warning:</strong> Options trading involves significant risk. Ensure you understand the risks before placing this order. This order cannot be undone once executed.
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="border-t border-gray-200 p-4 sm:p-6 bg-gray-50 flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handlePlaceOrder}
            disabled={placing}
            className={cn(
              'px-4 py-2 rounded-lg transition font-medium disabled:opacity-50 flex items-center gap-2',
              isBuy
                ? 'bg-green-600 text-white hover:bg-green-700'
                : 'bg-red-600 text-white hover:bg-red-700'
            )}
          >
            {placing ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                <span>Placing Order...</span>
              </>
            ) : (
              <>
                <ShoppingCart className="w-4 h-4" />
                <span>Place Order</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
