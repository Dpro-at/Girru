package dev.girru.app.lock

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LockPolicyTest {
    @Test
    fun startsLockedAndUnlocksOnlyWhenTold() {
        val lock = LockPolicy()
        assertTrue(lock.isLocked(0))
        assertTrue(lock.onForeground(0))
        lock.onUnlocked()
        assertFalse(lock.isLocked(1))
    }

    @Test
    fun relocksAfterTheTimeInBackground() {
        val lock = LockPolicy()
        lock.onUnlocked()
        lock.onBackground(1_000)
        assertFalse(lock.onForeground(1_000 + 59_999))
        lock.onBackground(100_000)
        assertTrue(lock.onForeground(100_000 + 60_000))
        assertTrue(lock.isLocked(200_000))
    }

    @Test
    fun clockGoingBackwardsLocks() {
        val lock = LockPolicy()
        lock.onUnlocked()
        lock.onBackground(5_000)
        assertTrue(lock.onForeground(4_000))
    }

    @Test
    fun unlockPromptUnlocksOnlyOnSuccess() {
        val lock = LockPolicy()
        lock.onPromptStarted(LockPolicy.Prompt.UNLOCK)
        assertFalse(lock.onPromptFinished(LockPolicy.Prompt.UNLOCK, success = false, nowMs = 1))
        assertTrue(lock.isLocked(1))
        lock.onPromptStarted(LockPolicy.Prompt.UNLOCK)
        // The passcode screen stops the activity; a successful unlock still unlocks.
        lock.onBackground(2)
        assertTrue(lock.onForeground(3, promptStillOpen = true))
        assertTrue(lock.onPromptFinished(LockPolicy.Prompt.UNLOCK, success = true, nowMs = 4))
    }

    @Test
    fun cancelledOrFailedConfirmLocks() {
        val lock = LockPolicy()
        lock.onUnlocked()
        lock.onPromptStarted(LockPolicy.Prompt.CONFIRM)
        assertFalse(lock.onPromptFinished(LockPolicy.Prompt.CONFIRM, success = false, nowMs = 1))
        assertTrue(lock.isLocked(1))
    }

    @Test
    fun confirmDuringWhichTheAppWasStoppedLocks() {
        val lock = LockPolicy()
        lock.onUnlocked()
        lock.onPromptStarted(LockPolicy.Prompt.CONFIRM)
        lock.onBackground(10)
        assertFalse(lock.onPromptFinished(LockPolicy.Prompt.CONFIRM, success = true, nowMs = 20))
        assertTrue(lock.isLocked(20))
    }

    @Test
    fun confirmWithoutLeavingKeepsTheAppUnlocked() {
        val lock = LockPolicy()
        lock.onUnlocked()
        lock.onPromptStarted(LockPolicy.Prompt.CONFIRM)
        assertTrue(lock.onPromptFinished(LockPolicy.Prompt.CONFIRM, success = true, nowMs = 5))
        assertFalse(lock.isLocked(5))
    }

    @Test
    fun backgroundDuringAPromptStillStartsTheRelockTimer() {
        val lock = LockPolicy()
        lock.onUnlocked()
        lock.onPromptStarted(LockPolicy.Prompt.CONFIRM)
        lock.onBackground(0)
        // Away longer than the re-lock time while the prompt is still open: locked anyway.
        assertTrue(lock.onForeground(LockPolicy.MAX_RELOCK_MS, promptStillOpen = true))
    }

    @Test
    fun promptThatVanishedWithoutAnAnswerLocks() {
        val lock = LockPolicy()
        lock.onUnlocked()
        lock.onPromptStarted(LockPolicy.Prompt.CONFIRM)
        lock.onBackground(1)
        assertTrue(lock.onForeground(2, promptStillOpen = false))
        assertEquals(null, lock.prompt)
        // A late answer for a prompt that is no longer open does not unlock.
        assertFalse(lock.onPromptFinished(LockPolicy.Prompt.UNLOCK, success = true, nowMs = 3))
    }

    @Test
    fun ownerCanOnlyShortenNeverDisable() {
        val lock = LockPolicy()
        assertEquals(LockPolicy.MAX_RELOCK_MS, lock.setRelockAfter(Long.MAX_VALUE))
        assertEquals(15_000L, lock.setRelockAfter(20_000))
        assertEquals(0L, lock.setRelockAfter(-1))
        lock.onUnlocked()
        lock.onBackground(10)
        // Immediately: any time in the background locks again.
        assertTrue(lock.onForeground(10))
    }
}
