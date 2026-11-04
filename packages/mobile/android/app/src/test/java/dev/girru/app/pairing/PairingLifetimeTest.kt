package dev.girru.app.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Scan once, stay paired: the lifetime slides from the last use. */
class PairingLifetimeTest {
    private val day = PairingExpiry.DAY_MS
    private val start = 1_800_000_000_000L

    @Test
    fun expiresOnlyAfterTheWholeLifetimeUnused() {
        assertFalse(PairingExpiry.isExpired(PairingLifetime.DAYS_30, start, start + 30 * day))
        assertTrue(PairingExpiry.isExpired(PairingLifetime.DAYS_30, start, start + 30 * day + 1))
        assertFalse(PairingExpiry.isExpired(PairingLifetime.DAYS_120, start, start + 100 * day))
    }

    @Test
    fun eachUseRenewsIt() {
        var lastUsed = start
        // Used every 20 days for a year: never expires with a 30-day lifetime.
        for (i in 1..18) {
            val now = start + i * 20 * day
            assertFalse(PairingExpiry.isExpired(PairingLifetime.DAYS_30, lastUsed, now))
            lastUsed = PairingExpiry.renew(lastUsed, now)
        }
        assertEquals(start + 360 * day, lastUsed)
    }

    @Test
    fun renewNeverMovesBackwards() {
        assertEquals(start, PairingExpiry.renew(start, start - day))
    }

    @Test
    fun neverExpiresMeansNever() {
        assertFalse(PairingExpiry.isExpired(PairingLifetime.NEVER, start, start + 10_000 * day))
        assertNull(PairingExpiry.expiresAt(PairingLifetime.NEVER, start))
        assertEquals(start + 60 * day, PairingExpiry.expiresAt(PairingLifetime.DAYS_60, start))
    }

    @Test
    fun clockSetBackIsNotExpiry() {
        assertFalse(PairingExpiry.isExpired(PairingLifetime.DAYS_30, start, start - 365 * day))
    }

    @Test
    fun wireFormRoundTrips() {
        PairingLifetime.entries.forEach { assertEquals(it, PairingLifetime.fromWire(it.wire)) }
        assertEquals("never", PairingLifetime.NEVER.wire)
        assertNull(PairingLifetime.fromWire("45"))
        assertEquals(PairingLifetime.DAYS_90, PairingLifetime.DEFAULT)
    }
}
