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
