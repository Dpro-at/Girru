'use client';

import { useState, useEffect } from 'react';
import { Phone, Search, MapPin, DollarSign, Loader2, ShoppingCart, Check } from 'lucide-react';
import { toast } from 'sonner';

const BACKEND_URL =
  typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'http://localhost:41522'
    : process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:41522';

interface AvailableNumber {
  phoneNumber: string;
  friendlyName: string;
  locality: string;
  region: string;
  capabilities: {
    voice: boolean;
    sms: boolean;
    mms: boolean;
  };
  monthlyPrice: string;
  setupPrice: string;
}

interface Props {
  providerId: string;
  providerName: 'twilio' | 'microsoft_teams' | 'vonage';
  onNumberPurchased?: (phoneNumber: string) => void;
}

export default function BuyNumber({ providerId, providerName, onNumberPurchased }: Props) {
  const [countryCode, setCountryCode] = useState('US');
  const [areaCode, setAreaCode] = useState('');
  const [contains, setContains] = useState('');
  const [searching, setSearching] = useState(false);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [availableNumbers, setAvailableNumbers] = useState<AvailableNumber[]>([]);

  async function searchNumbers() {
    try {
      setSearching(true);
      setAvailableNumbers([]);

      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const params = new URLSearchParams({
        country: countryCode,
        ...(areaCode && { areaCode }),
        ...(contains && { contains }),
      });

      const res = await fetch(
        `${BACKEND_URL}/api/ext/call-center/numbers/available?${params}`,
        { headers }
      );

      if (res.ok) {
        const data = await res.json();
        setAvailableNumbers(data.numbers || []);
        if (data.numbers?.length === 0) {
          toast.info('No numbers found. Try different search criteria.');
        }
      } else {
        toast.error('Failed to search numbers');
      }
    } catch (error) {
      console.error('[Buy Number] Search error:', error);
      toast.error('Search failed');
    } finally {
      setSearching(false);
    }
  }

  async function purchaseNumber(phoneNumber: string) {
    try {
      setPurchasing(phoneNumber);

      const authToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const res = await fetch(`${BACKEND_URL}/api/ext/call-center/numbers/purchase`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ phoneNumber, providerId }),
      });

      if (res.ok) {
        toast.success(`Number ${phoneNumber} purchased successfully!`);
        onNumberPurchased?.(phoneNumber);
        // Remove purchased number from list
        setAvailableNumbers((prev) => prev.filter((n) => n.phoneNumber !== phoneNumber));
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to purchase number');
      }
    } catch (error) {
      console.error('[Buy Number] Purchase error:', error);
      toast.error('Purchase failed');
    } finally {
      setPurchasing(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Search Form */}
      <div className="bg-white rounded-lg border p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 bg-blue-100 rounded-lg">
            <Search className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-gray-900">Search Available Numbers</h3>
            <p className="text-sm text-gray-600">Find the perfect phone number for your business</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Country Code */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Country</label>
            <select
              value={countryCode}
              onChange={(e) => setCountryCode(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="US">United States</option>
              <option value="GB">United Kingdom</option>
              <option value="CA">Canada</option>
              <option value="AU">Australia</option>
              <option value="DE">Germany</option>
              <option value="FR">France</option>
              <option value="AE">UAE</option>
            </select>
          </div>

          {/* Area Code */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Area Code (Optional)</label>
            <input
              type="text"
              value={areaCode}
              onChange={(e) => setAreaCode(e.target.value)}
              placeholder="e.g. 415"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* Contains */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Contains (Optional)</label>
            <input
              type="text"
              value={contains}
              onChange={(e) => setContains(e.target.value)}
              placeholder="e.g. 1234"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </div>

        <button
          onClick={searchNumbers}
          disabled={searching}
          className="mt-4 w-full px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-medium"
        >
          {searching ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Searching...
            </>
          ) : (
            <>
              <Search className="w-4 h-4" />
              Search Numbers
            </>
          )}
        </button>
      </div>

      {/* Results */}
      {availableNumbers.length > 0 && (
        <div className="bg-white rounded-lg border p-6">
          <h3 className="text-lg font-bold text-gray-900 mb-4">
            Available Numbers ({availableNumbers.length})
          </h3>

          <div className="space-y-3">
            {availableNumbers.map((number) => (
              <div
                key={number.phoneNumber}
                className="flex items-center justify-between p-4 border rounded-lg hover:bg-gray-50 transition"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Phone className="w-4 h-4 text-gray-400" />
                    <span className="text-lg font-semibold text-gray-900">{number.phoneNumber}</span>
                  </div>
                  <div className="flex items-center gap-4 mt-1 text-sm text-gray-600">
                    <div className="flex items-center gap-1">
                      <MapPin className="w-3 h-3" />
                      {number.locality}, {number.region}
                    </div>
                    <div className="flex items-center gap-1">
                      <DollarSign className="w-3 h-3" />
                      {number.monthlyPrice}/mo
                    </div>
                  </div>
                  <div className="flex gap-2 mt-2">
                    {number.capabilities.voice && (
                      <span className="px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded">Voice</span>
                    )}
                    {number.capabilities.sms && (
                      <span className="px-2 py-0.5 bg-green-50 text-green-700 text-xs rounded">SMS</span>
                    )}
                    {number.capabilities.mms && (
                      <span className="px-2 py-0.5 bg-purple-50 text-purple-700 text-xs rounded">MMS</span>
                    )}
                  </div>
                </div>

                <button
                  onClick={() => purchaseNumber(number.phoneNumber)}
                  disabled={purchasing === number.phoneNumber}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm font-medium"
                >
                  {purchasing === number.phoneNumber ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Purchasing...
                    </>
                  ) : (
                    <>
                      <ShoppingCart className="w-4 h-4" />
                      Buy Now
                    </>
                  )}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {!searching && availableNumbers.length === 0 && (
        <div className="bg-white rounded-lg border p-12 text-center">
          <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Phone className="w-8 h-8 text-gray-400" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">No Numbers Yet</h3>
          <p className="text-gray-600">Search for available numbers to get started</p>
        </div>
      )}
    </div>
  );
}
