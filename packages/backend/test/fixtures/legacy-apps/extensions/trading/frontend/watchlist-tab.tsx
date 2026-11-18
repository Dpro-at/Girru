'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Plus,
  Trash2,
  Edit2,
  Save,
  X,
  Bell,
  BellOff,
  Download,
  Upload,
  TrendingUp,
  TrendingDown,
  GripVertical,
  MoreVertical
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { config } from '@/lib/config';

// Drag and Drop (optional - can be implemented later)
// import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
// import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
// import { useSortable } from '@dnd-kit/sortable';
// import { CSS } from '@dnd-kit/utilities';

interface WatchlistGroup {
  id: string;
  name: string;
  description?: string;
  color: string;
  icon?: string;
  display_order: number;
  is_default: number;
  created_at: string;
}

interface WatchlistItem {
  id: string;
  symbol: string;
  asset_class: string;
  name?: string;
  notes?: string;
  display_order: number;
  watchlist_group_id?: string;
  currentPrice?: number;
  priceChange?: number;
  priceChangePercent?: number;
}

interface PriceAlert {
  id: string;
  symbol: string;
  asset_class: string;
  alert_type: 'above' | 'below' | 'percent_change';
  target_price?: number;
  target_percent?: number;
  is_active: number;
  repeat_alert: number;
  notification_channels: string[];
  last_triggered_at?: string;
  trigger_count: number;
  created_at: string;
  expires_at?: string;
}

