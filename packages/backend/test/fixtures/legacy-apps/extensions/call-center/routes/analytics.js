/**
 * Call Analytics API Routes
 * Sentiment analysis, CSAT, cost tracking, and reporting
 */

import { Router } from 'express';
import { getDatabase } from '../../../../../../src/db/index.js';
import { generateSentimentSummary } from '../services/sentiment-analyzer.js';

const router = Router();

/**
 * GET /api/ext/call-center/analytics
 * List analytics entries (with filters)
 */
router.get('/', async (req, res) => {
  try {
    const db = getDatabase();
    const { call_point_id, sentiment_label, limit = 50 } = req.query;

    let query = `
      SELECT ca.*, cs.from_number, cs.to_number, cs.started_at, cs.ended_at
      FROM call_analytics ca
      JOIN call_sessions cs ON ca.call_session_id = cs.id
      WHERE 1=1
    `;
    const params = [];

    if (call_point_id) {
      query += ` AND ca.call_point_id = ?`;
      params.push(call_point_id);
    }

    if (sentiment_label) {
      query += ` AND ca.sentiment_label = ?`;
      params.push(sentiment_label);
    }

    query += ` ORDER BY ca.created_at DESC LIMIT ?`;
    params.push(parseInt(limit));

    const analytics = await db.all(query, params);

    res.json({
      analytics: analytics.map(a => ({
        ...a,
        issue_resolved: a.issue_resolved === 1,
        transfer_occurred: a.transfer_occurred === 1,
        detected_emotions: a.detected_emotions ? JSON.parse(a.detected_emotions) : []
      }))
    });
  } catch (error) {
    console.error('[Analytics API] Error listing analytics:', error);
    res.status(500).json({ error: 'Failed to list analytics' });
  }
});

/**
 * GET /api/ext/call-center/analytics/:id
 * Get single analytics entry
 */
router.get('/:id', async (req, res) => {
  try {
    const db = getDatabase();
    const { id } = req.params;

    const analytics = await db.get(
      `SELECT ca.*, cs.from_number, cs.to_number, cs.started_at, cs.ended_at
       FROM call_analytics ca
       JOIN call_sessions cs ON ca.call_session_id = cs.id
       WHERE ca.id = ?`,
      [id]
    );

    if (!analytics) {
      return res.status(404).json({ error: 'Analytics entry not found' });
    }

    res.json({
      analytics: {
        ...analytics,
        issue_resolved: analytics.issue_resolved === 1,
        transfer_occurred: analytics.transfer_occurred === 1,
        detected_emotions: analytics.detected_emotions ? JSON.parse(analytics.detected_emotions) : []
      }
    });
  } catch (error) {
    console.error('[Analytics API] Error getting analytics:', error);
    res.status(500).json({ error: 'Failed to get analytics' });
  }
});

/**
 * GET /api/ext/call-center/analytics/session/:sessionId
 * Get analytics by call session ID
 */
router.get('/session/:sessionId', async (req, res) => {
  try {
    const db = getDatabase();
    const { sessionId } = req.params;

    const analytics = await db.get(
      `SELECT * FROM call_analytics WHERE call_session_id = ?`,
      [sessionId]
    );

    if (!analytics) {
      return res.status(404).json({ error: 'Analytics not found for this session' });
    }

    res.json({
      analytics: {
        ...analytics,
        issue_resolved: analytics.issue_resolved === 1,
        transfer_occurred: analytics.transfer_occurred === 1,
        detected_emotions: analytics.detected_emotions ? JSON.parse(analytics.detected_emotions) : []
      }
    });
  } catch (error) {
    console.error('[Analytics API] Error getting analytics by session:', error);
    res.status(500).json({ error: 'Failed to get analytics' });
  }
});

/**
 * PUT /api/ext/call-center/analytics/:id
 * Update analytics (mainly for CSAT and issue resolution)
 */
