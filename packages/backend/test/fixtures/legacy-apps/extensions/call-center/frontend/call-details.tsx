'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Phone,
  Clock,
  User,
  MapPin,
  FileText,
  Play,
  Download,
  Share2,
  PhoneCall,
  AlertCircle
} from 'lucide-react';
import { toast } from 'sonner';

const BACKEND_URL =
  typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'http://localhost:41522'
    : process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:41522';

interface CallDetailsPageProps {
  callId: string;
}

export default function CallDetailsPage({ callId }: CallDetailsPageProps) {
  const router = useRouter();
  const [call, setCall] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadCallDetails();
  }, [callId]);

  async function loadCallDetails() {
    try {
      setLoading(true);
      setError(null);

      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/recordings?limit=1000`, { headers });
      if (res.ok) {
        const data = await res.json();
        const recording = data.recordings?.find((r: any) => r.id === callId);

        if (recording) {
          setCall(recording);
        } else {
          setError('Call not found');
        }
      } else {
        setError('Failed to load call details');
      }
    } catch (error) {
      console.error('[Call Details] Load error:', error);
      setError('Failed to load call details');
    } finally {
      setLoading(false);
    }
  }

  function formatDuration(seconds: number) {
    if (!seconds) return '0s';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  function formatDate(dateStr: string) {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleString();
  }

  function copyShareLink() {
    const url = window.location.href;
    navigator.clipboard.writeText(url);
    toast.success('Link copied to clipboard');
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
          <p className="text-gray-600">Loading call details...</p>
        </div>
      </div>
    );
  }

  if (error || !call) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Call Not Found</h2>
          <p className="text-gray-600 mb-6">{error || 'This call does not exist'}</p>
          <button
            onClick={() => router.push('/dashboard/ext/call-center?tab=recordings')}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
          >
            Back to Call History
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button
                onClick={() => router.push('/dashboard/ext/call-center?tab=recordings')}
                className="p-2 hover:bg-gray-100 rounded-lg transition"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div>
                <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-3">
                  <PhoneCall className="w-6 h-6 text-blue-600" />
                  Call Details
                </h1>
                <p className="text-sm text-gray-600">
                  {call.direction === 'inbound' ? 'Inbound' : 'Outbound'} call •{' '}
                  {formatDate(call.started_at)}
                </p>
              </div>
            </div>

            <button
              onClick={copyShareLink}
              className="flex items-center gap-2 px-4 py-2 border rounded-lg hover:bg-gray-50 transition"
            >
              <Share2 className="w-4 h-4" />
              Share Link
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Info */}
          <div className="lg:col-span-2 space-y-6">
            {/* Status Card */}
            <div className="bg-white rounded-xl border p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold text-gray-900">Call Status</h2>
                <span
                  className={`px-4 py-2 rounded-full text-sm font-medium ${
                    call.status === 'completed'
                      ? 'bg-green-100 text-green-700'
                      : call.status === 'failed'
                      ? 'bg-red-100 text-red-700'
                      : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {call.status}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div className="flex items-start gap-3">
                  <div className="p-3 bg-blue-100 rounded-lg">
                    <Phone className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-600">Direction</p>
                    <p className="font-semibold text-gray-900">
                      {call.direction === 'inbound' ? 'Inbound' : 'Outbound'}
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="p-3 bg-purple-100 rounded-lg">
                    <Clock className="w-5 h-5 text-purple-600" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-600">Duration</p>
                    <p className="font-semibold text-gray-900">
                      {formatDuration(call.duration_seconds)}
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="p-3 bg-green-100 rounded-lg">
                    <User className="w-5 h-5 text-green-600" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-600">From</p>
                    <p className="font-semibold text-gray-900">{call.from_number}</p>
                    {call.caller_name && (
                      <p className="text-sm text-gray-600">{call.caller_name}</p>
                    )}
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="p-3 bg-orange-100 rounded-lg">
                    <MapPin className="w-5 h-5 text-orange-600" />
                  </div>
                  <div>
                    <p className="text-sm text-gray-600">To</p>
                    <p className="font-semibold text-gray-900">{call.to_number}</p>
                    {call.phone_friendly_name && (
                      <p className="text-sm text-gray-600">{call.phone_friendly_name}</p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Transcript */}
            {call.transcript && (
              <div className="bg-white rounded-xl border p-6">
                <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                  <FileText className="w-5 h-5 text-blue-600" />
                  Transcript
                </h2>
                <div className="prose prose-sm max-w-none">
                  <p className="text-gray-700 whitespace-pre-wrap">{call.transcript}</p>
                </div>
              </div>
            )}

            {/* Recording */}
            {call.recording_url && (
              <div className="bg-white rounded-xl border p-6">
                <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                  <Play className="w-5 h-5 text-purple-600" />
                  Recording
                </h2>
                <div className="flex gap-3">
                  <a
                    href={call.recording_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 px-4 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition flex items-center justify-center gap-2"
                  >
                    <Play className="w-4 h-4" />
                    Play Recording
                  </a>
                  <a
                    href={call.recording_url}
                    download
                    className="px-4 py-3 border rounded-lg hover:bg-gray-50 transition flex items-center gap-2"
                  >
                    <Download className="w-4 h-4" />
                    Download
                  </a>
                </div>
              </div>
            )}
          </div>

          {/* Sidebar - Technical Details */}
          <div className="space-y-6">
            {/* Timing */}
            <div className="bg-white rounded-xl border p-6">
              <h3 className="font-semibold text-gray-900 mb-4">Timing</h3>
              <div className="space-y-3 text-sm">
                <div>
                  <p className="text-gray-600">Started</p>
                  <p className="font-medium text-gray-900">{formatDate(call.started_at)}</p>
                </div>
                <div>
                  <p className="text-gray-600">Ended</p>
                  <p className="font-medium text-gray-900">{formatDate(call.ended_at)}</p>
                </div>
                <div>
                  <p className="text-gray-600">Duration</p>
                  <p className="font-medium text-gray-900">
                    {formatDuration(call.duration_seconds)}
                  </p>
                </div>
              </div>
            </div>

            {/* Technical Info */}
            <div className="bg-white rounded-xl border p-6">
              <h3 className="font-semibold text-gray-900 mb-4">Technical Details</h3>
              <div className="space-y-3 text-sm">
                <div>
                  <p className="text-gray-600">Call SID</p>
                  <p className="font-mono text-xs text-gray-900 break-all">{call.call_sid}</p>
                </div>
                <div>
                  <p className="text-gray-600">Call ID</p>
                  <p className="font-mono text-xs text-gray-900 break-all">{call.id}</p>
                </div>
                {call.phone_number_id && (
                  <div>
                    <p className="text-gray-600">Phone Number ID</p>
                    <p className="font-mono text-xs text-gray-900 break-all">
                      {call.phone_number_id}
                    </p>
                  </div>
                )}
                {call.provider && (
                  <div>
                    <p className="text-gray-600">Provider</p>
                    <p className="font-medium text-gray-900">{call.provider}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
