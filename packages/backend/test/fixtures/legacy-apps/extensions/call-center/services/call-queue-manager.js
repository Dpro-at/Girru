/**
 * Call Queue Manager
 * Hybrid in-memory + database queue for call overflow management
 * Supports VIP prioritization and context preservation for chat-to-phone handoff
 */

import { getDatabase } from '../../../../../../src/db/index.js';

class CallQueueManager {
  constructor() {
    // In-memory queues for fast access (Map<callPointId, QueueEntry[]>)
    this.activeQueues = new Map();
    this.db = getDatabase();
  }

  /**
   * Add caller to queue
   * @param {string} callPointId - Call point ID
   * @param {Object} entry - Queue entry data
   * @returns {Promise<Object>} Queue position and estimated wait
   */
  async addToQueue(callPointId, entry) {
    try {
      // Generate ID if not provided
      const id = entry.id || this._generateId();

      const queueEntry = {
        id,
        call_point_id: callPointId,
        from_number: entry.from_number,
        caller_name: entry.caller_name || null,
        status: 'waiting',
        position: 0, // Will be calculated
        estimated_wait_seconds: 0, // Will be calculated
        priority: entry.priority || 0,
        callback_requested: entry.callback_requested || false,
        callback_number: entry.callback_number || null,
        initial_message: entry.initial_message || null,
        context_data: entry.context_data ? JSON.stringify(entry.context_data) : null,
        queued_at: new Date().toISOString()
      };

      // 1. Add to in-memory queue (fast)
      const queue = this.activeQueues.get(callPointId) || [];
      queue.push(queueEntry);

      // Sort by priority (VIP first)
      queue.sort((a, b) => b.priority - a.priority);

      this.activeQueues.set(callPointId, queue);

      // Calculate position and wait time
      const position = queue.findIndex(e => e.id === id) + 1;
      const estimatedWaitSeconds = position * 120; // 2 minutes per caller

      queueEntry.position = position;
      queueEntry.estimated_wait_seconds = estimatedWaitSeconds;

      // 2. Persist to database (synchronous with better-sqlite3)
      this.db.prepare(
        `INSERT INTO call_queue (
          id, call_point_id, from_number, caller_name, status,
          position, estimated_wait_seconds, priority,
          callback_requested, callback_number,
          initial_message, context_data, queued_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        queueEntry.id,
        queueEntry.call_point_id,
        queueEntry.from_number,
        queueEntry.caller_name,
        queueEntry.status,
        queueEntry.position,
        queueEntry.estimated_wait_seconds,
        queueEntry.priority,
        queueEntry.callback_requested ? 1 : 0,
        queueEntry.callback_number,
        queueEntry.initial_message,
        queueEntry.context_data,
        queueEntry.queued_at
      );

      return {
        id: queueEntry.id,
        position,
        estimatedWaitSeconds,
        queueLength: queue.length
      };
    } catch (error) {
      console.error('[CallQueueManager] Error adding to queue:', error);
      throw error;
    }
  }

  /**
   * Get next caller from queue
   * @param {string} callPointId - Call point ID
   * @returns {Promise<Object|null>} Next caller or null if queue empty
   */
  async getNextCaller(callPointId) {
    try {
      const queue = this.activeQueues.get(callPointId) || [];

      if (queue.length === 0) {
        return null;
      }

      // Remove first caller (highest priority)
      const nextCaller = queue.shift();
      this.activeQueues.set(callPointId, queue);

      // Update database
      this.db.prepare(
        `UPDATE call_queue
         SET status = 'connected',
             connected_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).run(nextCaller.id);

      // Parse context_data if exists
      if (nextCaller.context_data) {
        try {
          nextCaller.context_data = JSON.parse(nextCaller.context_data);
        } catch (e) {
          console.error('[CallQueueManager] Error parsing context_data:', e);
        }
      }

      return nextCaller;
    } catch (error) {
      console.error('[CallQueueManager] Error getting next caller:', error);
      throw error;
    }
  }

  /**
   * Get current queue status
   * @param {string} callPointId - Call point ID
   * @returns {Promise<Object>} Queue statistics
   */
  async getQueueStatus(callPointId) {
    try {
      const queue = this.activeQueues.get(callPointId) || [];

      // Get database stats
      const dbStats = this.db.prepare(
        `SELECT
          COUNT(*) as total_waiting,
          AVG(estimated_wait_seconds) as avg_wait,
          MAX(priority) as highest_priority
         FROM call_queue
         WHERE call_point_id = ? AND status = 'waiting'`
      ).get(callPointId);

      return {
        callPointId,
        queueLength: queue.length,
        totalWaiting: dbStats?.total_waiting || 0,
        averageWaitSeconds: dbStats?.avg_wait || 0,
        highestPriority: dbStats?.highest_priority || 0,
        callers: queue.map((entry, index) => ({
          id: entry.id,
          position: index + 1,
          fromNumber: entry.from_number,
          callerName: entry.caller_name,
          priority: entry.priority,
          estimatedWaitSeconds: (index + 1) * 120,
          queuedAt: entry.queued_at
        }))
      };
    } catch (error) {
      console.error('[CallQueueManager] Error getting queue status:', error);
      throw error;
    }
  }

