'use client';

import { useState, useEffect } from 'react';
import {
  Phone,
  Edit2,
  Check,
  X,
  Trash2,
  RefreshCw,
  ExternalLink,
  Settings as SettingsIcon,
  PhoneCall,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Download,
  Volume2
} from 'lucide-react';
import { toast } from 'sonner';
import { LANGUAGES, VOICES, getVoicesForLanguage, groupVoicesByCategory } from './voices-config.ts';
import {
  TTS_PROVIDERS,
  getAllProviders,
  providerRequiresApiKey,
  getVoicesForProvider,
  OPENAI_VOICES,
  type TtsProvider
} from './tts-providers-config.ts';
import {
  STT_PROVIDERS,
  getAllProviders as getAllSttProviders,
  providerRequiresApiKey as sttProviderRequiresApiKey,
  type SttProvider
} from './stt-providers-config.ts';

const BACKEND_URL =
  typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'http://localhost:41522'
    : process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:41522';

interface PhoneNumber {
  id: string;
  phone_number: string;
  friendly_name: string;
  provider_type: string;
  sid: string;
  capabilities: string;
  status: string;
  created_at: string;
  voice?: string;
  language?: string;
  tts_provider?: string;
  provider_api_key?: string;
  stt_provider?: string;
  stt_provider_api_key?: string;
  total_calls?: number;
  total_inbound_calls?: number;
  total_outbound_calls?: number;
  total_duration_seconds?: number;
  total_inbound_duration_seconds?: number;
  total_outbound_duration_seconds?: number;
  total_cost_spent?: number;
  last_used_at?: string;
}