router.put('/:id', async (req, res) => {
  try {
    const db = getDatabase();
    const { id } = req.params;
    const { csat_score, csat_feedback, issue_resolved } = req.body;

    // Check if analytics exists
    const existing = await db.get(
      `SELECT * FROM call_analytics WHERE id = ?`,
      [id]
    );

    if (!existing) {
      return res.status(404).json({ error: 'Analytics entry not found' });
    }

    // Update analytics
    await db.run(
      `UPDATE call_analytics SET
        csat_score = COALESCE(?, csat_score),
        csat_feedback = COALESCE(?, csat_feedback),
        issue_resolved = COALESCE(?, issue_resolved)
      WHERE id = ?`,
      [
        csat_score || null,
        csat_feedback || null,
        issue_resolved !== undefined ? (issue_resolved ? 1 : 0) : null,
        id
      ]
    );

    // Return updated analytics
    const updated = await db.get(
      `SELECT * FROM call_analytics WHERE id = ?`,
      [id]
    );

    res.json({
      analytics: {
        ...updated,
        issue_resolved: updated.issue_resolved === 1,
        transfer_occurred: updated.transfer_occurred === 1,
        detected_emotions: updated.detected_emotions ? JSON.parse(updated.detected_emotions) : []
      }
    });
  } catch (error) {
    console.error('[Analytics API] Error updating analytics:', error);
    res.status(500).json({ error: 'Failed to update analytics' });
  }
});

/**
 * GET /api/ext/call-center/analytics/dashboard/:callPointId
 * Get dashboard statistics for call point
 */
