'use client';

import { useState, useEffect } from 'react';
import {
  Phone,
  Plus,
  RefreshCw,
  Edit2,
  Trash2,
  Save,
  X,
  Loader2,
  PhoneCall,
  CheckCircle2,
  XCircle,
  ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';

const BACKEND_URL =
  typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'http://localhost:41522'
    : process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:41522';

interface PhoneNumber {
  id: number;
  phone_number: string;
  friendly_name: string;
  provider_type: string;
  sid: string;
  capabilities: string;
  status: string;
  created_at: string;
  total_calls?: number;
  total_cost_spent?: number;
  total_duration_seconds?: number;
}

interface Provider {
  id: string;
  provider_name: string;
  display_name: string;
  pricing_info: {
    perMinute: string;
    currency: string;
  };
}

export default function NumbersManagement() {
  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [testingId, setTestingId] = useState<number | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      // Load providers
      const providersRes = await fetch(`${BACKEND_URL}/api/ext/call-center/providers`, { headers });
      const providersData = await providersRes.json();
      if (providersData.success) {
        setProviders(
          providersData.providers.map((p: any) => ({
            ...p,
            pricing_info: JSON.parse(p.pricing_info),
          }))
        );
      }

      // Load numbers
      const numbersRes = await fetch(`${BACKEND_URL}/api/ext/call-center/numbers`, { headers });
      const numbersData = await numbersRes.json();
      if (numbersData.success) {
        setNumbers(numbersData.numbers || []);
      }
    } catch (error) {
      console.error('[Numbers Management] Load error:', error);
      toast.error('Failed to load data');
    } finally {
      setLoading(false);
    }
  }

  async function syncNumbers() {
    try {
      setSyncing(true);
      toast.info('Syncing phone numbers from provider...');

      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/numbers/sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.synced > 0) {
          toast.success(`Successfully synced ${data.synced} new phone numbers!`);
        } else {
          toast.info('No new phone numbers found. All numbers are already synced.');
        }
        await loadData();
      } else {
        const error = await res.json();
        toast.error(`Sync failed: ${error.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('[Numbers Management] Sync error:', error);
      toast.error('Failed to sync phone numbers');
    } finally {
      setSyncing(false);
    }
  }

  async function toggleStatus(numberId: number, currentStatus: string) {
    const newStatus = currentStatus === 'active' ? 'suspended' : 'active';

    try {
      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/numbers/${numberId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ status: newStatus }),
      });

      if (res.ok) {
        toast.success(`Number ${newStatus === 'active' ? 'activated' : 'deactivated'} successfully`);
        await loadData();
      } else {
        toast.error('Failed to update status');
      }
    } catch (error) {
      console.error('[Numbers Management] Toggle status error:', error);
      toast.error('Failed to update status');
    }
  }

  async function saveEdit(numberId: number) {
    try {
      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/numbers/${numberId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ friendly_name: editName }),
      });

      if (res.ok) {
        toast.success('Name updated successfully');
        setEditingId(null);
        await loadData();
      } else {
        toast.error('Failed to update name');
      }
    } catch (error) {
      console.error('[Numbers Management] Save edit error:', error);
      toast.error('Failed to update name');
    }
  }

  async function deleteNumber(numberId: number, phoneNumber: string) {
    if (!confirm(`Are you sure you want to delete ${phoneNumber}?`)) return;

    try {
      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/numbers/${numberId}`, {
        method: 'DELETE',
        headers,
      });

      if (res.ok) {
        toast.success('Number deleted successfully');
        await loadData();
      } else {
        toast.error('Failed to delete number');
      }
    } catch (error) {
      console.error('[Numbers Management] Delete error:', error);
      toast.error('Failed to delete number');
    }
  }

  async function testCall(number: PhoneNumber) {
    try {
      setTestingId(number.id);

      const testNumber = prompt('Enter your phone number to receive test call:');
      if (!testNumber) {
        setTestingId(null);
        return;
      }

      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/make-call`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          to: testNumber,
          from: number.phone_number,
          message: 'This is a test call from your Call Center system. Your phone number is working correctly!',
        }),
      });

      if (res.ok) {
        toast.success('Test call initiated successfully!');
      } else {
        const error = await res.json();
        toast.error(`Test call failed: ${error.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('[Numbers Management] Test call error:', error);
      toast.error('Failed to initiate test call');
    } finally {
      setTestingId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-12 h-12 text-blue-600 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Phone Numbers Management</h2>
          <p className="text-sm text-gray-600 mt-1">
            {numbers.length} number{numbers.length !== 1 ? 's' : ''} configured
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => loadData()}
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
          <a
            href="https://www.twilio.com/console/phone-numbers/search"
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Buy Number
          </a>
        </div>
      </div>

      {/* Numbers List */}
      {numbers.length === 0 ? (
        <div className="bg-yellow-50 border-2 border-yellow-200 rounded-xl p-12 text-center">
          <Phone className="w-16 h-16 text-yellow-600 mx-auto mb-4" />
          <h3 className="text-xl font-bold text-gray-900 mb-2">No Phone Numbers Found</h3>
          <p className="text-sm text-gray-600 mb-6">
            Purchase a number from Twilio Console, then refresh this page to see it.
          </p>
          <a
            href="https://www.twilio.com/console/phone-numbers/search"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
          >
            <Plus className="w-5 h-5" />
            Buy Your First Number
          </a>
        </div>
      ) : (
        <div className="space-y-3">
          {numbers.map((num) => {
            const provider = providers.find((p) => p.provider_name === num.provider_type);
            const caps = JSON.parse(num.capabilities || '{}');
            const isEditing = editingId === num.id;

            return (
              <div
                key={num.id}
                className={`bg-white rounded-xl border-2 p-6 transition ${
                  num.status === 'active' ? 'border-green-200' : 'border-gray-200'
                }`}
              >
                <div className="flex items-start justify-between">
                  {/* Left: Number Info */}
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-3">
                      <div
                        className={`p-2 rounded-lg ${
                          num.status === 'active'
                            ? 'bg-green-100'
                            : 'bg-gray-100'
                        }`}
                      >
                        <Phone
                          className={`w-5 h-5 ${
                            num.status === 'active'
                              ? 'text-green-600'
                              : 'text-gray-400'
                          }`}
                        />
                      </div>
                      <div className="flex-1">
                        {isEditing ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              className="flex-1 px-3 py-1 border border-blue-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                              placeholder="Enter friendly name"
                            />
                            <button
                              onClick={() => saveEdit(num.id)}
                              className="p-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition"
                            >
                              <Save className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="p-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center gap-2">
                              <h3 className="text-lg font-bold text-gray-900">
                                {num.phone_number}
                              </h3>
                              {num.status === 'active' ? (
                                <CheckCircle2 className="w-4 h-4 text-green-600" />
                              ) : (
                                <XCircle className="w-4 h-4 text-gray-400" />
                              )}
                            </div>
                            <p className="text-sm text-gray-600">
                              {num.friendly_name || 'No name set'}
                            </p>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Provider & Capabilities */}
                    <div className="grid grid-cols-2 gap-4 mb-3">
                      <div>
                        <div className="text-xs text-gray-500 mb-1">Provider</div>
                        <div className="font-medium text-gray-900">
                          {provider?.display_name || num.provider_type}
                          <span className="text-sm text-gray-600 ml-2">
                            {provider?.pricing_info.perMinute}/min
                          </span>
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500 mb-1">Capabilities</div>
                        <div className="flex flex-wrap gap-1">
                          {caps.voice && (
                            <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded">
                              Voice
                            </span>
                          )}
                          {caps.sms && (
                            <span className="px-2 py-0.5 bg-purple-100 text-purple-700 text-xs rounded">
                              SMS
                            </span>
                          )}
                          {caps.mms && (
                            <span className="px-2 py-0.5 bg-pink-100 text-pink-700 text-xs rounded">
                              MMS
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Usage Stats */}
                    <div className="p-3 bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg border border-blue-200">
                      <div className="grid grid-cols-3 gap-4">
                        <div>
                          <div className="text-xs text-gray-500">Calls</div>
                          <div className="text-lg font-bold text-gray-900">
                            {num.total_calls || 0}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-gray-500">Minutes</div>
                          <div className="text-lg font-bold text-gray-900">
                            {Math.round((num.total_duration_seconds || 0) / 60)}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-gray-500">Cost</div>
                          <div className="text-lg font-bold text-gray-900">
                            ${(num.total_cost_spent || 0).toFixed(2)}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Right: Actions */}
                  <div className="flex flex-col gap-2 ml-4">
                    {/* Status Toggle */}
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={num.status === 'active'}
                        onChange={() => toggleStatus(num.id, num.status)}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-green-600"></div>
                    </label>

                    {/* Edit Button */}
                    <button
                      onClick={() => {
                        setEditingId(num.id);
                        setEditName(num.friendly_name || '');
                      }}
                      className="p-2 bg-blue-100 text-blue-600 rounded-lg hover:bg-blue-200 transition"
                      title="Edit Name"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>

                    {/* Test Call */}
                    <button
                      onClick={() => testCall(num)}
                      disabled={testingId === num.id}
                      className="p-2 bg-green-100 text-green-600 rounded-lg hover:bg-green-200 transition disabled:opacity-50"
                      title="Test Call"
                    >
                      {testingId === num.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <PhoneCall className="w-4 h-4" />
                      )}
                    </button>

                    {/* Delete Button */}
                    <button
                      onClick={() => deleteNumber(num.id, num.phone_number)}
                      className="p-2 bg-red-100 text-red-600 rounded-lg hover:bg-red-200 transition"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
