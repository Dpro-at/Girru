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

    /** Why a system prompt is open, or null when none is. */
    var prompt: Prompt? = null
        private set
    private var leftDuringPrompt = false

    /** An unlock of the app, or a fresh check before a sensitive action while unlocked. */
    enum class Prompt { UNLOCK, CONFIRM }

    fun isLocked(nowMs: Long): Boolean {
        val since = backgroundedAt
        // A clock that went backwards fails closed.
        if (!locked && since != null && (nowMs < since || nowMs - since >= relockAfterMs)) locked = true
        return locked
    }

    /**
     * Always recorded, also while our own prompt is open: the passcode screen
     * stops the activity just like leaving the app does, and the two cannot be
     * told apart here. The prompt's outcome decides (see [onPromptFinished]).
     */
    fun onBackground(nowMs: Long) {
        if (prompt != null) leftDuringPrompt = true
        if (!locked && backgroundedAt == null) backgroundedAt = nowMs
    }

    /**
     * Returns true when the lock screen must be shown. [promptStillOpen] says
     * whether the system prompt is still showing; a prompt that vanished
     * without an answer (activity rebuilt, prompt dismissed by the system)
     * locks.
     */
    fun onForeground(nowMs: Long, promptStillOpen: Boolean = false): Boolean {
        if (prompt != null && !promptStillOpen) abandonPrompt()
        val mustLock = isLocked(nowMs)
        backgroundedAt = null
        return mustLock
    }

    fun onPromptStarted(kind: Prompt) {
        prompt = kind
        leftDuringPrompt = false
    }

    /**
     * The prompt's answer. Unlock: success unlocks (a fresh check by the
     * owner), anything else stays locked. Confirm: an error or cancel locks;
     * success while the app was stopped during the prompt also locks, since
     * that may have been someone leaving the app rather than our passcode
     * screen. Returns true when the app is unlocked afterwards.
     */
    fun onPromptFinished(kind: Prompt, success: Boolean, nowMs: Long): Boolean {
        val left = leftDuringPrompt
        val expected = prompt == kind
        prompt = null
        leftDuringPrompt = false
        when {
            !expected -> lockNow()
            kind == Prompt.UNLOCK && success -> onUnlocked()
            kind == Prompt.UNLOCK -> lockNow()
            !success || left -> lockNow()
        }
        return !isLocked(nowMs)
    }

    fun onUnlocked() {
        locked = false
        backgroundedAt = null
    }

    fun lockNow() {
        locked = true
        backgroundedAt = null
    }

    private fun abandonPrompt() {
        prompt = null
        leftDuringPrompt = false
        lockNow()
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
