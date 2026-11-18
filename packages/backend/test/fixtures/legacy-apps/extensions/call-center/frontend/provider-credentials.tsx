'use client';

import { useState, useEffect } from 'react';
import { Key, Save, Eye, EyeOff, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';

const BACKEND_URL =
  typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'http://localhost:41522'
    : process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:41522';

interface ProviderCredentials {
  twilio?: {
    account_sid?: string;
    auth_token?: string;
    phone_number?: string;
  };
  microsoft_teams?: {
    tenant_id?: string;
    client_id?: string;
    client_secret?: string;
  };
  vonage?: {
    api_key?: string;
    api_secret?: string;
    application_id?: string;
  };
}

interface Props {
  providerId: string;
  providerName: 'twilio' | 'microsoft_teams' | 'vonage';
  displayName: string;
  onSaved?: () => void;
}

export default function ProviderCredentials({ providerId, providerName, displayName, onSaved }: Props) {
  const [credentials, setCredentials] = useState<any>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadCredentials();
  }, [providerId]);

  async function loadCredentials() {
    try {
      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/credentials?decrypt=true`, { headers });
      if (res.ok) {
        const data = await res.json();

        // Parse credentials array and group by provider
        const providerCreds: any = {};
        const prefix = `telephony.${providerName}.`;

        if (data.credentials && Array.isArray(data.credentials)) {
          for (const cred of data.credentials) {
            if (cred.name && cred.name.startsWith(prefix)) {
              const field = cred.name.substring(prefix.length);
              if (cred.value) {
                providerCreds[field] = cred.value;
              }
            }
          }
        }

        setCredentials(providerCreds);
        setSaved(Object.keys(providerCreds).length > 0);
      }
    } catch (error) {
      console.error('[Provider Credentials] Load error:', error);
    }
  }

  async function saveCredentials() {
    try {
      setLoading(true);

      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      // Load existing credentials to check for duplicates
      const existingRes = await fetch(`${BACKEND_URL}/api/credentials`, { headers });
      const existingData = await existingRes.json();
      const existingCreds = existingData.credentials || [];

      // Save each credential separately (update if exists, create if new)
      for (const [key, value] of Object.entries(credentials)) {
        if (value && value.toString().trim()) {
          const credName = `telephony.${providerName}.${key}`;

          // Check if credential already exists
          const existing = existingCreds.find((c: any) => c.name === credName);

          if (existing) {
            // Update existing credential
            await fetch(`${BACKEND_URL}/api/credentials/${existing.id}`, {
              method: 'PUT',
              headers,
              body: JSON.stringify({
                value: value.toString(),
                description: `${displayName} ${key.replace(/_/g, ' ')}`
              }),
            });
          } else {
            // Create new credential
            await fetch(`${BACKEND_URL}/api/credentials`, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                name: credName,
                type: 'api_key',
                value: value.toString(),
                description: `${displayName} ${key.replace(/_/g, ' ')}`
              }),
            });
          }
        }
      }

      // Auto-enable provider and set as default
      await fetch(`${BACKEND_URL}/api/ext/call-center/providers/${providerId}/toggle`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ enabled: true }),
      });

      await fetch(`${BACKEND_URL}/api/ext/call-center/providers/${providerId}/default`, {
        method: 'POST',
        headers,
      });

      // Reload credentials to show saved state
      await loadCredentials();

      setSaved(true);
      toast.success(`${displayName} enabled and configured successfully!`);
      onSaved?.();
    } catch (error) {
      console.error('[Provider Credentials] Save error:', error);
      toast.error('Failed to save credentials');
    } finally {
      setLoading(false);
    }
  }

  function toggleSecret(field: string) {
    setShowSecrets((prev) => ({ ...prev, [field]: !prev[field] }));
  }

  function updateField(field: string, value: string) {
    setCredentials((prev: any) => ({ ...prev, [field]: value }));
    setSaved(false);
  }

  // Render fields based on provider
  const renderFields = () => {
    switch (providerName) {
      case 'twilio':
        return (
          <>
            <CredentialField
              label="Account SID"
              field="account_sid"
              value={credentials.account_sid || ''}
              onChange={updateField}
              showSecret={showSecrets.account_sid}
              onToggleSecret={toggleSecret}
              placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            />
            <CredentialField
              label="Auth Token"
              field="auth_token"
              value={credentials.auth_token || ''}
              onChange={updateField}
              showSecret={showSecrets.auth_token}
              onToggleSecret={toggleSecret}
              placeholder="your-auth-token"
              isSecret
            />
            <div className="mt-2 p-4 bg-amber-50 border border-amber-200 rounded-lg text-sm">
              <p className="text-amber-900 font-medium mb-1">
                📞 To add phone numbers
              </p>
              <p className="text-amber-700">
                Use the <strong>Numbers</strong> tab to add and manage your Twilio phone numbers. Each number can have different capabilities (Voice, SMS, MMS, Fax).
              </p>
            </div>
            <div className="mt-2 p-3 bg-blue-50 rounded-lg text-sm">
              <a
                href="https://console.twilio.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-700 flex items-center gap-1"
              >
                <ExternalLink className="w-4 h-4" />
                Get credentials from Twilio Console
              </a>
            </div>
          </>
        );

      case 'microsoft_teams':
        return (
          <>
            <CredentialField
              label="Tenant ID"
              field="tenant_id"
              value={credentials.tenant_id || ''}
              onChange={updateField}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            />
            <CredentialField
              label="Client ID"
              field="client_id"
              value={credentials.client_id || ''}
              onChange={updateField}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            />
            <CredentialField
              label="Client Secret"
              field="client_secret"
              value={credentials.client_secret || ''}
              onChange={updateField}
              showSecret={showSecrets.client_secret}
              onToggleSecret={toggleSecret}
              placeholder="your-client-secret"
              isSecret
            />
            <div className="mt-2 p-3 bg-blue-50 rounded-lg text-sm space-y-1">
              <a
                href="https://portal.azure.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-700 flex items-center gap-1"
              >
                <ExternalLink className="w-4 h-4" />
                Register app in Azure Portal
              </a>
              <p className="text-gray-600 text-xs mt-1">
                Required permissions: Calls.AccessMedia.All, Calls.Initiate.All
              </p>
            </div>
          </>
        );

      case 'vonage':
        return (
          <>
            <CredentialField
              label="API Key"
              field="api_key"
              value={credentials.api_key || ''}
              onChange={updateField}
              placeholder="abcd1234"
            />
            <CredentialField
              label="API Secret"
              field="api_secret"
              value={credentials.api_secret || ''}
              onChange={updateField}
              showSecret={showSecrets.api_secret}
              onToggleSecret={toggleSecret}
              placeholder="your-api-secret"
              isSecret
            />
            <CredentialField
              label="Application ID (Optional)"
              field="application_id"
              value={credentials.application_id || ''}
              onChange={updateField}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            />
            <div className="mt-2 p-3 bg-blue-50 rounded-lg text-sm">
              <a
                href="https://dashboard.nexmo.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-700 flex items-center gap-1"
              >
                <ExternalLink className="w-4 h-4" />
                Get credentials from Vonage Dashboard
              </a>
            </div>
          </>
        );
    }
  };

  return (
    <div className="bg-white rounded-lg border p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-100 rounded-lg">
            <Key className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-gray-900">{displayName} Credentials</h3>
            <p className="text-sm text-gray-600">Stored encrypted in your database</p>
          </div>
        </div>
        {saved && (
          <div className="flex items-center gap-1 text-green-600">
            <CheckCircle2 className="w-4 h-4" />
            <span className="text-sm">Configured</span>
          </div>
        )}
      </div>

      {/* Fields */}
      <div className="space-y-4">{renderFields()}</div>

      {/* Save Button */}
      <button
        onClick={saveCredentials}
        disabled={loading}
        className="mt-6 w-full px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-medium"
      >
        {loading ? (
          <>
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            Saving...
          </>
        ) : (
          <>
            <Save className="w-4 h-4" />
            Save Credentials
          </>
        )}
      </button>
    </div>
  );
}

interface CredentialFieldProps {
  label: string;
  field: string;
  value: string;
  onChange: (field: string, value: string) => void;
  showSecret?: boolean;
  onToggleSecret?: (field: string) => void;
  placeholder?: string;
  isSecret?: boolean;
}

function CredentialField({
  label,
  field,
  value,
  onChange,
  showSecret,
  onToggleSecret,
  placeholder,
  isSecret,
}: CredentialFieldProps) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <div className="relative">
        <input
          type={isSecret && !showSecret ? 'password' : 'text'}
          value={value}
          onChange={(e) => onChange(field, e.target.value)}
          placeholder={placeholder}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 pr-10"
        />
        {isSecret && onToggleSecret && (
          <button
            type="button"
            onClick={() => onToggleSecret(field)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        )}
      </div>
    </div>
  );
}
