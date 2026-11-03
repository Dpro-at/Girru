package dev.girru.app.pairing

import dev.girru.app.crypto.G1
import dev.girru.app.crypto.TestIdentity
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairedComputerTest {
    private val computer = TestIdentity()
    private val nowMs = 1_800_000_000_000L

    private fun payload() = PairingPayload(
        computerId = computer.id,
        computerKey = computer.spki,
        pairingId = "p_" + G1.b64url(ByteArray(32) { 2 }),
        secret = ByteArray(32) { 6 },
        relayUrl = "wss://relay.example.net/v1",
        localAddresses = listOf("10.0.0.2:41521"),
        expiresAtSec = nowMs / 1000 + 600,
        computerName = "Desk",
    )

    @Test
    fun waitingRecordRoundTripsThroughTheStoreCodec() {
        val waiting = PairedComputer.waiting(payload(), PairingLifetime.DAYS_60, nowMs)
        val bytes = StoreCodec.encode(waiting.toFields())
        val back = PairedComputer.fromFields(StoreCodec.decode(bytes)!!)!!
        assertEquals(PairedComputer.State.WAITING_FOR_APPROVAL, back.state)
        assertEquals(PairingLifetime.DAYS_60, back.lifetime)
        assertEquals(waiting.pending!!.pairingId, back.pending!!.pairingId)
        assertArrayEquals(waiting.pending!!.pairingKey, back.pending!!.pairingKey)
        assertEquals(listOf("10.0.0.2:41521"), back.localAddresses)
    }

    @Test
    fun welcomeMakesItPairedWithTheComputersLifetimeAndDropsPairingMaterial() {
        val waiting = PairedComputer.waiting(payload(), PairingLifetime.DAYS_30, nowMs)
        val paired = waiting.welcomed(PairingMessages.Welcome(ByteArray(32) { 8 }, PairingLifetime.NEVER, null), nowMs + 1000)
        assertEquals(PairedComputer.State.PAIRED, paired.state)
        assertEquals(PairingLifetime.NEVER, paired.lifetime)
        assertNull(paired.pending)
        assertFalse(paired.toFields().containsKey("pk"))
        assertFalse(paired.isExpired(nowMs + 10_000L * PairingExpiry.DAY_MS))
    }

    @Test
    fun staleRequestAndSlidingExpiry() {
        val waiting = PairedComputer.waiting(payload(), PairingLifetime.DAYS_30, nowMs)
        assertFalse(waiting.isRequestStale(nowMs + 60_000))
        assertTrue(waiting.isRequestStale(nowMs + 12 * 60_000))
        val paired = waiting.welcomed(PairingMessages.Welcome(ByteArray(32), PairingLifetime.DAYS_30, null), nowMs)
        val later = nowMs + 29 * PairingExpiry.DAY_MS
        assertFalse(paired.isExpired(later))
        assertFalse(paired.used(later).isExpired(later + 29 * PairingExpiry.DAY_MS))
        assertTrue(paired.isExpired(later + 29 * PairingExpiry.DAY_MS))
    }

    @Test
    fun refusesARecordWhoseKeyDoesNotMatch() {
        val fields = PairedComputer.waiting(payload(), PairingLifetime.DAYS_30, nowMs).toFields().toMutableMap()
        fields["k"] = G1.b64url(TestIdentity().spki)
        assertNull(PairedComputer.fromFields(fields))
        assertNull(StoreCodec.decode("bad line".toByteArray()))
    }
}
