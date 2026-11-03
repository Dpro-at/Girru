package dev.girru.app.lock

/**
 * App lock rules. The lock cannot be turned off: every process start is
 * locked, and after the app has been in the background for the re-lock time
 * it locks again. The owner may only pick one of [CHOICES_MS], none longer
 * than [MAX_RELOCK_MS].
 *
 * Times come from a monotonic clock (SystemClock.elapsedRealtime) so changing
 * the phone's date cannot skip the lock.
 */
class LockPolicy(relockAfterMs: Long = MAX_RELOCK_MS) {
    var relockAfterMs: Long = normalize(relockAfterMs)
        private set

    private var locked = true
    private var backgroundedAt: Long? = null

    fun isLocked(nowMs: Long): Boolean {
        val since = backgroundedAt
        // A clock that went backwards fails closed.
        if (!locked && since != null && (nowMs < since || nowMs - since >= relockAfterMs)) locked = true
        return locked
    }

    fun onBackground(nowMs: Long) {
        if (!locked && backgroundedAt == null) backgroundedAt = nowMs
    }

    /** Returns true when the lock screen must be shown. */
    fun onForeground(nowMs: Long): Boolean {
        val mustLock = isLocked(nowMs)
        backgroundedAt = null
        return mustLock
    }

    fun onUnlocked() {
        locked = false
        backgroundedAt = null
    }

    fun lockNow() {
        locked = true
        backgroundedAt = null
    }

    /** Returns the value actually used. */
    fun setRelockAfter(ms: Long): Long {
        relockAfterMs = normalize(ms)
        return relockAfterMs
    }

    companion object {
        const val MAX_RELOCK_MS = 60_000L
        val CHOICES_MS = listOf(0L, 15_000L, 30_000L, MAX_RELOCK_MS)

        /** The longest allowed choice that is not longer than asked. */
        fun normalize(ms: Long): Long = CHOICES_MS.lastOrNull { it <= ms } ?: 0L
    }
}
