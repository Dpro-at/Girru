'use client';

import { useState, useEffect } from 'react';
import {
  Phone,
  Check,
  X,
  ExternalLink,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Loader2,
  PhoneCall,
} from 'lucide-react';
import { toast } from 'sonner';

const BACKEND_URL =
  typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'http://localhost:41522'
    : process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:41522';

interface Provider {
  id: string;
  provider_name: string;
  display_name: string;
  enabled: boolean;
  is_default: boolean;
  pricing_info: {
    base: string;
    perMinute: string;
    setup: string;
    monthly?: string;
    domestic?: string;
    international?: string;
    currency: string;
  };
  capabilities: string[];
  status: string;
  health_status?: string;
  last_health_check?: string;
}

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

export default function ProviderSelection() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [healthChecking, setHealthChecking] = useState<string | null>(null);
  const [testingNumber, setTestingNumber] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    loadProvidersAndSync();
  }, []);

  async function loadProvidersAndSync() {
    await loadProviders();

    // Auto-sync if enabled provider has credentials but no numbers
    const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
    if (authToken) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      headers['Authorization'] = `Bearer ${authToken}`;

      // Check if we have credentials
      const credsRes = await fetch(`${BACKEND_URL}/api/credentials`, { headers });
      const credsData = await credsRes.json();
      const hasCredentials = credsData.credentials?.some((c: any) => c.name?.startsWith('telephony.'));

      // If we have credentials but no numbers, auto-sync
      if (hasCredentials && phoneNumbers.length === 0) {
        await syncNumbers();
      }
    }
  }

  async function loadProviders() {
    try {
      const authToken =
        typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      // Load providers
      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/providers`, { headers });
      const data = await res.json();

      if (data.success && data.providers) {
        setProviders(
          data.providers.map((p: any) => ({
            ...p,
            pricing_info: JSON.parse(p.pricing_info),
            capabilities: JSON.parse(p.capabilities),
          }))
        );
      }

      // Load phone numbers
      const numbersRes = await fetch(`${BACKEND_URL}/api/ext/call-center/numbers`, { headers });
      const numbersData = await numbersRes.json();

      if (numbersData.success && numbersData.numbers) {
        setPhoneNumbers(numbersData.numbers);
      }
    } catch (error) {
      console.error('[Provider Selection] Error loading providers:', error);
    } finally {
      setLoading(false);
    }
  }

  async function toggleProvider(providerId: string, enabled: boolean) {
    try {
      const authToken =
        typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/providers/${providerId}/toggle`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ enabled }),
      });

      if (res.ok) {
        await loadProviders();
      }
    } catch (error) {
      console.error('[Provider Selection] Error toggling provider:', error);
    }
  }

  async function setDefaultProvider(providerId: string) {
    try {
      const authToken =
        typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/providers/${providerId}/default`, {
        method: 'POST',
        headers,
      });

      if (res.ok) {
        await loadProviders();
      }
    } catch (error) {
      console.error('[Provider Selection] Error setting default provider:', error);
    }
  }

  async function healthCheck(providerId: string) {
    try {
      setHealthChecking(providerId);

      const authToken =
        typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(
        `${BACKEND_URL}/api/ext/call-center/providers/${providerId}/health-check`,
        { headers }
      );

      if (res.ok) {
        await loadProviders();
      }
    } catch (error) {
      console.error('[Provider Selection] Error checking health:', error);
    } finally {
      setHealthChecking(null);
    }
  }

  async function testNumber(numberId: number) {
    try {
      setTestingNumber(numberId);

      const authToken =
        typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const phoneNum = phoneNumbers.find((n) => n.id === numberId);
      if (!phoneNum) {
        toast.error('Phone number not found');
        return;
      }

      // Make a test call to your own number (user will need to provide this)
      const testNumber = prompt('Enter your phone number to receive test call:');
      if (!testNumber) {
        setTestingNumber(null);
        return;
      }

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/make-call`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          to: testNumber,
          from: phoneNum.phone_number,
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
      console.error('[Provider Selection] Error testing number:', error);
      toast.error('Failed to initiate test call');
    } finally {
      setTestingNumber(null);
    }
  }

  async function syncNumbers() {
    try {
      setSyncing(true);
      toast.info('Syncing phone numbers from provider...');

      const authToken =
        typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/numbers/sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}), // Empty body to satisfy Fastify
      });

      if (res.ok) {
        const data = await res.json();
        if (data.synced > 0) {
          toast.success(`Successfully synced ${data.synced} new phone numbers!`);
        } else {
          toast.info('No new phone numbers found. All numbers are already synced.');
        }
        await loadProviders(); // Reload to show new numbers
      } else {
        const error = await res.json();
        toast.error(`Sync failed: ${error.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('[Provider Selection] Error syncing numbers:', error);
      toast.error('Failed to sync phone numbers');
    } finally {
      setSyncing(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <Loader2 className="w-12 h-12 text-blue-600 animate-spin mx-auto mb-4" />
          <p className="text-gray-600">Loading providers...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Providers Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Telephony Providers</h2>
          <p className="text-sm text-gray-600 mt-1">
            Configured service providers
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={syncNumbers}
            disabled={syncing}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition flex items-center gap-2 disabled:opacity-50"
          >
            {syncing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Syncing...
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4" />
                Sync Numbers
              </>
            )}
          </button>
          <button
            onClick={() => loadProviders()}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
        </div>
      </div>

      {/* Providers Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {providers.filter(p => p.enabled).map((provider) => {
          const providerNumbers = phoneNumbers.filter(n => n.provider_type === provider.provider_name);
          const totalCost = providerNumbers.reduce((sum, n) => sum + (n.total_cost_spent || 0), 0);

          return (
            <div
              key={provider.id}
              className={`bg-white rounded-xl border-2 p-6 transition ${
                provider.is_default
                  ? 'border-blue-500 shadow-lg'
                  : provider.enabled
                  ? 'border-green-200'
                  : 'border-gray-200'
              }`}
            >
              {/* Header */}
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div
                    className={`p-3 rounded-lg ${
                      provider.provider_name === 'twilio'
                        ? 'bg-red-100'
                        : provider.provider_name === 'vonage'
                        ? 'bg-green-100'
                        : 'bg-blue-100'
                    }`}
                  >
                    <Phone
                      className={`w-6 h-6 ${
                        provider.provider_name === 'twilio'
                          ? 'text-red-600'
                          : provider.provider_name === 'vonage'
                          ? 'text-green-600'
                          : 'text-blue-600'
                      }`}
                    />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-gray-900">{provider.display_name}</h3>
                    <div className="flex items-center gap-2 mt-1">
                      {provider.is_default && (
                        <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs font-medium rounded">
                          Default
                        </span>
                      )}
                      {provider.enabled ? (
                        <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs font-medium rounded flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" />
                          {providerNumbers.length} Number{providerNumbers.length !== 1 ? 's' : ''}
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 bg-gray-100 text-gray-700 text-xs font-medium rounded flex items-center gap-1">
                          <XCircle className="w-3 h-3" />
                          Disabled
                        </span>
                      )}
                    </div>
                  </div>
                </div>

              {/* Enable/Disable Toggle */}
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={provider.enabled}
                  onChange={(e) => toggleProvider(provider.id, e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>

            {/* Pricing */}
            <div className="mb-4 p-3 bg-gray-50 rounded-lg">
              <div className="text-xs text-gray-500 mb-2">Pricing ({provider.pricing_info.currency})</div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-gray-600">Base:</span>
                  <span className="font-semibold ml-2">{provider.pricing_info.base}</span>
                </div>
                <div>
                  <span className="text-gray-600">Per Min:</span>
                  <span className="font-semibold ml-2">{provider.pricing_info.perMinute}</span>
                </div>
                {provider.pricing_info.monthly && (
                  <div className="col-span-2">
                    <span className="text-gray-600">Monthly:</span>
                    <span className="font-semibold ml-2">{provider.pricing_info.monthly}</span>
                  </div>
                )}
                {provider.pricing_info.domestic && (
                  <div className="col-span-2">
                    <span className="text-gray-600">Domestic Plan:</span>
                    <span className="font-semibold ml-2">{provider.pricing_info.domestic}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Capabilities */}
            <div className="mb-4">
              <div className="text-xs text-gray-500 mb-2">Capabilities</div>
              <div className="flex flex-wrap gap-1">
                {provider.capabilities.map((cap) => (
                  <span
                    key={cap}
                    className="px-2 py-1 bg-blue-50 text-blue-700 text-xs rounded"
                  >
                    {cap}
                  </span>
                ))}
              </div>
            </div>

            {/* Health Status */}
            {provider.enabled && (
              <div className="mb-4 flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-2">
                  {provider.health_status === 'healthy' ? (
                    <CheckCircle2 className="w-4 h-4 text-green-600" />
                  ) : provider.health_status === 'degraded' ? (
                    <AlertCircle className="w-4 h-4 text-yellow-600" />
                  ) : provider.health_status === 'down' ? (
                    <XCircle className="w-4 h-4 text-red-600" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-gray-400" />
                  )}
                  <span className="text-sm text-gray-600">
                    {provider.health_status || 'Unknown'}
                  </span>
                </div>
                <button
                  onClick={() => healthCheck(provider.id)}
                  disabled={healthChecking === provider.id}
                  className="text-sm text-blue-600 hover:text-blue-700 disabled:opacity-50 flex items-center gap-1"
                >
                  {healthChecking === provider.id ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <RefreshCw className="w-4 h-4" />
                  )}
                  Check
                </button>
              </div>
            )}


            {/* Actions */}
            <div className="flex gap-2">
              {!provider.is_default && provider.enabled && (
                <button
                  onClick={() => setDefaultProvider(provider.id)}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm"
                >
                  Set as Default
                </button>
              )}
              <a
                href={
                  provider.provider_name === 'twilio'
                    ? 'https://www.twilio.com/console'
                    : provider.provider_name === 'vonage'
                    ? 'https://dashboard.nexmo.com/'
                    : 'https://admin.teams.microsoft.com/'
                }
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition text-sm flex items-center justify-center gap-2"
              >
                <ExternalLink className="w-4 h-4" />
                Console
              </a>
            </div>
          </div>
          );
        })}
      </div>

      {/* Phone Numbers Section */}
      <div className="mt-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Phone Numbers</h2>
            <p className="text-sm text-gray-600 mt-1">
              {phoneNumbers.length} active number{phoneNumbers.length !== 1 ? 's' : ''} • Real-time usage tracking
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="https://www.twilio.com/console/phone-numbers/search"
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition flex items-center gap-2"
            >
              <ExternalLink className="w-4 h-4" />
              Buy Numbers
            </a>
          </div>
        </div>

        {phoneNumbers.length === 0 ? (
          <div className="bg-yellow-50 border-2 border-yellow-200 rounded-xl p-8 text-center">
            <AlertCircle className="w-12 h-12 text-yellow-600 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">No Phone Numbers Found</h3>
            <p className="text-sm text-gray-600 mb-4">
              Purchase a number from your provider console, then click "Sync Numbers" to import it.
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={syncNumbers}
                disabled={syncing}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition flex items-center gap-2 disabled:opacity-50"
              >
                {syncing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Syncing...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4" />
                    Sync Numbers
                  </>
                )}
              </button>
              <a
                href="https://www.twilio.com/console/phone-numbers/search"
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 border border-yellow-300 text-yellow-700 rounded-lg hover:bg-yellow-100 transition flex items-center gap-2"
              >
                <ExternalLink className="w-4 h-4" />
                Buy Number
              </a>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {phoneNumbers.map((num) => {
              const caps = JSON.parse(num.capabilities || '{}');
              const provider = providers.find((p) => p.provider_name === num.provider_type);

              return (
                <div
                  key={num.id}
                  className="bg-white rounded-xl border-2 border-green-200 p-6 hover:border-green-400 transition"
                >
                  {/* Header */}
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="p-3 bg-gradient-to-br from-green-100 to-blue-100 rounded-lg">
                        <Phone className="w-6 h-6 text-green-600" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-lg font-bold text-gray-900">{num.phone_number}</h3>
                          {num.status === 'active' && (
                            <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs font-medium rounded">
                              Active
                            </span>
                          )}
                        </div>
                        {num.friendly_name && (
                          <p className="text-sm text-gray-600 mt-1">{num.friendly_name}</p>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => testNumber(num.id)}
                      disabled={testingNumber === num.id}
                      className="px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm flex items-center gap-2 disabled:opacity-50"
                    >
                      {testingNumber === num.id ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Testing...
                        </>
                      ) : (
                        <>
                          <PhoneCall className="w-4 h-4" />
                          Test Call
                        </>
                      )}
                    </button>
                  </div>

                  {/* Provider Info */}
                  {provider && (
                    <div className="mb-4 p-3 bg-gray-50 rounded-lg">
                      <div className="text-xs text-gray-500 mb-1">Provider</div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-gray-900">{provider.display_name}</span>
                        <span className="text-sm text-gray-600">
                          • {provider.pricing_info.perMinute}/min
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Capabilities */}
                  <div className="mb-4">
                    <div className="text-xs text-gray-500 mb-2">Capabilities</div>
                    <div className="flex flex-wrap gap-1">
                      {caps.voice && (
                        <span className="px-2 py-1 bg-blue-100 text-blue-700 text-xs font-medium rounded">
                          Voice
                        </span>
                      )}
                      {caps.sms && (
                        <span className="px-2 py-1 bg-purple-100 text-purple-700 text-xs font-medium rounded">
                          SMS
                        </span>
                      )}
                      {caps.mms && (
                        <span className="px-2 py-1 bg-pink-100 text-pink-700 text-xs font-medium rounded">
                          MMS
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Usage Statistics */}
                  <div className="mb-4 p-3 bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg border border-blue-200">
                    <div className="text-xs text-gray-500 mb-2 font-medium">Usage</div>
                    <div className="grid grid-cols-3 gap-3">
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

                  {/* Metadata */}
                  <div className="text-xs text-gray-500">
                    Added {new Date(num.created_at).toLocaleDateString()}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
}
