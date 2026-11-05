'use client';

import { useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  Phone,
  PhoneCall,
  MessageSquare,
  TrendingUp,
  Users,
  BarChart3,
  FileText,
  Clock,
  CheckCircle,
  XCircle,
  AlertCircle,
  Play,
  Pause,
  Plus,
  Eye,
  Megaphone,
  Loader2,
  Settings,
  Key,
  History,
  Filter,
  Download,
  RefreshCw,
  Search,
  X,
  PhoneIncoming,
  PhoneOutgoing
} from 'lucide-react';
import { toast } from 'sonner';
import CallCenterSettings from './settings';
import ProviderCredentials from './provider-credentials';
import CallDetailsPage from './call-details';

const BACKEND_URL = typeof window !== 'undefined' && window.location.hostname === 'localhost'
  ? 'http://localhost:41522'
  : process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:41522';

interface CallPoint {
  id: string;
  name: string;
  phone_number: string;
  status: string;
  total_calls: number;
}

interface Campaign {
  id: string;
  name: string;
  type: string;
  status: string;
  total_contacts: number;
  completed_calls: number;
  interested_count: number;
}

interface Stats {
  totalCallPoints: number;
  totalCalls: number;
  activeCampaigns: number;
  queueLength: number;
}

export default function CallCenterDashboard() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // All Hooks must come BEFORE any conditional returns
  const [activeTab, setActiveTab] = useState(searchParams.get('tab') || 'overview');
  const [callPoints, setCallPoints] = useState<CallPoint[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [stats, setStats] = useState<Stats>({
    totalCallPoints: 0,
    totalCalls: 0,
    activeCampaigns: 0,
    queueLength: 0
  });
  const [loading, setLoading] = useState(true);

  // Check if we should show call details page (AFTER all Hooks)
  const callId = searchParams.get('callId');
  if (callId) {
    return <CallDetailsPage callId={callId} />;
  }

  // Sync tab with URL
  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab && tab !== activeTab) {
      setActiveTab(tab);
    }
  }, [searchParams]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, []);

  async function loadData() {
    try {
      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const [callPointsRes, campaignsRes] = await Promise.all([
        fetch(`${BACKEND_URL}/api/telephony/call-points`, { headers }),
        fetch(`${BACKEND_URL}/api/ext/call-center/campaigns`, { headers })
      ]);

      let loadedCallPoints: CallPoint[] = [];
      let loadedCampaigns: Campaign[] = [];

      if (callPointsRes.ok) {
        const data = await callPointsRes.json();
        loadedCallPoints = data.callPoints || [];
        setCallPoints(loadedCallPoints);
      }

      if (campaignsRes.ok) {
        const data = await campaignsRes.json();
        loadedCampaigns = data.campaigns || [];
        setCampaigns(loadedCampaigns);
      }

      setStats({
        totalCallPoints: loadedCallPoints.length,
        totalCalls: loadedCallPoints.reduce((sum, cp) => sum + (cp.total_calls || 0), 0),
        activeCampaigns: loadedCampaigns.filter(c => c.status === 'running').length,
        queueLength: 0
      });
    } catch (error) {
      console.error('[CallCenter] Error loading data:', error);
    } finally {
      setLoading(false);
    }
  }

  const tabs = [
    { id: 'overview', label: 'Overview', icon: BarChart3 },
    { id: 'call-points', label: 'Call Points', icon: PhoneCall },
    { id: 'campaigns', label: 'Campaigns', icon: Megaphone },
    { id: 'recordings', label: 'Call History', icon: History },
    { id: 'queue', label: 'Queue', icon: Clock },
    { id: 'analytics', label: 'Analytics', icon: TrendingUp },
    { id: 'templates', label: 'Templates', icon: FileText },
    { id: 'knowledge', label: 'Knowledge', icon: MessageSquare },
    { id: 'settings', label: 'Settings', icon: Settings }
  ];

  function handleTabChange(tabId: string) {
    setActiveTab(tabId);
    router.push(`?tab=${tabId}`, { scroll: false });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <Loader2 className="w-12 h-12 text-blue-600 animate-spin mx-auto mb-4" />
          <p className="text-gray-600">Loading Call Center...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <Phone className="w-6 h-6 text-green-600" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Call Center</h1>
                <p className="text-sm text-gray-600">Professional AI-powered telephony system</p>
              </div>
            </div>
            <button className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition flex items-center gap-2">
              <Plus className="w-4 h-4" />
              New Campaign
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6">
        {/* Stats Cards - Only show on Overview tab */}
        {activeTab === 'overview' && (
          <div className="grid grid-cols-4 gap-6 mb-6">
            <div className="bg-white p-6 rounded-xl border">
              <div className="flex items-center justify-between mb-4">
                <div className="p-3 bg-blue-100 rounded-lg">
                  <Phone className="w-6 h-6 text-blue-600" />
                </div>
                <span className="text-sm text-gray-500">Total</span>
              </div>
              <h3 className="text-3xl font-bold text-gray-900 mb-1">{stats.totalCallPoints}</h3>
              <p className="text-sm text-gray-600">Call Points</p>
            </div>

            <div className="bg-white p-6 rounded-xl border">
              <div className="flex items-center justify-between mb-4">
                <div className="p-3 bg-green-100 rounded-lg">
                  <PhoneCall className="w-6 h-6 text-green-600" />
                </div>
                <span className="text-sm text-gray-500">All Time</span>
              </div>
              <h3 className="text-3xl font-bold text-gray-900 mb-1">{stats.totalCalls}</h3>
              <p className="text-sm text-gray-600">Total Calls</p>
            </div>

            <div className="bg-white p-6 rounded-xl border">
              <div className="flex items-center justify-between mb-4">
                <div className="p-3 bg-purple-100 rounded-lg">
                  <Megaphone className="w-6 h-6 text-purple-600" />
                </div>
                <span className="text-sm text-gray-500">Active</span>
              </div>
              <h3 className="text-3xl font-bold text-gray-900 mb-1">{stats.activeCampaigns}</h3>
              <p className="text-sm text-gray-600">Campaigns</p>
            </div>

            <div className="bg-white p-6 rounded-xl border">
              <div className="flex items-center justify-between mb-4">
                <div className="p-3 bg-orange-100 rounded-lg">
                  <Clock className="w-6 h-6 text-orange-600" />
                </div>
                <span className="text-sm text-gray-500">Waiting</span>
              </div>
              <h3 className="text-3xl font-bold text-gray-900 mb-1">{stats.queueLength}</h3>
              <p className="text-sm text-gray-600">In Queue</p>
            </div>
          </div>
        )}

        {/* Sidebar + Content Layout */}
        <div className="flex gap-6">
          {/* Sidebar */}
          <div className="w-64 flex-shrink-0">
            <div className="bg-white rounded-xl border overflow-hidden sticky top-6">
              <div className="p-4 border-b bg-gray-50">
                <h3 className="font-semibold text-gray-900">Navigation</h3>
              </div>
              <nav className="p-2">
                {tabs.map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => handleTabChange(tab.id)}
                      className={`w-full px-4 py-3 flex items-center gap-3 rounded-lg transition mb-1 ${
                        activeTab === tab.id
                          ? 'bg-blue-50 text-blue-600 font-medium'
                          : 'text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      <Icon className="w-5 h-5" />
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </nav>
            </div>
          </div>

          {/* Content Area */}
          <div className="flex-1 min-w-0">
            <div className="bg-white rounded-xl border p-6">
              {activeTab === 'overview' && <OverviewTab callPoints={callPoints} campaigns={campaigns} />}
              {activeTab === 'call-points' && <CallPointsTab callPoints={callPoints} onRefresh={loadData} />}
              {activeTab === 'campaigns' && <CampaignsTab campaigns={campaigns} onRefresh={loadData} />}
              {activeTab === 'recordings' && <RecordingsTab />}
              {activeTab === 'queue' && <QueueTab />}
              {activeTab === 'analytics' && <AnalyticsTab />}
              {activeTab === 'templates' && <TemplatesTab />}
              {activeTab === 'knowledge' && <KnowledgeTab />}
              {activeTab === 'settings' && <SettingsTab />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function OverviewTab({ callPoints, campaigns }: { callPoints: CallPoint[]; campaigns: Campaign[] }) {
  const [recentCalls, setRecentCalls] = useState<any[]>([]);
  const [loadingCalls, setLoadingCalls] = useState(true);

  useEffect(() => {
    loadRecentCalls();
  }, []);

  async function loadRecentCalls() {
    try {
      setLoadingCalls(true);
      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/recordings?limit=5`, { headers });
      if (res.ok) {
        const data = await res.json();
        setRecentCalls(data.recordings || []);
      }
    } catch (error) {
      console.error('[Overview] Load recent calls error:', error);
    } finally {
      setLoadingCalls(false);
    }
  }

  function formatDuration(seconds: number) {
    if (!seconds) return '0s';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  function formatTime(dateStr: string) {
    if (!dateStr) return 'N/A';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <Phone className="w-5 h-5 text-blue-600" />
          Recent Call Points
        </h3>
        <div className="space-y-3">
          {callPoints.slice(0, 5).map((cp) => (
            <div key={cp.id} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-white rounded-lg border">
                  <Phone className="w-5 h-5 text-gray-600" />
                </div>
                <div>
                  <h4 className="font-medium text-gray-900">{cp.name}</h4>
                  <p className="text-sm text-gray-600">{cp.phone_number}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold text-gray-900">{cp.total_calls || 0}</p>
                <p className="text-xs text-gray-600">calls</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <Megaphone className="w-5 h-5 text-purple-600" />
          Active Campaigns
        </h3>
        {campaigns.filter(c => c.status === 'running').length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <Megaphone className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p>No active campaigns</p>
          </div>
        ) : (
          <div className="space-y-3">
            {campaigns.filter(c => c.status === 'running').slice(0, 5).map((campaign) => (
              <div key={campaign.id} className="p-4 bg-purple-50 rounded-lg border border-purple-200">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-medium text-gray-900">{campaign.name}</h4>
                  <span className="px-2 py-1 bg-green-100 text-green-700 text-xs font-medium rounded">
                    Running
                  </span>
                </div>
                <div className="flex items-center gap-4 text-sm text-gray-600">
                  <span>{campaign.completed_calls}/{campaign.total_contacts} calls</span>
                  <span>•</span>
                  <span>{campaign.interested_count} interested</span>
                </div>
                <div className="mt-2 bg-white rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-purple-600 h-full transition-all"
                    style={{ width: `${(campaign.completed_calls / campaign.total_contacts) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent Calls */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <PhoneCall className="w-5 h-5 text-green-600" />
            Recent Calls
          </h3>
          <a
            href="?tab=recordings"
            className="text-sm text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1 cursor-pointer"
          >
            View All
            <Eye className="w-4 h-4" />
          </a>
        </div>
        {loadingCalls ? (
          <div className="text-center py-8">
            <Loader2 className="w-8 h-8 text-blue-600 animate-spin mx-auto mb-3" />
            <p className="text-sm text-gray-600">Loading calls...</p>
          </div>
        ) : recentCalls.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <PhoneCall className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p className="text-sm">No recent calls</p>
            <p className="text-xs mt-1">Make a test call to see it here</p>
          </div>
        ) : (
          <div className="space-y-2">
            {recentCalls.map((call) => (
              <a
                key={call.id}
                href={`?callId=${call.id}`}
                className="block p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition border border-transparent hover:border-blue-200"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-1">
                    <div className={`p-2 rounded-lg ${
                      call.direction === 'outbound'
                        ? 'bg-blue-100'
                        : 'bg-green-100'
                    }`}>
                      <PhoneCall className={`w-4 h-4 ${
                        call.direction === 'outbound'
                          ? 'text-blue-600'
                          : 'text-green-600'
                      }`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          call.direction === 'outbound'
                            ? 'bg-blue-100 text-blue-700'
                            : 'bg-green-100 text-green-700'
                        }`}>
                          {call.direction === 'outbound' ? 'Outbound' : 'Inbound'}
                        </span>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          call.status === 'completed'
                            ? 'bg-green-100 text-green-700'
                            : 'bg-gray-100 text-gray-700'
                        }`}>
                          {call.status}
                        </span>
                      </div>
                      <p className="text-sm text-gray-900 font-medium truncate">
                        {call.direction === 'outbound' ? call.to_number : call.from_number}
                      </p>
                    </div>
                  </div>
                  <div className="text-right ml-4">
                    <p className="text-sm font-medium text-gray-900">{formatDuration(call.duration_seconds)}</p>
                    <p className="text-xs text-gray-600">{formatTime(call.started_at)}</p>
                  </div>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CallPointsTab({ callPoints, onRefresh }: { callPoints: CallPoint[]; onRefresh: () => void }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-semibold text-gray-900">All Call Points</h3>
        <button onClick={onRefresh} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">
          Refresh
        </button>
      </div>
      <div className="grid gap-4">
        {callPoints.map((cp) => (
          <div key={cp.id} className="p-4 border rounded-lg hover:bg-gray-50 transition">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="font-medium text-gray-900">{cp.name}</h4>
                <p className="text-sm text-gray-600">{cp.phone_number}</p>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <p className="text-xl font-bold text-gray-900">{cp.total_calls || 0}</p>
                  <p className="text-xs text-gray-600">calls</p>
                </div>
                <button className="p-2 hover:bg-gray-100 rounded-lg transition">
                  <Eye className="w-5 h-5 text-gray-600" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CampaignsTab({ campaigns, onRefresh }: { campaigns: Campaign[]; onRefresh: () => void }) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running': return 'bg-green-100 text-green-700';
      case 'paused': return 'bg-yellow-100 text-yellow-700';
      case 'completed': return 'bg-blue-100 text-blue-700';
      case 'draft': return 'bg-gray-100 text-gray-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-semibold text-gray-900">All Campaigns</h3>
        <div className="flex items-center gap-3">
          <button onClick={onRefresh} className="px-4 py-2 border rounded-lg hover:bg-gray-50 transition">
            Refresh
          </button>
          <button className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition flex items-center gap-2">
            <Plus className="w-4 h-4" />
            New Campaign
          </button>
        </div>
      </div>

      {campaigns.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <Megaphone className="w-16 h-16 mx-auto mb-4 opacity-50" />
          <p className="text-lg font-medium mb-2">No campaigns yet</p>
          <p className="text-sm mb-4">Create your first outbound campaign to start calling customers</p>
          <button className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">
            Create Campaign
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          {campaigns.map((campaign) => (
            <div key={campaign.id} className="p-6 border rounded-lg hover:shadow-md transition">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h4 className="text-lg font-semibold text-gray-900 mb-1">{campaign.name}</h4>
                  <p className="text-sm text-gray-600">{campaign.type}</p>
                </div>
                <span className={`px-3 py-1 rounded-full text-xs font-medium ${getStatusColor(campaign.status)}`}>
                  {campaign.status}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-4 mb-4">
                <div>
                  <p className="text-sm text-gray-600 mb-1">Progress</p>
                  <p className="text-xl font-bold text-gray-900">{campaign.completed_calls}/{campaign.total_contacts}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600 mb-1">Interested</p>
                  <p className="text-xl font-bold text-green-600">{campaign.interested_count}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600 mb-1">Success Rate</p>
                  <p className="text-xl font-bold text-blue-600">
                    {campaign.completed_calls > 0 ? ((campaign.interested_count / campaign.completed_calls) * 100).toFixed(1) : 0}%
                  </p>
                </div>
              </div>

              <div className="bg-gray-200 rounded-full h-2 mb-4 overflow-hidden">
                <div className="bg-blue-600 h-full transition-all" style={{ width: `${(campaign.completed_calls / campaign.total_contacts) * 100}%` }} />
              </div>

              <div className="flex items-center gap-2">
                {campaign.status === 'running' ? (
                  <button className="px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition flex items-center gap-2">
                    <Pause className="w-4 h-4" />
                    Pause
                  </button>
                ) : campaign.status === 'paused' ? (
                  <button className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition flex items-center gap-2">
                    <Play className="w-4 h-4" />
                    Resume
                  </button>
                ) : (
                  <button className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition flex items-center gap-2">
                    <Play className="w-4 h-4" />
                    Start
                  </button>
                )}
                <button className="px-4 py-2 border rounded-lg hover:bg-gray-50 transition">View Details</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function QueueTab() {
  return (
    <div className="text-center py-12 text-gray-500">
      <Clock className="w-16 h-16 mx-auto mb-4 opacity-50" />
      <p className="text-lg font-medium mb-2">Queue Monitor</p>
      <p className="text-sm">Real-time call queue monitoring</p>
    </div>
  );
}

function AnalyticsTab() {
  return (
    <div className="text-center py-12 text-gray-500">
      <TrendingUp className="w-16 h-16 mx-auto mb-4 opacity-50" />
      <p className="text-lg font-medium mb-2">Analytics Dashboard</p>
      <p className="text-sm">Detailed analytics and reports</p>
    </div>
  );
}

function TemplatesTab() {
  return (
    <div className="text-center py-12 text-gray-500">
      <FileText className="w-16 h-16 mx-auto mb-4 opacity-50" />
      <p className="text-lg font-medium mb-2">Industry Templates</p>
      <p className="text-sm">Pre-configured templates for different business types</p>
    </div>
  );
}

function KnowledgeTab() {
  return (
    <div className="text-center py-12 text-gray-500">
      <MessageSquare className="w-16 h-16 mx-auto mb-4 opacity-50" />
      <p className="text-lg font-medium mb-2">Knowledge Base</p>
      <p className="text-sm">FAQ and scripts management</p>
    </div>
  );
}

function CredentialsTab() {
  const [selectedProvider, setSelectedProvider] = useState<'twilio' | 'vonage' | 'microsoft_teams'>('twilio');

  const providers = [
    { id: 'twilio', name: 'Twilio', description: 'Global cloud communications platform' },
    { id: 'vonage', name: 'Vonage', description: 'Cloud communications and APIs' },
    { id: 'microsoft_teams', name: 'Microsoft Teams Phone', description: 'Enterprise cloud calling' }
  ];

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-gray-900 mb-2">Provider Credentials</h2>
        <p className="text-gray-600">
          Configure your telephony provider credentials. These will be encrypted and stored securely.
        </p>
      </div>

      {/* Provider Selection */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-3">Select Provider</label>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {providers.map((provider) => (
            <button
              key={provider.id}
              onClick={() => setSelectedProvider(provider.id as any)}
              className={`p-4 rounded-lg border-2 transition text-left ${
                selectedProvider === provider.id
                  ? 'border-blue-600 bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <h3 className="font-semibold text-gray-900 mb-1">{provider.name}</h3>
              <p className="text-sm text-gray-600">{provider.description}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Provider Credentials Form */}
      <ProviderCredentials
        providerId={`provider-${selectedProvider}`}
        providerName={selectedProvider}
        displayName={providers.find(p => p.id === selectedProvider)?.name || ''}
      />
    </div>
  );
}

function SettingsTab() {
  const [activeSubTab, setActiveSubTab] = useState('credentials');

  const subTabs = [
    { id: 'credentials', label: 'Credentials', icon: Key },
    { id: 'numbers', label: 'Numbers', icon: Phone },
    { id: 'general', label: 'General', icon: Settings }
  ];

  return (
    <div>
      {/* Sub-tabs Header */}
      <div className="flex gap-2 mb-6 border-b">
        {subTabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveSubTab(tab.id)}
              className={`px-4 py-3 flex items-center gap-2 border-b-2 transition ${
                activeSubTab === tab.id
                  ? 'border-blue-600 text-blue-600 font-medium'
                  : 'border-transparent text-gray-600 hover:text-gray-900'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Sub-tab Content */}
      <div>
        {activeSubTab === 'credentials' && <CredentialsTab />}
        {activeSubTab === 'numbers' && <CallCenterSettings />}
        {activeSubTab === 'general' && (
          <div className="text-center py-12 text-gray-500">
            <Settings className="w-16 h-16 mx-auto mb-4 opacity-50" />
            <p className="text-lg font-medium mb-2">General Settings</p>
            <p className="text-sm">Configure call center preferences and options</p>
          </div>
        )}
      </div>
    </div>
  );
}

function RecordingsTab() {
  const [recordings, setRecordings] = useState<any[]>([]);
  const [filteredRecordings, setFilteredRecordings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);

  // Filters state
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [directionFilter, setDirectionFilter] = useState('all');
  const [dateRange, setDateRange] = useState('all'); // all, today, week, month
  const [showFilters, setShowFilters] = useState(false);

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(25);

  useEffect(() => {
    loadRecordings();
  }, []);

  useEffect(() => {
    applyFilters();
  }, [recordings, searchQuery, statusFilter, directionFilter, dateRange]);

  function openRecording(recording: any) {
    window.location.href = `/dashboard/ext/call-center?callId=${recording.id}`;
  }

  async function loadRecordings() {
    try {
      setLoading(true);
      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/recordings?limit=1000`, { headers });
      if (res.ok) {
        const data = await res.json();
        setRecordings(data.recordings || []);
        setTotal(data.recordings?.length || 0);
      }
    } catch (error) {
      console.error('[Recordings] Load error:', error);
    } finally {
      setLoading(false);
    }
  }

  function applyFilters() {
    let filtered = [...recordings];

    // Search filter (Call SID, phone numbers)
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(rec =>
        rec.call_sid?.toLowerCase().includes(query) ||
        rec.from_number?.toLowerCase().includes(query) ||
        rec.to_number?.toLowerCase().includes(query) ||
        rec.id?.toLowerCase().includes(query)
      );
    }

    // Status filter
    if (statusFilter !== 'all') {
      filtered = filtered.filter(rec => rec.status === statusFilter);
    }

    // Direction filter
    if (directionFilter !== 'all') {
      filtered = filtered.filter(rec => rec.direction === directionFilter);
    }

    // Date range filter
    if (dateRange !== 'all') {
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      filtered = filtered.filter(rec => {
        const recDate = new Date(rec.started_at);
        if (dateRange === 'today') return recDate >= startOfToday;
        if (dateRange === 'week') return recDate >= startOfWeek;
        if (dateRange === 'month') return recDate >= startOfMonth;
        return true;
      });
    }

    setFilteredRecordings(filtered);
    setCurrentPage(1); // Reset to first page when filters change
  }

  function exportToCSV() {
    const headers = ['Call SID', 'Date/Time', 'Status', 'Direction', 'From', 'To', 'Duration', 'Provider'];
    const rows = filteredRecordings.map(rec => [
      rec.call_sid || rec.id,
      new Date(rec.started_at).toLocaleString(),
      rec.status,
      rec.direction,
      rec.from_number,
      rec.to_number,
      formatDuration(rec.duration_seconds),
      rec.provider || 'N/A'
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `call-logs-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
    toast.success('CSV exported successfully');
  }

  function formatDuration(seconds: number) {
    if (!seconds) return '0s';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  function formatDateTime(dateStr: string) {
    if (!dateStr) return 'N/A';
    const date = new Date(dateStr);
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function clearFilters() {
    setSearchQuery('');
    setStatusFilter('all');
    setDirectionFilter('all');
    setDateRange('all');
    toast.success('Filters cleared');
  }

  // Pagination
  const totalPages = Math.ceil(filteredRecordings.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const currentRecordings = filteredRecordings.slice(startIndex, endIndex);

  if (loading) {
    return (
      <div className="text-center py-12">
        <Loader2 className="w-8 h-8 text-blue-600 animate-spin mx-auto mb-4" />
        <p className="text-gray-600">Loading call logs...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with Actions */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xl font-bold text-gray-900">Call Logs</h3>
          <p className="text-sm text-gray-600 mt-1">
            {filteredRecordings.length} of {total} calls
            {(searchQuery || statusFilter !== 'all' || directionFilter !== 'all' || dateRange !== 'all') && ' (filtered)'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition flex items-center gap-2"
          >
            <Filter className="w-4 h-4" />
            {showFilters ? 'Hide Filters' : 'Show Filters'}
          </button>
          <button
            onClick={exportToCSV}
            disabled={filteredRecordings.length === 0}
            className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="w-4 h-4" />
            Export CSV
          </button>
          <button
            onClick={loadRecordings}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
        </div>
      </div>

      {/* Filters Panel */}
      {showFilters && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Date Range */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Date Range</label>
              <select
                value={dateRange}
                onChange={(e) => setDateRange(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="all">All Time</option>
                <option value="today">Today</option>
                <option value="week">Last 7 Days</option>
                <option value="month">This Month</option>
              </select>
            </div>

            {/* Status */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Status</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="all">All Status</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
                <option value="busy">Busy</option>
                <option value="no-answer">No Answer</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>

            {/* Direction */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Direction</label>
              <select
                value={directionFilter}
                onChange={(e) => setDirectionFilter(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="all">All Directions</option>
                <option value="inbound">Inbound</option>
                <option value="outbound">Outbound</option>
              </select>
            </div>

            {/* Search */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Search</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Call SID, Phone number..."
                  className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
          </div>

          {/* Clear Filters Button */}
          {(searchQuery || statusFilter !== 'all' || directionFilter !== 'all' || dateRange !== 'all') && (
            <div className="mt-4 pt-4 border-t border-gray-200">
              <button
                onClick={clearFilters}
                className="px-4 py-2 text-sm text-blue-600 hover:text-blue-700 font-medium flex items-center gap-2"
              >
                <X className="w-4 h-4" />
                Clear All Filters
              </button>
            </div>
          )}
        </div>
      )}

      {/* Call Logs Table */}
      {filteredRecordings.length === 0 ? (
        <div className="text-center py-12 bg-white border border-gray-200 rounded-xl">
          <PhoneCall className="w-16 h-16 mx-auto mb-4 text-gray-400" />
          <p className="text-lg font-medium text-gray-900 mb-2">No Calls Found</p>
          <p className="text-sm text-gray-600">
            {recordings.length === 0 ? 'Make some test calls to see them here' : 'Try adjusting your filters'}
          </p>
        </div>
      ) : (
        <>
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Call SID & Date
                    </th>
                    <th className="text-left px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="text-left px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Direction
                    </th>
                    <th className="text-left px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      From
                    </th>
                    <th className="text-left px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      To
                    </th>
                    <th className="text-left px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Duration
                    </th>
                    <th className="text-left px-6 py-4 text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Recording
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {currentRecordings.map((rec) => (
                    <tr
                      key={rec.id}
                      onClick={() => openRecording(rec)}
                      className="hover:bg-blue-50 cursor-pointer transition"
                    >
                      {/* Call SID & Date */}
                      <td className="px-6 py-4">
                        <div>
                          <p className="text-sm font-mono text-blue-600 hover:underline">
                            {rec.call_sid || rec.id.substring(0, 16) + '...'}
                          </p>
                          <p className="text-xs text-gray-600 mt-1">{formatDateTime(rec.started_at)}</p>
                        </div>
                      </td>

                      {/* Status */}
                      <td className="px-6 py-4">
                        <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                          rec.status === 'completed'
                            ? 'bg-green-100 text-green-700'
                            : rec.status === 'failed'
                            ? 'bg-red-100 text-red-700'
                            : rec.status === 'busy'
                            ? 'bg-orange-100 text-orange-700'
                            : 'bg-gray-100 text-gray-700'
                        }`}>
                          {rec.status}
                        </span>
                      </td>

                      {/* Direction */}
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          {rec.direction === 'inbound' ? (
                            <>
                              <PhoneIncoming className="w-4 h-4 text-green-600" />
                              <span className="text-sm text-gray-900">Inbound</span>
                            </>
                          ) : (
                            <>
                              <PhoneOutgoing className="w-4 h-4 text-blue-600" />
                              <span className="text-sm text-gray-900">Outbound</span>
                            </>
                          )}
                        </div>
                      </td>

                      {/* From */}
                      <td className="px-6 py-4">
                        <div>
                          <p className="text-sm font-medium text-gray-900">{rec.from_number}</p>
                          {rec.caller_name && (
                            <p className="text-xs text-gray-600">{rec.caller_name}</p>
                          )}
                        </div>
                      </td>

                      {/* To */}
                      <td className="px-6 py-4">
                        <div>
                          <p className="text-sm font-medium text-gray-900">{rec.to_number}</p>
                          {rec.phone_friendly_name && (
                            <p className="text-xs text-gray-600">{rec.phone_friendly_name}</p>
                          )}
                        </div>
                      </td>

                      {/* Duration */}
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <Clock className="w-4 h-4 text-gray-400" />
                          <span className="text-sm text-gray-900">{formatDuration(rec.duration_seconds)}</span>
                        </div>
                      </td>

                      {/* Recording */}
                      <td className="px-6 py-4">
                        {rec.recording_url ? (
                          <div className="flex items-center gap-2">
                            <a
                              href={rec.recording_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="p-2 hover:bg-blue-100 rounded-lg transition"
                              title="Play Recording"
                            >
                              <Play className="w-4 h-4 text-blue-600" />
                            </a>
                            <a
                              href={rec.recording_url}
                              download
                              onClick={(e) => e.stopPropagation()}
                              className="p-2 hover:bg-gray-100 rounded-lg transition"
                              title="Download Recording"
                            >
                              <Download className="w-4 h-4 text-gray-600" />
                            </a>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-6 py-4 bg-white border border-gray-200 rounded-xl">
              <p className="text-sm text-gray-600">
                Showing {startIndex + 1} to {Math.min(endIndex, filteredRecordings.length)} of {filteredRecordings.length} calls
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="px-3 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  Previous
                </button>
                <div className="flex items-center gap-1">
                  {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                    let pageNum;
                    if (totalPages <= 5) {
                      pageNum = i + 1;
                    } else if (currentPage <= 3) {
                      pageNum = i + 1;
                    } else if (currentPage >= totalPages - 2) {
                      pageNum = totalPages - 4 + i;
                    } else {
                      pageNum = currentPage - 2 + i;
                    }
                    return (
                      <button
                        key={pageNum}
                        onClick={() => setCurrentPage(pageNum)}
                        className={`px-3 py-2 rounded-lg transition ${
                          currentPage === pageNum
                            ? 'bg-blue-600 text-white'
                            : 'border border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        {pageNum}
                      </button>
                    );
                  })}
                </div>
                <button
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="px-3 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
