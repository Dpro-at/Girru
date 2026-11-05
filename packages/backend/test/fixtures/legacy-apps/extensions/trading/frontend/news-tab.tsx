'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Newspaper,
  TrendingUp,
  RefreshCw,
  Search,
  X,
  ExternalLink,
  Filter,
  Clock,
  Flame
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { config } from '@/lib/config';

interface NewsArticle {
  id: string;
  headline: string;
  summary: string;
  author: string;
  source: string;
  url: string;
  images: string[];
  symbols: string[];
  sentiment?: 'positive' | 'negative' | 'neutral';
  sentiment_score?: number;
  created_at: string;
}

interface TrendingSymbol {
  symbol: string;
  mention_count: number;
}

export function NewsTab() {
  const [news, setNews] = useState<NewsArticle[]>([]);
  const [trending, setTrending] = useState<TrendingSymbol[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [symbolFilter, setSymbolFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

  const [useCached, setUseCached] = useState(true); // Use cached news by default (faster)

  const authHeaders = useCallback(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }, []);

  // ============================================================================
  // DATA LOADING
  // ============================================================================

  const loadNews = useCallback(
    async (useCache = true) => {
      try {
        const endpoint = useCache ? '/api/ext/trading/news/cached' : '/api/ext/trading/news';

        const params = new URLSearchParams();
        if (activeFilter) params.append('symbols', activeFilter);
        params.append('limit', '50');

        const queryString = params.toString();
        const url = `${config.backendUrl}${endpoint}${queryString ? `?${queryString}` : ''}`;

        const res = await fetch(url, { headers: authHeaders() });

        if (!res.ok) {
          const error = await res.json();
          throw new Error(error.error || 'Failed to load news');
        }

        const data = await res.json();
        setNews(data.news || []);
      } catch (error: any) {
        console.error('Load news error:', error);
        toast.error(error.message || 'Failed to load news');
      }
    },
    [activeFilter, authHeaders]
  );

  const loadTrending = useCallback(async () => {
    try {
      const res = await fetch(`${config.backendUrl}/api/ext/trading/news/trending?limit=10`, {
        headers: authHeaders()
      });

      if (!res.ok) throw new Error('Failed to load trending symbols');

      const data = await res.json();
      setTrending(data.trending || []);
    } catch (error: any) {
      console.error('Load trending error:', error);
      // Don't show error toast for trending (non-critical)
    }
  }, [authHeaders]);

  // Initial load
  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      await Promise.all([loadNews(useCached), loadTrending()]);
      setLoading(false);
    };
    loadData();
  }, [loadNews, loadTrending, useCached]);

  // Reload when filter changes
  useEffect(() => {
    if (!loading) {
      loadNews(useCached);
    }
  }, [activeFilter, useCached, loadNews]);

  // Auto-refresh every 5 minutes (cached data)
  useEffect(() => {
    if (!useCached) return; // Only auto-refresh cached data

    const interval = setInterval(() => {
      loadNews(true);
      loadTrending();
    }, 300000); // 5 min

    return () => clearInterval(interval);
  }, [useCached, loadNews, loadTrending]);

  // ============================================================================
  // ACTIONS
  // ============================================================================

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadNews(useCached), loadTrending()]);
    setRefreshing(false);
    toast.success('News refreshed');
  };

  const handleFetchLive = async () => {
    setRefreshing(true);
    await loadNews(false); // Fetch from Alpaca API (not cache)
    setRefreshing(false);
    toast.success('Fetched latest news from Alpaca');
  };

  const handleFilterBySymbol = (symbol: string) => {
    if (activeFilter === symbol) {
      setActiveFilter(null); // Toggle off
    } else {
      setActiveFilter(symbol);
      setSymbolFilter(symbol);
    }
  };

  const handleClearFilter = () => {
    setActiveFilter(null);
    setSymbolFilter('');
  };

  // Search filtering (client-side)
  const filteredNews = news.filter((article) => {
    if (!searchQuery) return true;

    const query = searchQuery.toLowerCase();
    return (
      article.headline.toLowerCase().includes(query) ||
      article.summary.toLowerCase().includes(query) ||
      article.symbols.some((s) => s.toLowerCase().includes(query))
    );
  });

  // ============================================================================
  // RENDER
  // ============================================================================

  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  const getSentimentColor = (sentiment?: string) => {
    switch (sentiment) {
      case 'positive':
        return 'text-green-600 bg-green-50';
      case 'negative':
        return 'text-red-600 bg-red-50';
      case 'neutral':
        return 'text-gray-600 bg-gray-50';
      default:
        return 'text-gray-500 bg-gray-50';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm flex items-center gap-1.5 disabled:opacity-50"
          >
            <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
            <span className="hidden sm:inline">Refresh</span>
          </button>

          <button
            onClick={handleFetchLive}
            disabled={refreshing}
            className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition text-sm flex items-center gap-1.5 disabled:opacity-50"
          >
            <Newspaper className="w-4 h-4" />
            <span className="hidden sm:inline">Fetch Live</span>
          </button>

          <div className="flex items-center gap-2 text-xs sm:text-sm text-gray-600">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={useCached}
                onChange={(e) => setUseCached(e.target.checked)}
                className="rounded"
              />
              <span className="whitespace-nowrap">Use Cache</span>
            </label>
          </div>
        </div>

        {/* Search */}
        <div className="relative flex-1 sm:max-w-md">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search news..."
            className="w-full pl-10 pr-10 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Trending Symbols */}
      {trending.length > 0 && (
        <div className="bg-gradient-to-r from-orange-50 to-yellow-50 border border-orange-200 rounded-lg p-3 sm:p-4">
          <div className="flex items-center gap-2 mb-2 sm:mb-3">
            <Flame className="w-4 h-4 sm:w-5 sm:h-5 text-orange-600" />
            <h3 className="text-xs sm:text-sm font-semibold text-orange-900">Trending Symbols (24h)</h3>
          </div>
          <div className="flex flex-wrap gap-1.5 sm:gap-2">
            {trending.map((item) => (
              <button
                key={item.symbol}
                onClick={() => handleFilterBySymbol(item.symbol)}
                className={cn(
                  'px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg text-xs sm:text-sm font-medium transition whitespace-nowrap',
                  activeFilter === item.symbol
                    ? 'bg-orange-600 text-white'
                    : 'bg-white text-orange-700 hover:bg-orange-100 border border-orange-300'
                )}
              >
                {item.symbol}
                <span className="ml-1 sm:ml-1.5 text-xs opacity-75">({item.mention_count})</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Active Filter Badge */}
      {activeFilter && (
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-100 text-blue-700 rounded-lg text-sm">
            <Filter className="w-4 h-4" />
            <span>
              Filtered by: <strong>{activeFilter}</strong>
            </span>
            <button onClick={handleClearFilter} className="hover:bg-blue-200 rounded p-0.5">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* News Articles */}
      <div className="space-y-3 sm:space-y-4">
        {filteredNews.length === 0 ? (
          <div className="text-center py-8 sm:py-12 bg-gray-50 rounded-lg border border-gray-200">
            <Newspaper className="w-10 h-10 sm:w-12 sm:h-12 text-gray-400 mx-auto mb-2 sm:mb-3" />
            <p className="text-xs sm:text-sm text-gray-600 px-4">
              {searchQuery || activeFilter
                ? 'No news found matching your filters'
                : 'No news articles available. Click "Fetch Live" to load latest news.'}
            </p>
          </div>
        ) : (
          filteredNews.map((article) => (
            <div
              key={article.id}
              className="bg-white border border-gray-200 rounded-lg p-3 sm:p-5 hover:shadow-md transition"
            >
              {/* Header */}
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-4 mb-2 sm:mb-3">
                <div className="flex-1 min-w-0">
                  <a
                    href={article.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-base sm:text-lg font-bold text-gray-900 hover:text-blue-600 transition line-clamp-2 flex items-start gap-2"
                  >
                    <span className="flex-1">{article.headline}</span>
                    <ExternalLink className="w-3.5 h-3.5 sm:w-4 sm:h-4 flex-shrink-0 mt-0.5 sm:mt-1" />
                  </a>

                  <div className="flex flex-wrap items-center gap-2 mt-1.5 sm:mt-2 text-xs text-gray-500">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                      {formatTimeAgo(article.created_at)}
                    </span>
                    <span className="hidden sm:inline">•</span>
                    <span className="truncate">{article.source}</span>
                    {article.author && (
                      <>
                        <span className="hidden sm:inline">•</span>
                        <span className="truncate hidden sm:inline">{article.author}</span>
                      </>
                    )}
                  </div>
                </div>

                {/* Sentiment Badge */}
                {article.sentiment && (
                  <span
                    className={cn(
                      'px-2 py-1 rounded text-xs font-medium flex-shrink-0 self-start',
                      getSentimentColor(article.sentiment)
                    )}
                  >
                    {article.sentiment === 'positive' && '😊 Positive'}
                    {article.sentiment === 'negative' && '😟 Negative'}
                    {article.sentiment === 'neutral' && '😐 Neutral'}
                  </span>
                )}
              </div>

              {/* Summary */}
              {article.summary && (
                <p className="text-xs sm:text-sm text-gray-700 mb-2 sm:mb-3 line-clamp-3">{article.summary}</p>
              )}

              {/* Symbols */}
              {article.symbols && article.symbols.length > 0 && (
                <div className="flex flex-wrap gap-1.5 sm:gap-2">
                  {article.symbols.map((symbol) => (
                    <button
                      key={symbol}
                      onClick={() => handleFilterBySymbol(symbol)}
                      className={cn(
                        'px-2 py-0.5 sm:py-1 rounded text-xs font-medium font-mono transition whitespace-nowrap',
                        activeFilter === symbol
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                      )}
                    >
                      {symbol}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Load More (if needed in future) */}
      {filteredNews.length >= 50 && (
        <div className="text-center">
          <button
            onClick={() => loadNews(useCached)}
            className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition text-sm"
          >
            Load More News
          </button>
        </div>
      )}
    </div>
  );
}