export default function NumbersManagement() {
  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isTestCallModalOpen, setIsTestCallModalOpen] = useState(false);
  const [selectedNumberForEdit, setSelectedNumberForEdit] = useState<PhoneNumber | null>(null);
  const [selectedNumberForTest, setSelectedNumberForTest] = useState<PhoneNumber | null>(null);
  const [providers, setProviders] = useState<any[]>([]);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  useEffect(() => {
    loadNumbers();
    loadProviders();
  }, []);

  async function loadProviders() {
    try {
      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/providers`, { headers });
      if (res.ok) {
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
      }
    } catch (error) {
      console.error('[Numbers Management] Load providers error:', error);
    }
  }

  async function loadNumbers() {
    try {
      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/numbers`, { headers });
      if (res.ok) {
        const data = await res.json();
        setNumbers(data.numbers || []);
      }
    } catch (error) {
      console.error('[Numbers Management] Load error:', error);
      toast.error('Failed to load phone numbers');
    } finally {
      setLoading(false);
    }
  }

  async function toggleStatus(numberId: string, currentStatus: string) {
    try {
      const newStatus = currentStatus === 'active' ? 'suspended' : 'active';
      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/numbers/${numberId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ status: newStatus }),
      });

      if (res.ok) {
        toast.success(`Number ${newStatus === 'active' ? 'activated' : 'suspended'}`);
        loadNumbers();
      } else {
        toast.error('Failed to update status');
      }
    } catch (error) {
      console.error('[Numbers Management] Toggle status error:', error);
      toast.error('Failed to update status');
    }
  }

  function openEditModal(number: PhoneNumber) {
    setSelectedNumberForEdit(number);
    setIsEditModalOpen(true);
  }

  async function syncFromTwilio(numberId: string, phoneNumber: string) {
    try {
      setSyncingId(numberId);
      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/numbers/${numberId}/sync-usage`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });

      if (res.ok) {
        const data = await res.json();
        const syncedNew = data.syncedNewCalls || 0;
        const totalCalls = data.usage?.calls || 0;
        toast.success(`Synced ${syncedNew} new calls (${totalCalls} total) from Twilio!`);
        loadNumbers(); // Refresh to show updated stats
      } else {
        const error = await res.json();
        toast.error(`Failed to sync: ${error.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('[Numbers Management] Sync error:', error);
      toast.error('Failed to sync from Twilio');
    } finally {
      setSyncingId(null);
    }
  }

  async function testCall(phoneNumber: string) {
    toast.info(`Initiating test call to ${phoneNumber}...`);
    // TODO: Implement actual test call functionality
  }

  async function deleteNumber(numberId: string, phoneNumber: string) {
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
        loadNumbers();
      } else {
        toast.error('Failed to delete number');
      }
    } catch (error) {
      console.error('[Numbers Management] Delete error:', error);
      toast.error('Failed to delete number');
    }
  }

  function parseCapabilities(capStr: string) {
    try {
      const cap = JSON.parse(capStr);
      return {
        voice: cap.voice || false,
        sms: cap.sms || false,
        mms: cap.mms || false,
        fax: cap.fax || false,
      };
    } catch {
      return { voice: false, sms: false, mms: false, fax: false };
    }
  }

  function formatDuration(seconds: number | undefined): string {
    if (!seconds) return '0 min';
    const minutes = Math.round(seconds / 60);
    return `${minutes} min`;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b">
        <div className="max-w-6xl mx-auto px-6 py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-blue-100 rounded-xl">
                <SettingsIcon className="w-7 h-7 text-blue-600" />
              </div>
              <div>
                <h1 className="text-3xl font-bold text-gray-900">Phone Numbers</h1>
                <p className="text-sm text-gray-600 mt-1">
                  {numbers.length} active numbers • Manage your telephony
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={loadNumbers}
                className="px-4 py-2.5 border border-gray-300 rounded-lg hover:bg-gray-50 transition flex items-center gap-2 font-medium text-gray-700"
              >
                <RefreshCw className="w-4 h-4" />
                Refresh
              </button>
              <button
                onClick={() => setIsAddModalOpen(true)}
                className="px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition flex items-center gap-2 font-medium shadow-sm"
              >
                <Phone className="w-4 h-4" />
                Add Number
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-6xl mx-auto px-6 py-8">
        {numbers.length === 0 ? (
          <div className="bg-white rounded-xl border-2 border-dashed border-gray-300 p-12 text-center">
            <Phone className="w-16 h-16 mx-auto mb-4 text-gray-400" />
            <h3 className="text-xl font-bold text-gray-900 mb-2">No phone numbers yet</h3>
            <p className="text-gray-600 mb-6">
              Purchase a number from your provider console to get started
            </p>
            <div className="flex items-center justify-center gap-3">
              <a
                href="https://console.twilio.com/us1/develop/phone-numbers/manage/incoming"
                target="_blank"
                rel="noopener noreferrer"
                className="px-5 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 transition text-sm flex items-center gap-2 font-medium"
              >
                <ExternalLink className="w-4 h-4" />
                Twilio Console
              </a>
              <a
                href="https://dashboard.nexmo.com/buy-numbers"
                target="_blank"
                rel="noopener noreferrer"
                className="px-5 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition text-sm flex items-center gap-2 font-medium"
              >
                <ExternalLink className="w-4 h-4" />
                Vonage Console
              </a>
              <a
                href="https://portal.azure.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="px-5 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm flex items-center gap-2 font-medium"
              >
                <ExternalLink className="w-4 h-4" />
                Microsoft Teams
              </a>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {numbers.map((num) => {
              const capabilities = parseCapabilities(num.capabilities);

              return (
                <div
                  key={num.id}
                  className="bg-white rounded-xl border-2 border-green-200 shadow-sm hover:shadow-md transition-shadow"
                >
                  <div className="p-6">
                    {/* Header Row */}
                    <div className="flex items-start justify-between mb-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <h3 className="text-2xl font-bold text-gray-900">{num.phone_number}</h3>
                          <span
                            className={`px-3 py-1 rounded-full text-xs font-medium ${
                              num.status === 'active'
                                ? 'bg-green-100 text-green-700'
                                : 'bg-gray-100 text-gray-700'
                            }`}
                          >
                            {num.status === 'active' ? 'Active' : 'Suspended'}
                          </span>
                        </div>

                        {/* Friendly Name */}
                        <p className="text-gray-600">{num.friendly_name || 'No name set'}</p>

                        {/* Provider & Capabilities */}
                        <div className="flex items-center gap-3 mt-3">
                          <span className="px-3 py-1 bg-blue-100 text-blue-700 text-xs font-medium rounded-full">
                            {num.provider_type}
                          </span>
                          {capabilities.voice && (
                            <span className="px-2.5 py-1 bg-green-100 text-green-700 text-xs font-medium rounded">
                              Voice
                            </span>
                          )}
                          {capabilities.sms && (
                            <span className="px-2.5 py-1 bg-purple-100 text-purple-700 text-xs font-medium rounded">
                              SMS
                            </span>
                          )}
                          {capabilities.mms && (
                            <span className="px-2.5 py-1 bg-orange-100 text-orange-700 text-xs font-medium rounded">
                              MMS
                            </span>
                          )}
                          {capabilities.fax && (
                            <span className="px-2.5 py-1 bg-cyan-100 text-cyan-700 text-xs font-medium rounded">
                              Fax
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Action Buttons */}
                      <div className="flex items-center gap-2 ml-4">
                        <button
                          onClick={() => syncFromTwilio(num.id, num.phone_number)}
                          disabled={syncingId === num.id}
                          className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition font-medium text-sm flex items-center gap-2 disabled:opacity-50"
                        >
                          {syncingId === num.id ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              Syncing...
                            </>
                          ) : (
                            <>
                              <Download className="w-4 h-4" />
                              Sync
                            </>
                          )}
                        </button>
                        <button
                          onClick={() => openEditModal(num)}
                          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium text-sm flex items-center gap-2"
                        >
                          <Edit2 className="w-4 h-4" />
                          Edit
                        </button>
                        <button
                          onClick={() => {
                            setSelectedNumberForTest(num);
                            setIsTestCallModalOpen(true);
                          }}
                          className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-medium text-sm flex items-center gap-2"
                        >
                          <PhoneCall className="w-4 h-4" />
                          Test Call
                        </button>
                        <button
                          onClick={() => deleteNumber(num.id, num.phone_number)}
                          className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition font-medium text-sm flex items-center gap-2"
                        >
                          <Trash2 className="w-4 h-4" />
                          Delete
                        </button>
                      </div>
                    </div>

                    {/* Usage Statistics */}
                    <div className="mt-4 p-4 bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg">
                      <div className="grid grid-cols-5 gap-4">
                        <div>
                          <div className="text-xs text-gray-600 mb-1">Total Calls</div>
                          <div className="text-xl font-bold text-gray-900">
                            {num.total_calls || 0}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-gray-600 mb-1">Inbound</div>
                          <div className="text-xl font-bold text-green-700">
                            {num.total_inbound_calls || 0}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-gray-600 mb-1">Outbound</div>
                          <div className="text-xl font-bold text-blue-700">
                            {num.total_outbound_calls || 0}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-gray-600 mb-1">Total Duration</div>
                          <div className="text-xl font-bold text-gray-900">
                            {formatDuration(num.total_duration_seconds)}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-gray-600 mb-1">Cost Spent</div>
                          <div className="text-xl font-bold text-purple-700">
                            ${(num.total_cost_spent || 0).toFixed(2)}
                          </div>
                        </div>
                      </div>
                      {num.last_used_at && (
                        <div className="mt-3 pt-3 border-t border-blue-200">
                          <div className="text-xs text-gray-600">
                            Last used: {new Date(num.last_used_at).toLocaleString()}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add Number Modal */}
      {isAddModalOpen && (
        <AddNumberModal
          providers={providers.filter(p => p.enabled)}
          onClose={() => setIsAddModalOpen(false)}
          onSuccess={() => {
            setIsAddModalOpen(false);
            loadNumbers();
          }}
        />
      )}

      {/* Edit Number Modal */}
      {isEditModalOpen && selectedNumberForEdit && (
        <EditNumberModal
          phoneNumber={selectedNumberForEdit}
          onClose={() => {
            setIsEditModalOpen(false);
            setSelectedNumberForEdit(null);
          }}
          onSuccess={() => {
            setIsEditModalOpen(false);
            setSelectedNumberForEdit(null);
            loadNumbers();
          }}
        />
      )}

      {/* Test Call Modal */}
      {isTestCallModalOpen && selectedNumberForTest && (
        <TestCallModal
          phoneNumber={selectedNumberForTest}
          onClose={() => {
            setIsTestCallModalOpen(false);
            setSelectedNumberForTest(null);
          }}
          onSuccess={() => {
            loadNumbers(); // Refresh numbers to show updated stats
          }}
        />
      )}
    </div>
  );
}

// Edit Number Modal Component
interface EditNumberModalProps {
  phoneNumber: PhoneNumber;
  onClose: () => void;
  onSuccess: () => void;
}

function EditNumberModal({ phoneNumber, onClose, onSuccess }: EditNumberModalProps) {
  const [friendlyName, setFriendlyName] = useState(phoneNumber.friendly_name || '');
  const [capabilities, setCapabilities] = useState(() => {
    try {
      return JSON.parse(phoneNumber.capabilities);
    } catch {
      return { voice: false, sms: false, mms: false, fax: false };
    }
  });
  const [recordingEnabled, setRecordingEnabled] = useState(true);
  const [transcriptionEnabled, setTranscriptionEnabled] = useState(true);
  const [ttsProvider, setTtsProvider] = useState(phoneNumber.tts_provider || 'twilio');
  const [providerApiKey, setProviderApiKey] = useState(phoneNumber.provider_api_key || '');
  const [sttProvider, setSttProvider] = useState(phoneNumber.stt_provider || 'twilio');
  const [sttProviderApiKey, setSttProviderApiKey] = useState(phoneNumber.stt_provider_api_key || '');
  const [voice, setVoice] = useState(phoneNumber.voice || 'Polly.Joanna');
  const [language, setLanguage] = useState(phoneNumber.language || 'en-US');
  const [saving, setSaving] = useState(false);
  const [playingPreview, setPlayingPreview] = useState(false);

  // Get TTS providers list
  const allProviders = getAllProviders();
  const selectedProvider = TTS_PROVIDERS[ttsProvider];
  const requiresApiKey = providerRequiresApiKey(ttsProvider);

  // Get STT providers list
  const allSttProviders = getAllSttProviders();
  const selectedSttProvider = STT_PROVIDERS[sttProvider];
  const sttRequiresApiKey = sttProviderRequiresApiKey(sttProvider);

  // Get compatible voices for selected language and provider
  const availableVoices = ttsProvider === 'twilio'
    ? getVoicesForLanguage(language)
    : ttsProvider === 'openai'
    ? OPENAI_VOICES
    : [];
  const voiceGroups = ttsProvider === 'twilio'
    ? groupVoicesByCategory(availableVoices)
    : { [selectedProvider?.name || 'Voices']: availableVoices };

  // Play voice preview
  async function playVoicePreview() {
    try {
      setPlayingPreview(true);
      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const previewText = language.startsWith('ar')
        ? 'مرحباً! هذا نموذج من الصوت المختار'
        : 'Hello! This is a preview of the selected voice';

      // Check if API key is required but not provided
      if (requiresApiKey && !providerApiKey) {
        toast.error(`API key required for ${selectedProvider?.name}`);
        setPlayingPreview(false);
        return;
      }

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/voice-preview`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          voice,
          language,
          text: previewText,
          tts_provider: ttsProvider,
          provider_api_key: providerApiKey
        }),
      });

      if (res.ok) {
        const contentType = res.headers.get('content-type');

        // For non-Twilio providers, we get audio/mpeg directly
        if (contentType?.includes('audio')) {
          const audioBlob = await res.blob();
          const audioUrl = URL.createObjectURL(audioBlob);

          // Create and play audio element
          const audio = new Audio(audioUrl);
          audio.onended = () => {
            URL.revokeObjectURL(audioUrl);
            setPlayingPreview(false);
          };
          audio.onerror = () => {
            toast.error('Failed to play audio');
            URL.revokeObjectURL(audioUrl);
            setPlayingPreview(false);
          };

          await audio.play();
          toast.success(`Playing: ${voice} (${selectedProvider?.name})`);
        } else {
          // Twilio TwiML response (fallback to beep for now)
          const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
          const oscillator = audioContext.createOscillator();
          const gainNode = audioContext.createGain();

          oscillator.connect(gainNode);
          gainNode.connect(audioContext.destination);

          oscillator.frequency.value = 800;
          oscillator.type = 'sine';
          gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
          gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);

          oscillator.start(audioContext.currentTime);
          oscillator.stop(audioContext.currentTime + 0.5);

          toast.success(`Preview: ${voice} (${language})`);
          setTimeout(() => setPlayingPreview(false), 500);
        }
      } else {
        const error = await res.json().catch(() => ({ error: 'Unknown error' }));
        toast.error(`Failed: ${error.error || error.message || 'Unknown error'}`);
        setPlayingPreview(false);
      }
    } catch (error) {
      console.error('[Voice Preview] Error:', error);
      toast.error('Failed to play voice preview');
      setPlayingPreview(false);
    }
  }

  async function handleSave() {
    try {
      setSaving(true);
      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/numbers/${phoneNumber.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          friendly_name: friendlyName,
          capabilities: JSON.stringify(capabilities),
          tts_provider: ttsProvider,
          provider_api_key: providerApiKey || null,
          stt_provider: sttProvider,
          stt_provider_api_key: sttProviderApiKey || null,
          voice: voice,
          language: language,
        }),
      });

      if (res.ok) {
        toast.success('Phone number updated successfully!');
        onSuccess();
      } else {
        const error = await res.json();
        toast.error(`Failed to update number: ${error.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('[Edit Number Modal] Save error:', error);
      toast.error('Failed to update phone number');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Edit2 className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">Edit Phone Number</h2>
              <p className="text-sm text-gray-600">{phoneNumber.phone_number}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5">
          {/* Friendly Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Friendly Name
            </label>
            <input
              type="text"
              value={friendlyName}
              onChange={(e) => setFriendlyName(e.target.value)}
              placeholder="My Business Line"
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              autoFocus
            />
            <p className="text-xs text-gray-500 mt-1">
              Display name for this number
            </p>
          </div>

          {/* Capabilities */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">
              Capabilities
            </label>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={capabilities.voice}
                  onChange={(e) =>
                    setCapabilities({ ...capabilities, voice: e.target.checked })
                  }
                  className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">Voice Calls</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={capabilities.sms}
                  onChange={(e) =>
                    setCapabilities({ ...capabilities, sms: e.target.checked })
                  }
                  className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">SMS Messaging</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={capabilities.mms}
                  onChange={(e) =>
                    setCapabilities({ ...capabilities, mms: e.target.checked })
                  }
                  className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">MMS Messaging</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={capabilities.fax}
                  onChange={(e) =>
                    setCapabilities({ ...capabilities, fax: e.target.checked })
                  }
                  className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">Fax Support</span>
              </label>
            </div>
          </div>

          {/* Recording Settings */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">
              Recording Settings
            </label>
            <div className="space-y-3 p-4 bg-gray-50 rounded-lg border border-gray-200">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={recordingEnabled}
                  onChange={(e) => setRecordingEnabled(e.target.checked)}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 font-medium">Enable Call Recording</span>
              </label>
              {recordingEnabled && (
                <label className="flex items-center gap-2 cursor-pointer ml-6">
                  <input
                    type="checkbox"
                    checked={transcriptionEnabled}
                    onChange={(e) => setTranscriptionEnabled(e.target.checked)}
                    className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700">
                    Enable Transcription (Audio + Text)
                  </span>
                </label>
              )}
              <p className="text-xs text-gray-600 ml-6">
                {!recordingEnabled
                  ? 'No recording - calls will not be saved'
                  : transcriptionEnabled
                  ? 'Calls will be recorded as audio + text transcription'
                  : 'Calls will be recorded as audio only'}
              </p>
            </div>
          </div>

          {/* TTS Provider Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">
              Text-to-Speech Provider
            </label>
            <div className="space-y-4">
              {/* Provider Dropdown */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-2">
                  Provider
                </label>
                <select
                  value={ttsProvider}
                  onChange={(e) => {
                    setTtsProvider(e.target.value);
                    // Reset voice to appropriate default for new provider
                    if (e.target.value === 'openai') {
                      setVoice('alloy');
                    } else if (e.target.value === 'twilio') {
                      setVoice('Polly.Joanna');
                    }
                  }}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                >
                  {allProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name} - {provider.pricing}
                    </option>
                  ))}
                </select>
                {selectedProvider && (
                  <div className="mt-2 p-3 bg-blue-50 rounded-lg border border-blue-200">
                    <p className="text-xs text-blue-900 font-medium">{selectedProvider.description}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {selectedProvider.features.map((feature, idx) => (
                        <span key={idx} className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded">
                          {feature}
                        </span>
                      ))}
                    </div>
                    <p className="text-xs text-blue-700 mt-2">
                      <strong>Supported Languages:</strong> {selectedProvider.supportedLanguages}+ |{' '}
                      <strong>Total Voices:</strong> {selectedProvider.totalVoices}+
                    </p>
                  </div>
                )}
              </div>

              {/* API Key Input (conditional) */}
              {requiresApiKey && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-2">
                    API Key <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="password"
                    value={providerApiKey}
                    onChange={(e) => setProviderApiKey(e.target.value)}
                    placeholder={`Enter your ${selectedProvider?.name} API key`}
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-1.5">
                    Required for {selectedProvider?.name}. Get your API key from:{' '}
                    <a
                      href={selectedProvider?.documentation}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      {selectedProvider?.documentation}
                    </a>
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* STT Provider Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">
              Speech-to-Text Provider (Transcription)
            </label>
            <div className="space-y-4">
              {/* Provider Dropdown */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-2">
                  STT Provider
                </label>
                <select
                  value={sttProvider}
                  onChange={(e) => setSttProvider(e.target.value)}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                >
                  {allSttProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name} - {provider.pricing}
                    </option>
                  ))}
                </select>
                {selectedSttProvider && (
                  <div className="mt-2 p-3 bg-green-50 rounded-lg border border-green-200">
                    <p className="text-xs text-green-900 font-medium">{selectedSttProvider.description}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {selectedSttProvider.features.map((feature, idx) => (
                        <span key={idx} className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded">
                          {feature}
                        </span>
                      ))}
                    </div>
                    <p className="text-xs text-green-700 mt-2">
                      <strong>Supported Languages:</strong> {selectedSttProvider.supportedLanguages}+
                    </p>
                  </div>
                )}
              </div>

              {/* API Key Input (conditional) */}
              {sttRequiresApiKey && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-2">
                    STT API Key <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="password"
                    value={sttProviderApiKey}
                    onChange={(e) => setSttProviderApiKey(e.target.value)}
                    placeholder={`Enter your ${selectedSttProvider?.name} API key`}
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-1.5">
                    Required for {selectedSttProvider?.name}. Get your API key from:{' '}
                    <a
                      href={selectedSttProvider?.documentation}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      {selectedSttProvider?.documentation}
                    </a>
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Voice & Language Settings */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">
              Voice & Language Settings
            </label>
            <div className="space-y-4">
              {/* Language Selection */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-2">
                  Language
                </label>
                <select
                  value={language}
                  onChange={(e) => {
                    setLanguage(e.target.value);
                    // Auto-select recommended voice for new language
                    const newVoices = getVoicesForLanguage(e.target.value);
                    if (newVoices.length > 0) {
                      const recommended = newVoices.find(v => v.recommended) || newVoices[0];
                      setVoice(recommended.id);
                    }
                  }}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                >
                  {LANGUAGES.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.flag} {lang.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Voice Selection */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-2">
                  Voice
                </label>
                <div className="flex gap-2">
                  <select
                    value={voice}
                    onChange={(e) => setVoice(e.target.value)}
                    className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                  >
                    {Object.entries(voiceGroups).map(([category, voices]) => (
                      <optgroup key={category} label={category}>
                        {voices.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={playVoicePreview}
                    disabled={playingPreview}
                    className="px-4 py-2.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 whitespace-nowrap"
                    title="Preview voice"
                  >
                    <Volume2 className={`w-4 h-4 ${playingPreview ? 'animate-pulse' : ''}`} />
                    Preview
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-1.5">
                  Selected voice will be used for test calls and automated messages
                </p>
              </div>
            </div>
          </div>

          {/* Info Box */}
          <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-blue-900">
                <p className="font-medium mb-1">Number Configuration</p>
                <div className="space-y-1 text-blue-700">
                  <p><strong>Provider:</strong> {phoneNumber.provider_type}</p>
                  <p><strong>Status:</strong> {phoneNumber.status}</p>
                  <p><strong>SID:</strong> {phoneNumber.sid}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-gray-50 border-t px-6 py-4 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-5 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100 transition font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Check className="w-4 h-4" />
                Save Changes
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// Add Number Modal Component
interface AddNumberModalProps {
  providers: any[];
  onClose: () => void;
  onSuccess: () => void;
}

function AddNumberModal({ providers, onClose, onSuccess }: AddNumberModalProps) {
  const [phoneNumber, setPhoneNumber] = useState('');
  const [friendlyName, setFriendlyName] = useState('');
  const [capabilities, setCapabilities] = useState({
    voice: true,
    sms: true,
    mms: false,
    fax: false,
  });
  const [recordingEnabled, setRecordingEnabled] = useState(true);
  const [transcriptionEnabled, setTranscriptionEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [availability, setAvailability] = useState<'unknown' | 'available' | 'exists'>('unknown');

  async function checkAvailability() {
    if (!phoneNumber) {
      toast.error('Please enter a phone number first');
      return;
    }

    try {
      setChecking(true);
      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/numbers`, { headers });
      if (res.ok) {
        const data = await res.json();
        const exists = data.numbers?.some((n: any) => n.phone_number === phoneNumber);

        if (exists) {
          setAvailability('exists');
          toast.error('This number already exists in your account');
        } else {
          setAvailability('available');
          toast.success('Number is available to add!');
        }
      }
    } catch (error) {
      console.error('[Add Number Modal] Check error:', error);
      toast.error('Failed to check availability');
    } finally {
      setChecking(false);
    }
  }

  async function handleSave() {
    if (!phoneNumber) {
      toast.error('Please enter phone number');
      return;
    }

    try {
      setSaving(true);
      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/numbers`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          phone_number: phoneNumber,
          friendly_name: friendlyName || phoneNumber,
          capabilities: JSON.stringify(capabilities),
          status: 'active',
        }),
      });

      if (res.ok) {
        toast.success('Phone number added successfully!');
        onSuccess();
      } else {
        const error = await res.json();
        toast.error(`Failed to add number: ${error.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('[Add Number Modal] Save error:', error);
      toast.error('Failed to add phone number');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Phone className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">Add Phone Number</h2>
              <p className="text-sm text-gray-600">Enter your existing phone number details</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5">
          {/* Phone Number */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Phone Number *
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={phoneNumber}
                onChange={(e) => {
                  setPhoneNumber(e.target.value);
                  setAvailability('unknown');
                }}
                placeholder="+1234567890"
                className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <button
                type="button"
                onClick={checkAvailability}
                disabled={checking || !phoneNumber}
                className="px-4 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 font-medium whitespace-nowrap"
              >
                {checking ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Checking...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    Check
                  </>
                )}
              </button>
            </div>

            {/* Availability Indicator */}
            {availability === 'available' && (
              <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded-lg flex items-center gap-2 text-sm text-green-700">
                <CheckCircle2 className="w-4 h-4" />
                <span className="font-medium">Available to add</span>
              </div>
            )}
            {availability === 'exists' && (
              <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-sm text-red-700">
                <X className="w-4 h-4" />
                <span className="font-medium">Already exists in your account</span>
              </div>
            )}

            <p className="text-xs text-gray-500 mt-1">
              Enter in E.164 format (e.g., +1234567890)
            </p>
          </div>

          {/* Friendly Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Friendly Name
            </label>
            <input
              type="text"
              value={friendlyName}
              onChange={(e) => setFriendlyName(e.target.value)}
              placeholder="My Business Line"
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <p className="text-xs text-gray-500 mt-1">
              Optional display name for this number
            </p>
          </div>

          {/* Capabilities */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">
              Capabilities
            </label>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={capabilities.voice}
                  onChange={(e) =>
                    setCapabilities({ ...capabilities, voice: e.target.checked })
                  }
                  className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">Voice Calls</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={capabilities.sms}
                  onChange={(e) =>
                    setCapabilities({ ...capabilities, sms: e.target.checked })
                  }
                  className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">SMS Messaging</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={capabilities.mms}
                  onChange={(e) =>
                    setCapabilities({ ...capabilities, mms: e.target.checked })
                  }
                  className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">MMS Messaging</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={capabilities.fax}
                  onChange={(e) =>
                    setCapabilities({ ...capabilities, fax: e.target.checked })
                  }
                  className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">Fax Support</span>
              </label>
            </div>
          </div>

          {/* Recording Settings */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">
              Recording Settings
            </label>
            <div className="space-y-3 p-4 bg-gray-50 rounded-lg border border-gray-200">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={recordingEnabled}
                  onChange={(e) => setRecordingEnabled(e.target.checked)}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 font-medium">Enable Call Recording</span>
              </label>
              {recordingEnabled && (
                <label className="flex items-center gap-2 cursor-pointer ml-6">
                  <input
                    type="checkbox"
                    checked={transcriptionEnabled}
                    onChange={(e) => setTranscriptionEnabled(e.target.checked)}
                    className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700">
                    Enable Transcription (Audio + Text)
                  </span>
                </label>
              )}
              <p className="text-xs text-gray-600 ml-6">
                {!recordingEnabled
                  ? 'No recording - calls will not be saved'
                  : transcriptionEnabled
                  ? 'Calls will be recorded as audio + text transcription'
                  : 'Calls will be recorded as audio only'}
              </p>
            </div>
          </div>

          {/* Help Text */}
          <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-blue-900">
                <p className="font-medium mb-1">Need a new number?</p>
                <p className="text-blue-700 mb-3">
                  Purchase a phone number from your provider's console first, then add it here with the details.
                </p>
                <div className="flex flex-wrap gap-2">
                  <a
                    href="https://console.twilio.com/us1/develop/phone-numbers/manage/incoming"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 px-3 py-1.5 bg-red-600 text-white rounded-lg hover:bg-red-700 transition text-xs font-medium"
                  >
                    <ExternalLink className="w-3 h-3" />
                    Twilio Console
                  </a>
                  <a
                    href="https://dashboard.nexmo.com/buy-numbers"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition text-xs font-medium"
                  >
                    <ExternalLink className="w-3 h-3" />
                    Vonage Console
                  </a>
                  <a
                    href="https://portal.azure.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-xs font-medium"
                  >
                    <ExternalLink className="w-3 h-3" />
                    Azure Portal
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-gray-50 border-t px-6 py-4 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-5 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100 transition font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !phoneNumber}
            className="px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Adding...
              </>
            ) : (
              <>
                <Check className="w-4 h-4" />
                Add Number
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// Test Call Modal Component
interface TestCallModalProps {
  phoneNumber: PhoneNumber;
  onClose: () => void;
  onSuccess: () => void;
}

function TestCallModal({ phoneNumber, onClose, onSuccess }: TestCallModalProps) {
  const [destinationNumber, setDestinationNumber] = useState('');
  const [testing, setTesting] = useState(false);

  // Load saved test number from localStorage
  useEffect(() => {
    const savedNumber = localStorage.getItem('test_call_destination');
    if (savedNumber) {
      setDestinationNumber(savedNumber);
    }
  }, []);

  async function handleTestCall() {
    if (!destinationNumber) {
      toast.error('Please enter a destination number');
      return;
    }

    try {
      setTesting(true);

      // Save the number for next time
      localStorage.setItem('test_call_destination', destinationNumber);

      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/numbers/${phoneNumber.id}/test-call`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ to: destinationNumber }),
      });

      if (res.ok) {
        const data = await res.json();
        toast.success(`Test call initiated! Call SID: ${data.callSid}`);
        onSuccess(); // Refresh numbers list
        onClose();
      } else {
        const error = await res.json();
        toast.error(`Failed to initiate call: ${error.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('[Test Call] Error:', error);
      toast.error('Failed to initiate test call');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full">
        {/* Header */}
        <div className="bg-gradient-to-r from-green-600 to-blue-600 px-6 py-4 flex items-center justify-between rounded-t-xl">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-white/20 rounded-lg">
              <PhoneCall className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">Test Call</h2>
              <p className="text-sm text-white/80">From: {phoneNumber.phone_number}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-white/80 hover:text-white hover:bg-white/20 rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5">
          {/* Info Box */}
          <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-blue-900">
                <p className="font-medium mb-1">Test Call System</p>
                <p className="text-blue-700">
                  This will make a real call from <strong>{phoneNumber.friendly_name || phoneNumber.phone_number}</strong> to your test number.
                  You'll hear a pre-recorded test message to verify the system is working.
                </p>
              </div>
            </div>
          </div>

          {/* Destination Number */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Your Phone Number *
            </label>
            <input
              type="text"
              value={destinationNumber}
              onChange={(e) => setDestinationNumber(e.target.value)}
              placeholder="+436769054441"
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              autoFocus
            />
            <p className="text-xs text-gray-500 mt-1">
              Enter in E.164 format (e.g., +436769054441). This number will be saved for future tests.
            </p>
          </div>

          {/* Number Info */}
          <div className="p-3 bg-gray-50 rounded-lg">
            <div className="text-xs text-gray-600 mb-2">Test Call Details:</div>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600">From:</span>
                <span className="font-medium text-gray-900">{phoneNumber.phone_number}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">To:</span>
                <span className="font-medium text-gray-900">{destinationNumber || '(Not set)'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Provider:</span>
                <span className="font-medium text-gray-900">{phoneNumber.provider_type}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="bg-gray-50 border-t px-6 py-4 flex items-center justify-end gap-3 rounded-b-xl">
          <button
            onClick={onClose}
            className="px-5 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100 transition font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handleTestCall}
            disabled={testing || !destinationNumber}
            className="px-5 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {testing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Calling...
              </>
            ) : (
              <>
                <PhoneCall className="w-4 h-4" />
                Start Test Call
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