  /**
   * Remove caller from queue (abandoned call)
   * @param {string} callerId - Queue entry ID
   * @returns {Promise<boolean>} Success
   */
  async removeCaller(callerId) {
    try {
      // Find in in-memory queues
      for (const [callPointId, queue] of this.activeQueues.entries()) {
        const index = queue.findIndex(e => e.id === callerId);
        if (index !== -1) {
          queue.splice(index, 1);
          this.activeQueues.set(callPointId, queue);
          break;
        }
      }

      // Update database
      const now = new Date().toISOString();
      this.db.prepare(
        `UPDATE call_queue
         SET status = 'abandoned',
             completed_at = ?,
             wait_duration_seconds = (
               CAST((julianday(?) - julianday(queued_at)) * 86400 AS INTEGER)
             )
         WHERE id = ?`
      ).run(now, now, callerId);

      return true;
    } catch (error) {
      console.error('[CallQueueManager] Error removing caller:', error);
      throw error;
    }
  }

  /**
   * Complete caller (call finished)
   * @param {string} callerId - Queue entry ID
   * @returns {Promise<boolean>} Success
   */
  async completeCaller(callerId) {
    try {
      const now = new Date().toISOString();
      this.db.prepare(
        `UPDATE call_queue
         SET status = 'completed',
             completed_at = ?,
             wait_duration_seconds = (
               CAST((julianday(connected_at) - julianday(queued_at)) * 86400 AS INTEGER)
             )
         WHERE id = ?`
      ).run(now, callerId);

      return true;
    } catch (error) {
      console.error('[CallQueueManager] Error completing caller:', error);
      throw error;
    }
  }

  /**
   * Get queue history
   * @param {string} callPointId - Call point ID
   * @param {number} limit - Max records
   * @returns {Promise<Array>} Queue history
   */
  async getQueueHistory(callPointId, limit = 50) {
    try {
      const history = this.db.prepare(
        `SELECT * FROM call_queue
         WHERE call_point_id = ?
         ORDER BY queued_at DESC
         LIMIT ?`
      ).all(callPointId, limit);

      return history.map(entry => ({
        ...entry,
        context_data: entry.context_data ? JSON.parse(entry.context_data) : null,
        callback_requested: entry.callback_requested === 1
      }));
    } catch (error) {
      console.error('[CallQueueManager] Error getting queue history:', error);
      throw error;
    }
  }

  /**
   * Restore queues from database on startup
   * @returns {Promise<void>}
   */
  async restoreQueues() {
    try {
      console.log('[CallQueueManager] Restoring queues from database...');

      const waitingCallers = this.db
        .prepare(`SELECT * FROM call_queue WHERE status = 'waiting' ORDER BY priority DESC, queued_at ASC`)
        .all();

      // Rebuild in-memory queues
      for (const caller of waitingCallers) {
        const callPointId = caller.call_point_id;
        const queue = this.activeQueues.get(callPointId) || [];
        queue.push(caller);
        this.activeQueues.set(callPointId, queue);
      }

      console.log(`[CallQueueManager] Restored ${waitingCallers.length} waiting callers across ${this.activeQueues.size} call points`);
    } catch (error) {
      console.error('[CallQueueManager] Error restoring queues:', error);
      throw error;
    }
  }

  /**
   * Clean up old completed/abandoned queue entries
   * @param {number} daysOld - Delete entries older than N days
   * @returns {Promise<number>} Number of deleted entries
   */
  async cleanupOldEntries(daysOld = 30) {
    try {
      const result = this.db.prepare(
        `DELETE FROM call_queue
         WHERE status IN ('completed', 'abandoned')
         AND julianday('now') - julianday(completed_at) > ?`
      ).run(daysOld);

      console.log(`[CallQueueManager] Cleaned up ${result.changes} old queue entries`);
      return result.changes;
    } catch (error) {
      console.error('[CallQueueManager] Error cleaning up old entries:', error);
      throw error;
    }
  }

  /**
   * Generate unique ID for queue entry
   * @returns {string} Unique ID
   * @private
   */
  _generateId() {
    return `queue_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// Singleton instance
let instance = null;

/**
 * Get CallQueueManager instance
 * @returns {CallQueueManager}
 */
export function getCallQueueManager() {
  if (!instance) {
    instance = new CallQueueManager();
  }
  return instance;
}

export default CallQueueManager;