router.get('/dashboard/:callPointId', async (req, res) => {
  try {
    const db = getDatabase();
    const { callPointId } = req.params;
    const { days = 30 } = req.query;

    // Overall stats
    const stats = await db.get(
      `SELECT
        COUNT(*) as total_calls,
        AVG(sentiment_score) as avg_sentiment,
        AVG(csat_score) as avg_csat,
        SUM(CASE WHEN sentiment_label = 'positive' THEN 1 ELSE 0 END) as positive_calls,
        SUM(CASE WHEN sentiment_label = 'neutral' THEN 1 ELSE 0 END) as neutral_calls,
        SUM(CASE WHEN sentiment_label = 'negative' THEN 1 ELSE 0 END) as negative_calls,
        SUM(CASE WHEN issue_resolved = 1 THEN 1 ELSE 0 END) as resolved_issues,
        SUM(CASE WHEN transfer_occurred = 1 THEN 1 ELSE 0 END) as transfers,
        AVG(total_duration_seconds) as avg_duration,
        AVG(avg_response_time_ms) as avg_response_time,
        SUM(estimated_cost) as total_cost
      FROM call_analytics
      WHERE call_point_id = ?
        AND julianday('now') - julianday(created_at) <= ?`,
      [callPointId, parseInt(days)]
    );

    // CSAT distribution
    const csatDistribution = await db.all(
      `SELECT csat_score, COUNT(*) as count
       FROM call_analytics
       WHERE call_point_id = ?
         AND csat_score IS NOT NULL
         AND julianday('now') - julianday(created_at) <= ?
       GROUP BY csat_score
       ORDER BY csat_score`,
      [callPointId, parseInt(days)]
    );

    // Top emotions
    const allAnalytics = await db.all(
      `SELECT detected_emotions
       FROM call_analytics
       WHERE call_point_id = ?
         AND detected_emotions IS NOT NULL
         AND julianday('now') - julianday(created_at) <= ?`,
      [callPointId, parseInt(days)]
    );

    const emotionCounts = {};
    allAnalytics.forEach(a => {
      try {
        const emotions = JSON.parse(a.detected_emotions);
        emotions.forEach(emotion => {
          emotionCounts[emotion] = (emotionCounts[emotion] || 0) + 1;
        });
      } catch (e) {
        // Ignore parsing errors
      }
    });

    const topEmotions = Object.entries(emotionCounts)
      .map(([emotion, count]) => ({ emotion, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Daily trend (last 7 days)
    const dailyTrend = await db.all(
      `SELECT
        DATE(created_at) as date,
        COUNT(*) as calls,
        AVG(sentiment_score) as avg_sentiment,
        AVG(csat_score) as avg_csat
       FROM call_analytics
       WHERE call_point_id = ?
         AND julianday('now') - julianday(created_at) <= 7
       GROUP BY DATE(created_at)
       ORDER BY date DESC`,
      [callPointId]
    );

    // Resolution rate
    const resolutionRate = stats.total_calls > 0
      ? (stats.resolved_issues / stats.total_calls * 100).toFixed(1)
      : 0;

    // Transfer rate
    const transferRate = stats.total_calls > 0
      ? (stats.transfers / stats.total_calls * 100).toFixed(1)
      : 0;

    res.json({
      dashboard: {
        totalCalls: stats.total_calls || 0,
        avgSentiment: stats.avg_sentiment ? parseFloat(stats.avg_sentiment.toFixed(3)) : 0,
        avgCsat: stats.avg_csat ? parseFloat(stats.avg_csat.toFixed(2)) : null,
        positiveCalls: stats.positive_calls || 0,
        neutralCalls: stats.neutral_calls || 0,
        negativeCalls: stats.negative_calls || 0,
        resolvedIssues: stats.resolved_issues || 0,
        resolutionRate: parseFloat(resolutionRate),
        transfers: stats.transfers || 0,
        transferRate: parseFloat(transferRate),
        avgDuration: stats.avg_duration ? Math.round(stats.avg_duration) : 0,
        avgResponseTime: stats.avg_response_time ? Math.round(stats.avg_response_time) : 0,
        totalCost: stats.total_cost ? parseFloat(stats.total_cost.toFixed(2)) : 0,
        csatDistribution,
        topEmotions,
        dailyTrend: dailyTrend.map(d => ({
          date: d.date,
          calls: d.calls,
          avgSentiment: d.avg_sentiment ? parseFloat(d.avg_sentiment.toFixed(3)) : 0,
          avgCsat: d.avg_csat ? parseFloat(d.avg_csat.toFixed(2)) : null
        }))
      }
    });
  } catch (error) {
    console.error('[Analytics API] Error getting dashboard:', error);
    res.status(500).json({ error: 'Failed to get dashboard' });
  }
});

/**
 * GET /api/ext/call-center/analytics/sentiment-summary/:callPointId
 * Get sentiment summary (using sentiment analyzer service)
 */
router.get('/sentiment-summary/:callPointId', async (req, res) => {
  try {
    const db = getDatabase();
    const { callPointId } = req.params;
    const { days = 30 } = req.query;

    const sessions = await db.all(
      `SELECT sentiment_score, sentiment_label, detected_emotions
       FROM call_analytics
       WHERE call_point_id = ?
         AND julianday('now') - julianday(created_at) <= ?`,
      [callPointId, parseInt(days)]
    );

    const summary = generateSentimentSummary(sessions);

    res.json({ summary });
  } catch (error) {
    console.error('[Analytics API] Error getting sentiment summary:', error);
    res.status(500).json({ error: 'Failed to get sentiment summary' });
  }
});

/**
 * GET /api/ext/call-center/analytics/cost-report/:callPointId
 * Get cost breakdown report
 */
router.get('/cost-report/:callPointId', async (req, res) => {
  try {
    const db = getDatabase();
    const { callPointId } = req.params;
    const { days = 30 } = req.query;

    // Cost by model
    const byModel = await db.all(
      `SELECT
        model_used,
        COUNT(*) as calls,
        SUM(estimated_cost) as total_cost,
        AVG(estimated_cost) as avg_cost,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens
       FROM call_analytics
       WHERE call_point_id = ?
         AND estimated_cost IS NOT NULL
         AND julianday('now') - julianday(created_at) <= ?
       GROUP BY model_used
       ORDER BY total_cost DESC`,
      [callPointId, parseInt(days)]
    );

    // Daily cost trend
    const dailyCost = await db.all(
      `SELECT
        DATE(created_at) as date,
        COUNT(*) as calls,
        SUM(estimated_cost) as cost,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens
       FROM call_analytics
       WHERE call_point_id = ?
         AND estimated_cost IS NOT NULL
         AND julianday('now') - julianday(created_at) <= 7
       GROUP BY DATE(created_at)
       ORDER BY date DESC`,
      [callPointId]
    );

    // Total cost
    const total = await db.get(
      `SELECT
        SUM(estimated_cost) as total_cost,
        COUNT(*) as total_calls,
        AVG(estimated_cost) as avg_cost_per_call
       FROM call_analytics
       WHERE call_point_id = ?
         AND estimated_cost IS NOT NULL
         AND julianday('now') - julianday(created_at) <= ?`,
      [callPointId, parseInt(days)]
    );

    res.json({
      report: {
        totalCost: total.total_cost ? parseFloat(total.total_cost.toFixed(2)) : 0,
        totalCalls: total.total_calls || 0,
        avgCostPerCall: total.avg_cost_per_call ? parseFloat(total.avg_cost_per_call.toFixed(4)) : 0,
        byModel: byModel.map(m => ({
          ...m,
          total_cost: parseFloat(m.total_cost.toFixed(2)),
          avg_cost: parseFloat(m.avg_cost.toFixed(4))
        })),
        dailyCost: dailyCost.map(d => ({
          date: d.date,
          calls: d.calls,
          cost: parseFloat(d.cost.toFixed(2)),
          input_tokens: d.input_tokens,
          output_tokens: d.output_tokens
        }))
      }
    });
  } catch (error) {
    console.error('[Analytics API] Error getting cost report:', error);
    res.status(500).json({ error: 'Failed to get cost report' });
  }
});

export default router;