export function WatchlistTab({ priceUpdates }: { priceUpdates: Record<string, any> }) {
  const [groups, setGroups] = useState<WatchlistGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([]);
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);

  const [showAddGroup, setShowAddGroup] = useState(false);
  const [showAddSymbol, setShowAddSymbol] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);

  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupColor, setNewGroupColor] = useState('#3B82F6');
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editGroupName, setEditGroupName] = useState('');

  const [newSymbol, setNewSymbol] = useState('');
  const [newAssetClass, setNewAssetClass] = useState('us_equity');
  const [newSymbolName, setNewSymbolName] = useState('');

  const [showAddAlert, setShowAddAlert] = useState(false);
  const [alertForm, setAlertForm] = useState({
    symbol: '',
    alert_type: 'above' as 'above' | 'below' | 'percent_change',
    target_price: '',
    target_percent: '',
    notification_channels: ['in_app']
  });

  const [loading, setLoading] = useState(true);

  const authHeaders = useCallback(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }, []);

  // ============================================================================
  // DATA LOADING
  // ============================================================================

  const loadGroups = useCallback(async () => {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/watchlist/groups`, {
        headers: authHeaders()
      });
      if (!res.ok) throw new Error('Failed to load watchlist groups');
      const data = await res.json();
      setGroups(data.groups || []);

      // Set active group to default or first
      if (data.groups && data.groups.length > 0) {
        const defaultGroup = data.groups.find((g: WatchlistGroup) => g.is_default === 1);
        setActiveGroupId(defaultGroup?.id || data.groups[0].id);
      }
    } catch (error: any) {
      console.error('Load groups error:', error);
      toast.error('Failed to load watchlist groups');
    }
  }, [authHeaders]);

  const loadWatchlist = useCallback(async () => {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/watchlist`, {
        headers: authHeaders()
      });
      if (!res.ok) throw new Error('Failed to load watchlist');
      const data = await res.json();
      setWatchlistItems(data.watchlist || []);
    } catch (error: any) {
      console.error('Load watchlist error:', error);
      toast.error('Failed to load watchlist');
    }
  }, [authHeaders]);

  const loadAlerts = useCallback(async () => {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/alerts`, {
        headers: authHeaders()
      });
      if (!res.ok) throw new Error('Failed to load price alerts');
      const data = await res.json();
      setAlerts(data.alerts || []);
    } catch (error: any) {
      console.error('Load alerts error:', error);
      toast.error('Failed to load price alerts');
    }
  }, [authHeaders]);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      await Promise.all([loadGroups(), loadWatchlist(), loadAlerts()]);
      setLoading(false);
    };
    loadData();
  }, [loadGroups, loadWatchlist, loadAlerts]);

  // Update prices from WebSocket
  useEffect(() => {
    if (!priceUpdates) return;

    setWatchlistItems((prev) =>
      prev.map((item) => {
        const update = priceUpdates[item.symbol];
        if (!update) return item;

        return {
          ...item,
          currentPrice: update.price || item.currentPrice,
          priceChange: update.change,
          priceChangePercent: update.changePercent
        };
      })
    );
  }, [priceUpdates]);

  // ============================================================================
  // GROUP MANAGEMENT
  // ============================================================================

  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) {
      toast.error('Group name is required');
      return;
    }

    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/watchlist/groups`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: newGroupName, color: newGroupColor })
      });

      if (!res.ok) throw new Error('Failed to create group');

      const data = await res.json();
      toast.success(`Watchlist "${newGroupName}" created`);

      setGroups((prev) => [...prev, data.group]);
      setNewGroupName('');
      setNewGroupColor('#3B82F6');
      setShowAddGroup(false);
    } catch (error: any) {
      console.error('Create group error:', error);
      toast.error('Failed to create watchlist group');
    }
  };

  const handleRenameGroup = async (groupId: string) => {
    if (!editGroupName.trim()) return;

    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/watchlist/groups/${groupId}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ name: editGroupName })
      });

      if (!res.ok) throw new Error('Failed to rename group');

      toast.success('Watchlist renamed');
      setGroups((prev) =>
        prev.map((g) => (g.id === groupId ? { ...g, name: editGroupName } : g))
      );
      setEditingGroupId(null);
    } catch (error: any) {
      console.error('Rename group error:', error);
      toast.error('Failed to rename watchlist');
    }
  };

  const handleDeleteGroup = async (groupId: string, groupName: string) => {
    if (!confirm(`Delete watchlist "${groupName}"? Symbols will be moved to default watchlist.`)) {
      return;
    }

    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/watchlist/groups/${groupId}`, {
        method: 'DELETE',
        headers: authHeaders()
      });

      if (!res.ok) throw new Error('Failed to delete group');

      toast.success('Watchlist deleted');
      setGroups((prev) => prev.filter((g) => g.id !== groupId));

      if (activeGroupId === groupId) {
        setActiveGroupId(groups[0]?.id || null);
      }

      await loadWatchlist(); // Refresh to show moved items
    } catch (error: any) {
      console.error('Delete group error:', error);
      toast.error('Failed to delete watchlist');
    }
  };

  // ============================================================================
  // WATCHLIST ITEMS
  // ============================================================================

  const handleAddSymbol = async () => {
    if (!newSymbol.trim()) {
      toast.error('Symbol is required');
      return;
    }

    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/watchlist`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          symbol: newSymbol.toUpperCase(),
          asset_class: newAssetClass,
          name: newSymbolName || undefined,
          watchlist_group_id: activeGroupId
        })
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to add symbol');
      }

      toast.success(`${newSymbol.toUpperCase()} added to watchlist`);
      setNewSymbol('');
      setNewSymbolName('');
      setShowAddSymbol(false);
      await loadWatchlist();
    } catch (error: any) {
      console.error('Add symbol error:', error);
      toast.error(error.message || 'Failed to add symbol');
    }
  };

  const handleRemoveSymbol = async (symbol: string) => {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/watchlist/${symbol}`, {
        method: 'DELETE',
        headers: authHeaders()
      });

      if (!res.ok) throw new Error('Failed to remove symbol');

      toast.success(`${symbol} removed`);
      await loadWatchlist();
    } catch (error: any) {
      console.error('Remove symbol error:', error);
      toast.error('Failed to remove symbol');
    }
  };

  // ============================================================================
  // PRICE ALERTS
  // ============================================================================

  const handleCreateAlert = async () => {
    if (!alertForm.symbol.trim()) {
      toast.error('Symbol is required');
      return;
    }

    if (alertForm.alert_type !== 'percent_change' && !alertForm.target_price) {
      toast.error('Target price is required');
      return;
    }

    if (alertForm.alert_type === 'percent_change' && !alertForm.target_percent) {
      toast.error('Target percent is required');
      return;
    }

    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/alerts`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          symbol: alertForm.symbol.toUpperCase(),
          alert_type: alertForm.alert_type,
          target_price: alertForm.target_price ? parseFloat(alertForm.target_price) : undefined,
          target_percent: alertForm.target_percent
            ? parseFloat(alertForm.target_percent)
            : undefined,
          notification_channels: alertForm.notification_channels
        })
      });

      if (!res.ok) throw new Error('Failed to create alert');

      toast.success('Price alert created');
      setAlertForm({
        symbol: '',
        alert_type: 'above',
        target_price: '',
        target_percent: '',
        notification_channels: ['in_app']
      });
      setShowAddAlert(false);
      await loadAlerts();
    } catch (error: any) {
      console.error('Create alert error:', error);
      toast.error('Failed to create price alert');
    }
  };

  const handleToggleAlert = async (alertId: string, isActive: boolean) => {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/alerts/${alertId}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ is_active: isActive ? 1 : 0 })
      });

      if (!res.ok) throw new Error('Failed to toggle alert');

      toast.success(isActive ? 'Alert activated' : 'Alert paused');
      await loadAlerts();
    } catch (error: any) {
      console.error('Toggle alert error:', error);
      toast.error('Failed to toggle alert');
    }
  };

  const handleDeleteAlert = async (alertId: string) => {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/alerts/${alertId}`, {
        method: 'DELETE',
        headers: authHeaders()
      });

      if (!res.ok) throw new Error('Failed to delete alert');

      toast.success('Alert deleted');
      await loadAlerts();
    } catch (error: any) {
      console.error('Delete alert error:', error);
      toast.error('Failed to delete alert');
    }
  };

  // ============================================================================
  // IMPORT/EXPORT
  // ============================================================================

  const handleExport = async () => {
    try {
      const query = activeGroupId ? `?groupId=${activeGroupId}` : '';
      const res = await fetch(`${config.backendUrl}/api/ext/trading/watchlist/export${query}`, {
        headers: authHeaders()
      });

      if (!res.ok) throw new Error('Failed to export watchlist');

      const csv = await res.text();
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `watchlist_${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);

      toast.success('Watchlist exported');
    } catch (error: any) {
      console.error('Export error:', error);
      toast.error('Failed to export watchlist');
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const csv = await file.text();
      const res = await fetch(`${config.backendUrl}/api/ext/trading/watchlist/import`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ csv, groupId: activeGroupId })
      });

      if (!res.ok) throw new Error('Failed to import watchlist');

      const data = await res.json();
      toast.success(`Imported ${data.successCount} symbols (${data.failCount} failed)`);
      await loadWatchlist();
    } catch (error: any) {
      console.error('Import error:', error);
      toast.error('Failed to import watchlist');
    }

    // Reset file input
    e.target.value = '';
  };

  // ============================================================================
  // RENDER
  // ============================================================================

  const activeGroup = groups.find((g) => g.id === activeGroupId);
  const filteredItems = watchlistItems.filter(
    (item) => item.watchlist_group_id === activeGroupId || (!item.watchlist_group_id && activeGroup?.is_default === 1)
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header Actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAddGroup(true)}
            className="px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" />
            New Watchlist
          </button>

          <button
            onClick={() => setShowAddSymbol(true)}
            className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition text-sm flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" />
            Add Symbol
          </button>

          <button
            onClick={() => setShowAlerts(!showAlerts)}
            className={cn(
              'px-3 py-1.5 rounded-lg transition text-sm flex items-center gap-1.5',
              showAlerts
                ? 'bg-yellow-600 text-white hover:bg-yellow-700'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            )}
          >
            <Bell className="w-4 h-4" />
            Alerts ({alerts.filter((a) => a.is_active === 1).length})
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleExport}
            className="px-3 py-1.5 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition text-sm flex items-center gap-1.5"
          >
            <Download className="w-4 h-4" />
            Export CSV
          </button>

          <label className="px-3 py-1.5 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition text-sm flex items-center gap-1.5 cursor-pointer">
            <Upload className="w-4 h-4" />
            Import CSV
            <input type="file" accept=".csv" onChange={handleImport} className="hidden" />
          </label>
        </div>
      </div>

      {/* Watchlist Tabs */}
      <div className="flex items-center gap-2 border-b border-gray-200 overflow-x-auto pb-2">
        {groups.map((group) => (
          <div
            key={group.id}
            className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-t-lg cursor-pointer transition group',
              activeGroupId === group.id
                ? 'bg-white border-t-2 shadow-sm'
                : 'bg-gray-100 hover:bg-gray-200'
            )}
            style={{
              borderTopColor: activeGroupId === group.id ? group.color : 'transparent'
            }}
            onClick={() => setActiveGroupId(group.id)}
          >
            {editingGroupId === group.id ? (
              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <input
                  type="text"
                  value={editGroupName}
                  onChange={(e) => setEditGroupName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRenameGroup(group.id);
                    if (e.key === 'Escape') setEditingGroupId(null);
                  }}
                  className="px-2 py-1 border border-gray-300 rounded text-sm w-32"
                  autoFocus
                />
                <button
                  onClick={() => handleRenameGroup(group.id)}
                  className="p-1 hover:bg-green-100 rounded"
                >
                  <Save className="w-3.5 h-3.5 text-green-600" />
                </button>
                <button
                  onClick={() => setEditingGroupId(null)}
                  className="p-1 hover:bg-red-100 rounded"
                >
                  <X className="w-3.5 h-3.5 text-red-600" />
                </button>
              </div>
            ) : (
              <>
                <span className="text-sm font-medium">{group.name}</span>
                {group.is_default === 0 && (
                  <div className="hidden group-hover:flex items-center gap-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingGroupId(group.id);
                        setEditGroupName(group.name);
                      }}
                      className="p-1 hover:bg-blue-100 rounded"
                    >
                      <Edit2 className="w-3 h-3 text-blue-600" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteGroup(group.id, group.name);
                      }}
                      className="p-1 hover:bg-red-100 rounded"
                    >
                      <Trash2 className="w-3 h-3 text-red-600" />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {/* Add Group Dialog */}
      {showAddGroup && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-3">Create New Watchlist</h3>
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateGroup()}
              placeholder="Watchlist name (e.g., Tech Stocks)"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
              autoFocus
            />
            <input
              type="color"
              value={newGroupColor}
              onChange={(e) => setNewGroupColor(e.target.value)}
              className="w-12 h-10 border border-gray-300 rounded cursor-pointer"
              title="Choose color"
            />
            <button
              onClick={handleCreateGroup}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm"
            >
              Create
            </button>
            <button
              onClick={() => setShowAddGroup(false)}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Add Symbol Dialog */}
      {showAddSymbol && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <h3 className="text-sm font-semibold mb-3">Add Symbol to {activeGroup?.name}</h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <input
              type="text"
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && handleAddSymbol()}
              placeholder="Symbol (e.g., AAPL)"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm uppercase"
              autoFocus
            />
            <select
              value={newAssetClass}
              onChange={(e) => setNewAssetClass(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="us_equity">Stock</option>
              <option value="crypto">Crypto</option>
              <option value="etf">ETF</option>
            </select>
            <input
              type="text"
              value={newSymbolName}
              onChange={(e) => setNewSymbolName(e.target.value)}
              placeholder="Name (optional)"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={handleAddSymbol}
                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition text-sm"
              >
                Add
              </button>
              <button
                onClick={() => setShowAddSymbol(false)}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Watchlist Items Table */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-2 sm:px-4 py-2 sm:py-3 text-xs font-semibold text-gray-700">Symbol</th>
                <th className="text-left px-2 sm:px-4 py-2 sm:py-3 text-xs font-semibold text-gray-700 hidden sm:table-cell">Type</th>
                <th className="text-right px-2 sm:px-4 py-2 sm:py-3 text-xs font-semibold text-gray-700">Price</th>
                <th className="text-right px-2 sm:px-4 py-2 sm:py-3 text-xs font-semibold text-gray-700 hidden md:table-cell">Change</th>
                <th className="text-right px-2 sm:px-4 py-2 sm:py-3 text-xs font-semibold text-gray-700">Change %</th>
                <th className="text-center px-2 sm:px-4 py-2 sm:py-3 text-xs font-semibold text-gray-700"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 sm:py-12 text-xs sm:text-sm text-gray-500">
                    No symbols in this watchlist. Click "Add Symbol" to get started.
                  </td>
                </tr>
              ) : (
                filteredItems.map((item) => {
                  const isPositive = (item.priceChange || 0) >= 0;

                  return (
                    <tr key={item.id} className="hover:bg-gray-50 transition">
                      <td className="px-2 sm:px-4 py-2 sm:py-3">
                        <div>
                          <p className="font-bold font-mono text-xs sm:text-sm">{item.symbol}</p>
                          {item.name && <p className="text-xs text-gray-500 line-clamp-1">{item.name}</p>}
                        </div>
                      </td>
                      <td className="px-2 sm:px-4 py-2 sm:py-3 hidden sm:table-cell">
                        <span className="inline-block px-2 py-1 bg-gray-100 rounded text-xs font-medium whitespace-nowrap">
                          {item.asset_class === 'us_equity'
                            ? 'Stock'
                            : item.asset_class === 'crypto'
                            ? 'Crypto'
                            : 'ETF'}
                        </span>
                      </td>
                      <td className="text-right px-2 sm:px-4 py-2 sm:py-3 font-mono text-xs sm:text-sm">
                        {item.currentPrice ? `$${item.currentPrice.toFixed(2)}` : '—'}
                      </td>
                      <td className={cn('text-right px-2 sm:px-4 py-2 sm:py-3 font-mono text-xs sm:text-sm font-semibold hidden md:table-cell', isPositive ? 'text-green-600' : 'text-red-600')}>
                        {item.priceChange !== undefined ? (
                          <div className="flex items-center justify-end gap-1">
                            {isPositive ? (
                              <TrendingUp className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                            ) : (
                              <TrendingDown className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                            )}
                            <span>
                              {isPositive ? '+' : ''}${item.priceChange.toFixed(2)}
                            </span>
                          </div>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className={cn('text-right px-2 sm:px-4 py-2 sm:py-3 font-mono text-xs sm:text-sm font-semibold whitespace-nowrap', isPositive ? 'text-green-600' : 'text-red-600')}>
                        {item.priceChangePercent !== undefined
                          ? `${isPositive ? '+' : ''}${item.priceChangePercent.toFixed(2)}%`
                          : '—'}
                      </td>
                      <td className="text-center px-2 sm:px-4 py-2 sm:py-3">
                        <button
                          onClick={() => handleRemoveSymbol(item.symbol)}
                          className="p-1 sm:p-1.5 hover:bg-red-100 rounded transition touch-manipulation"
                          title="Remove from watchlist"
                        >
                          <Trash2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-red-600" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Price Alerts Section */}
      {showAlerts && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">Price Alerts</h3>
            <button
              onClick={() => setShowAddAlert(true)}
              className="px-3 py-1.5 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition text-sm flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              New Alert
            </button>
          </div>

          {/* Add Alert Form */}
          {showAddAlert && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <h4 className="text-sm font-semibold mb-3">Create Price Alert</h4>
              <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                <input
                  type="text"
                  value={alertForm.symbol}
                  onChange={(e) => setAlertForm({ ...alertForm, symbol: e.target.value.toUpperCase() })}
                  placeholder="Symbol"
                  className="px-3 py-2 border border-gray-300 rounded-lg text-sm uppercase"
                />
                <select
                  value={alertForm.alert_type}
                  onChange={(e) =>
                    setAlertForm({
                      ...alertForm,
                      alert_type: e.target.value as 'above' | 'below' | 'percent_change'
                    })
                  }
                  className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
                >
                  <option value="above">Price Above</option>
                  <option value="below">Price Below</option>
                  <option value="percent_change">% Change</option>
                </select>

                {alertForm.alert_type !== 'percent_change' ? (
                  <input
                    type="number"
                    step="0.01"
                    value={alertForm.target_price}
                    onChange={(e) => setAlertForm({ ...alertForm, target_price: e.target.value })}
                    placeholder="Target Price"
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                ) : (
                  <input
                    type="number"
                    step="0.1"
                    value={alertForm.target_percent}
                    onChange={(e) => setAlertForm({ ...alertForm, target_percent: e.target.value })}
                    placeholder="Target %"
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                )}

                <div className="col-span-2 flex gap-2">
                  <button
                    onClick={handleCreateAlert}
                    className="flex-1 px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition text-sm"
                  >
                    Create Alert
                  </button>
                  <button
                    onClick={() => {
                      setShowAddAlert(false);
                      setAlertForm({
                        symbol: '',
                        alert_type: 'above',
                        target_price: '',
                        target_percent: '',
                        notification_channels: ['in_app']
                      });
                    }}
                    className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Alerts List */}
          <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-200">
            {alerts.length === 0 ? (
              <div className="text-center py-12 text-sm text-gray-500">
                No price alerts configured. Create one to get notified when your target is reached.
              </div>
            ) : (
              alerts.map((alert) => (
                <div key={alert.id} className="p-4 flex items-center justify-between hover:bg-gray-50 transition">
                  <div className="flex items-center gap-4">
                    <button
                      onClick={() => handleToggleAlert(alert.id, alert.is_active === 0)}
                      className={cn(
                        'p-2 rounded-lg transition',
                        alert.is_active === 1
                          ? 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200'
                          : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                      )}
                    >
                      {alert.is_active === 1 ? (
                        <Bell className="w-4 h-4" />
                      ) : (
                        <BellOff className="w-4 h-4" />
                      )}
                    </button>

                    <div>
                      <p className="font-bold font-mono text-sm">{alert.symbol}</p>
                      <p className="text-xs text-gray-600">
                        {alert.alert_type === 'above' && `Above $${alert.target_price}`}
                        {alert.alert_type === 'below' && `Below $${alert.target_price}`}
                        {alert.alert_type === 'percent_change' &&
                          `Change ≥ ${alert.target_percent}%`}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    {alert.trigger_count > 0 && (
                      <div className="text-xs text-gray-500">
                        Triggered {alert.trigger_count}x
                      </div>
                    )}
                    <button
                      onClick={() => handleDeleteAlert(alert.id)}
                      className="p-1.5 hover:bg-red-100 rounded transition"
                    >
                      <Trash2 className="w-4 h-4 text-red-600" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
