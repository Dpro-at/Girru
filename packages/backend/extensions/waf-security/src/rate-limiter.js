/**
 * WAF Rate Limiter Service
 *
 * Prevents abuse by limiting:
 * - Concurrent scans per user (max 10)
 * - Daily scans per user (max 100)
 */

export class WafRateLimiter {
  constructor(db) {
    this.db = db;
    this.MAX_CONCURRENT = 10;
    this.MAX_DAILY = 100;
  }

  /**
   * Check if user is within rate limits
   * @throws {Error} if rate limit exceeded
   */
  async checkLimit(userId) {
    // Check concurrent scans
    const activeScans = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM app_waf_security__waf_scans
      WHERE user_id = ? AND status IN ('pending', 'running')
    `).get(userId);

    if (activeScans.count >= this.MAX_CONCURRENT) {
      throw new Error(`Rate limit exceeded: Maximum ${this.MAX_CONCURRENT} concurrent scans allowed`);
    }

    // Get or create rate limit record
    let limits = this.db.prepare('SELECT * FROM app_waf_security__waf_rate_limits WHERE user_id = ?').get(userId);

    // Reset daily counter if new day
    const today = new Date().toISOString().split('T')[0];
    if (limits && limits.last_reset_date !== today) {
      this.db.prepare(`
        UPDATE app_waf_security__waf_rate_limits
        SET daily_scan_count = 0, last_reset_date = ?
        WHERE user_id = ?
      `).run(today, userId);
      limits = this.db.prepare('SELECT * FROM app_waf_security__waf_rate_limits WHERE user_id = ?').get(userId);
    }

    // Check daily limit
    if (limits && limits.daily_scan_count >= this.MAX_DAILY) {
      throw new Error(`Rate limit exceeded: Maximum ${this.MAX_DAILY} scans per day allowed`);
    }

    // Increment counters
    if (!limits) {
      // Create new record
      this.db.prepare(`
        INSERT INTO app_waf_security__waf_rate_limits (user_id, concurrent_scans, last_scan_at, daily_scan_count, last_reset_date)
        VALUES (?, 1, datetime('now'), 1, ?)
      `).run(userId, today);
    } else {
      // Update existing record
      this.db.prepare(`
        UPDATE app_waf_security__waf_rate_limits
        SET concurrent_scans = concurrent_scans + 1,
            last_scan_at = datetime('now'),
            daily_scan_count = daily_scan_count + 1,
            updated_at = datetime('now')
        WHERE user_id = ?
      `).run(userId);
    }

    return true;
  }

  /**
   * Release a concurrent scan slot (call when scan completes)
   */
  async releaseScan(userId) {
    this.db.prepare(`
      UPDATE app_waf_security__waf_rate_limits
      SET concurrent_scans = MAX(0, concurrent_scans - 1),
          updated_at = datetime('now')
      WHERE user_id = ?
    `).run(userId);
  }

  /**
   * Get current rate limit status for user
   */
  async getStatus(userId) {
    const limits = this.db.prepare('SELECT * FROM app_waf_security__waf_rate_limits WHERE user_id = ?').get(userId);
    const activeScans = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM app_waf_security__waf_scans
      WHERE user_id = ? AND status IN ('pending', 'running')
    `).get(userId);

    return {
      concurrentScans: activeScans.count,
      maxConcurrent: this.MAX_CONCURRENT,
      dailyScans: limits?.daily_scan_count || 0,
      maxDaily: this.MAX_DAILY,
      lastScanAt: limits?.last_scan_at || null,
      resetDate: limits?.last_reset_date || null,
    };
  }

  /**
   * Reset rate limits for user (admin function)
   */
  async resetLimits(userId) {
    this.db.prepare(`
      UPDATE app_waf_security__waf_rate_limits
      SET concurrent_scans = 0,
          daily_scan_count = 0,
          last_reset_date = date('now'),
          updated_at = datetime('now')
      WHERE user_id = ?
    `).run(userId);
  }
}
