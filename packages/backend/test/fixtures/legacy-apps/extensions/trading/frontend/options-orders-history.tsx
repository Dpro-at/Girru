'use client';

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Filter, X, Calendar, CheckCircle, Clock, XCircle, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { config } from '@/lib/config';

interface OptionsOrder {
  id: number;
  option_symbol: string;
  qty: number;
  side: string;
  order_type: string;
  limit_price: number | null;
  status: string;
  alpaca_order_id: string;
  filled_price: number | null;
  filled_at: string | null;
  placed_at: string;
  placed_by: string;
}

export function OptionsOrdersHistory() {
  const [orders, setOrders] = useState<OptionsOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [limit, setLimit] = useState(50);

  const authHeaders = useCallback(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }, []);

  useEffect(() => {
    loadOrders();
  }, [statusFilter, limit]);

  const loadOrders = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.append('status', statusFilter);
      params.append('limit', limit.toString());

      const res = await fetch(
        `${config.backendUrl}/api/ext/trading/options/orders?${params.toString()}`,
        { headers: authHeaders() }
      );

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to load orders');
      }

      const data = await res.json();
      setOrders(data.orders || []);
    } catch (error: any) {
      console.error('Load orders error:', error);
      toast.error(error.message || 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadOrders();
    setRefreshing(false);
    toast.success('Orders refreshed');
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatPrice = (price: number | null) => {
    return price ? `$${price.toFixed(2)}` : '-';
  };

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'filled':
      case 'complete':
        return 'bg-green-100 text-green-800 border-green-300';
      case 'pending':
      case 'new':
      case 'partially_filled':
        return 'bg-yellow-100 text-yellow-800 border-yellow-300';
      case 'cancelled':
      case 'canceled':
        return 'bg-gray-100 text-gray-800 border-gray-300';
      case 'rejected':
      case 'failed':
        return 'bg-red-100 text-red-800 border-red-300';
      default:
        return 'bg-blue-100 text-blue-800 border-blue-300';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status.toLowerCase()) {
      case 'filled':
      case 'complete':
        return <CheckCircle className="w-4 h-4" />;
      case 'pending':
      case 'new':
      case 'partially_filled':
        return <Clock className="w-4 h-4" />;
      case 'cancelled':
      case 'canceled':
        return <X className="w-4 h-4" />;
      case 'rejected':
      case 'failed':
        return <XCircle className="w-4 h-4" />;
      default:
        return <AlertCircle className="w-4 h-4" />;
    }
  };

  const getSideColor = (side: string) => {
    if (side.toLowerCase().includes('buy')) {
      return 'text-green-700 bg-green-50';
    } else {
      return 'text-red-700 bg-red-50';
    }
  };

  if (loading && orders.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h3 className="text-lg font-bold text-gray-900">Options Orders History</h3>

        <div className="flex flex-wrap items-center gap-2">
          {/* Status Filter */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Statuses</option>
            <option value="filled">Filled</option>
            <option value="pending">Pending</option>
            <option value="cancelled">Cancelled</option>
            <option value="rejected">Rejected</option>
          </select>

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

      {/* Clear Filter Badge */}
      {statusFilter && (
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-100 text-blue-700 rounded-lg text-sm">
            <Filter className="w-4 h-4" />
            <span>
              Status: <strong>{statusFilter}</strong>
            </span>
            <button
              onClick={() => setStatusFilter('')}
              className="hover:bg-blue-200 rounded p-0.5"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Orders List */}
      {orders.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-lg border border-gray-200">
          <Calendar className="w-12 h-12 text-gray-400 mx-auto mb-3" />
          <p className="text-sm text-gray-600">
            {statusFilter
              ? `No ${statusFilter} orders found`
              : 'No options orders yet. Place your first order to see it here.'}
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
                    Side
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Qty
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Limit Price
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Filled Price
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Placed At
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {orders.map((order) => (
                  <tr key={order.id} className="hover:bg-gray-50 transition">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">
                      {order.option_symbol}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'px-2 py-1 rounded text-xs font-medium',
                          getSideColor(order.side)
                        )}
                      >
                        {order.side.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-900">{order.qty}</td>
                    <td className="px-4 py-3 text-sm text-gray-600 uppercase">{order.order_type}</td>
                    <td className="px-4 py-3 text-sm text-gray-900">
                      {formatPrice(order.limit_price)}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">
                      {formatPrice(order.filled_price)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium border',
                          getStatusColor(order.status)
                        )}
                      >
                        {getStatusIcon(order.status)}
                        {order.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {formatDate(order.placed_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Load More */}
      {orders.length >= limit && (
        <div className="text-center">
          <button
            onClick={() => setLimit(limit + 50)}
            className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition text-sm"
          >
            Load More
          </button>
        </div>
      )}
    </div>
  );
}
