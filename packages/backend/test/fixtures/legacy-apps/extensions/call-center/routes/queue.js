/**
 * Call Queue API Routes
 * Queue management for call overflow
 */

import { Router } from 'express';
import { getDatabase } from '../../../../../../src/db/index.js';
import { getCallQueueManager } from '../services/call-queue-manager.js';

const router = Router();

/**
 * GET /api/ext/call-center/queue
 * List queue entries (with filters)
 */
router.get('/', async (req, res) => {
  try {
    const db = getDatabase();
    const { call_point_id, status, limit = 50 } = req.query;

    let query = `SELECT * FROM call_queue WHERE 1=1`;
    const params = [];

    if (call_point_id) {
      query += ` AND call_point_id = ?`;
      params.push(call_point_id);
    }

    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }

    query += ` ORDER BY priority DESC, queued_at ASC LIMIT ?`;
    params.push(parseInt(limit));

    const entries = await db.all(query, params);

    res.json({
      entries: entries.map(e => ({
        ...e,
        callback_requested: e.callback_requested === 1,
        context_data: e.context_data ? JSON.parse(e.context_data) : null
      }))
    });
  } catch (error) {
    console.error('[Queue API] Error listing queue:', error);
    res.status(500).json({ error: 'Failed to list queue entries' });
  }
});

/**
 * GET /api/ext/call-center/queue/status/:callPointId
 * Get real-time queue status for a call point
 */
router.get('/status/:callPointId', async (req, res) => {
  try {
    const { callPointId } = req.params;
    const queueManager = getCallQueueManager();

    const status = await queueManager.getQueueStatus(callPointId);

    res.json({ status });
  } catch (error) {
    console.error('[Queue API] Error getting queue status:', error);
    res.status(500).json({ error: 'Failed to get queue status' });
  }
});

/**
 * POST /api/ext/call-center/queue
 * Add caller to queue
 */
router.post('/', async (req, res) => {
  try {
    const queueManager = getCallQueueManager();
    const {
      call_point_id,
      from_number,
      caller_name,
      priority = 0,
      callback_requested = false,
      callback_number,
      initial_message,
      context_data
    } = req.body;

    // Validate required fields
    if (!call_point_id || !from_number) {
      return res.status(400).json({ error: 'call_point_id and from_number are required' });
    }

    // Add to queue
    const result = await queueManager.addToQueue(call_point_id, {
      from_number,
      caller_name,
      priority,
      callback_requested,
      callback_number,
      initial_message,
      context_data
    });

    res.status(201).json({
      success: true,
      queueEntry: result
    });
  } catch (error) {
    console.error('[Queue API] Error adding to queue:', error);
    res.status(500).json({ error: 'Failed to add to queue' });
  }
});

/**
 * POST /api/ext/call-center/queue/next/:callPointId
 * Get next caller from queue
 */
router.post('/next/:callPointId', async (req, res) => {
  try {
    const { callPointId } = req.params;
    const queueManager = getCallQueueManager();

    const nextCaller = await queueManager.getNextCaller(callPointId);

    if (!nextCaller) {
      return res.status(404).json({ error: 'No callers in queue' });
    }

    res.json({ caller: nextCaller });
  } catch (error) {
    console.error('[Queue API] Error getting next caller:', error);
    res.status(500).json({ error: 'Failed to get next caller' });
  }
});

/**
 * DELETE /api/ext/call-center/queue/:id
 * Remove caller from queue (abandoned)
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const queueManager = getCallQueueManager();

    const result = await queueManager.removeCaller(id);

    res.json({
      success: result,
      message: 'Caller removed from queue'
    });
  } catch (error) {
    console.error('[Queue API] Error removing from queue:', error);
    res.status(500).json({ error: 'Failed to remove from queue' });
  }
});

/**
 * POST /api/ext/call-center/queue/:id/complete
 * Mark caller as completed
 */
router.post('/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    const queueManager = getCallQueueManager();

    const result = await queueManager.completeCaller(id);

    res.json({
      success: result,
      message: 'Caller marked as completed'
    });
  } catch (error) {
    console.error('[Queue API] Error completing caller:', error);
    res.status(500).json({ error: 'Failed to complete caller' });
  }
});

/**
 * GET /api/ext/call-center/queue/history/:callPointId
 * Get queue history for call point
 */
router.get('/history/:callPointId', async (req, res) => {
  try {
    const { callPointId } = req.params;
    const { limit = 50 } = req.query;
    const queueManager = getCallQueueManager();

    const history = await queueManager.getQueueHistory(callPointId, parseInt(limit));

    res.json({ history });
  } catch (error) {
    console.error('[Queue API] Error getting queue history:', error);
    res.status(500).json({ error: 'Failed to get queue history' });
  }
});

/**
 * POST /api/ext/call-center/queue/cleanup
 * Clean up old completed/abandoned entries
 */
router.post('/cleanup', async (req, res) => {
  try {
    const { days_old = 30 } = req.body;
    const queueManager = getCallQueueManager();

    const deletedCount = await queueManager.cleanupOldEntries(parseInt(days_old));

    res.json({
      success: true,
      deletedCount,
      message: `Cleaned up ${deletedCount} old queue entries`
    });
  } catch (error) {
    console.error('[Queue API] Error cleaning up queue:', error);
    res.status(500).json({ error: 'Failed to clean up queue' });
  }
});

/**
 * GET /api/ext/call-center/queue/stats/:callPointId
 * Get queue statistics
 */
router.get('/stats/:callPointId', async (req, res) => {
  try {
    const db = getDatabase();
    const { callPointId } = req.params;

    // Get stats from database
    const stats = await db.get(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) as waiting,
        SUM(CASE WHEN status = 'connected' THEN 1 ELSE 0 END) as connected,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'abandoned' THEN 1 ELSE 0 END) as abandoned,
        AVG(CASE WHEN wait_duration_seconds IS NOT NULL THEN wait_duration_seconds ELSE 0 END) as avg_wait_seconds,
        MAX(priority) as highest_priority
      FROM call_queue
      WHERE call_point_id = ?`,
      [callPointId]
    );

    // Get abandonment rate (last 24 hours)
    const abandonment = await db.get(
      `SELECT
        COUNT(*) as total_24h,
        SUM(CASE WHEN status = 'abandoned' THEN 1 ELSE 0 END) as abandoned_24h
      FROM call_queue
      WHERE call_point_id = ?
        AND julianday('now') - julianday(queued_at) <= 1`,
      [callPointId]
    );

    const abandonmentRate = abandonment.total_24h > 0
      ? (abandonment.abandoned_24h / abandonment.total_24h * 100).toFixed(1)
      : 0;

    res.json({
      stats: {
        ...stats,
        avg_wait_seconds: Math.round(stats.avg_wait_seconds || 0),
        abandonment_rate_24h: parseFloat(abandonmentRate)
      }
    });
  } catch (error) {
    console.error('[Queue API] Error getting queue stats:', error);
    res.status(500).json({ error: 'Failed to get queue stats' });
  }
});

export default router;
