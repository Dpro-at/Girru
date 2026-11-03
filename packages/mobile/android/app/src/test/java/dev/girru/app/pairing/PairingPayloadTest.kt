package dev.girru.app.pairing

import dev.girru.app.crypto.G1
import dev.girru.app.crypto.TestIdentity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URLEncoder

class PairingPayloadTest {
    private val computer = TestIdentity()
    private val now = 1_800_000_000L
    private val pid = "p_" + G1.b64url(ByteArray(32) { 7 })
    private val secret = G1.b64url(ByteArray(32) { 9 })

    private fun code(vararg overrides: Pair<String, String?>): String {
        val fields = linkedMapOf<String, String?>(
            "v" to "1",
            "cid" to computer.id,
            "ck" to G1.b64url(computer.spki),
            "pid" to pid,
            "ps" to secret,
            "exp" to (now + 300).toString(),
            "relay" to "wss://relay.example.net/v1",
            "lan" to "192.168.1.20:41521",
            "name" to "Work Mac",
        )
        overrides.forEach { (k, v) -> fields[k] = v }
        return PairingPayloadParser.PREFIX + fields.entries
            .mapNotNull { (k, v) -> v?.let { "$k=${URLEncoder.encode(it, "UTF-8")}" } }
            .joinToString("&")
    }

    private fun reason(text: String) = (PairingPayloadParser.parse(text, now) as PairingPayloadParser.Result.Error).reason

    @Test
    fun parsesAValidCode() {
        val result = PairingPayloadParser.parse(code(), now) as PairingPayloadParser.Result.Ok
        val p = result.payload
        assertEquals(computer.id, p.computerId)
        assertEquals(pid, p.pairingId)
        assertEquals("wss://relay.example.net/v1", p.relayUrl)
        assertEquals(listOf("192.168.1.20:41521"), p.localAddresses)
        assertEquals("Work Mac", p.computerName)
        assertEquals(now + 300, p.expiresAtSec)
    }

    @Test
    fun ignoresWhitespaceAndUnknownFields() {
        val text = code("future" to "x").chunked(20).joinToString("\n ")
        assertTrue(PairingPayloadParser.parse(text, now) is PairingPayloadParser.Result.Ok)
    }

    @Test
    fun refusesKeyThatDoesNotMatchTheId() {
        assertEquals(PairingPayloadParser.Reason.WRONG_KEY, reason(code("ck" to G1.b64url(TestIdentity().spki))))
    }

    @Test
    fun refusesExpiredOrTooFarAhead() {
        assertEquals(PairingPayloadParser.Reason.EXPIRED, reason(code("exp" to now.toString())))
        assertEquals(PairingPayloadParser.Reason.BAD_FIELD, reason(code("exp" to (now + 3600).toString())))
    }

    @Test
    fun relayMustBeExactlyWssWithV1() {
        assertEquals(PairingPayloadParser.Reason.BAD_FIELD, reason(code("relay" to "ws://relay.example.net/v1")))
        assertEquals(PairingPayloadParser.Reason.BAD_FIELD, reason(code("relay" to "wss://relay.example.net/v1/")))
        assertEquals(PairingPayloadParser.Reason.BAD_FIELD, reason(code("relay" to "wss://relay.example.net")))
    }

    @Test
    fun needsARoute() {
        assertEquals(PairingPayloadParser.Reason.NO_ROUTE, reason(code("relay" to null, "lan" to null)))
        assertTrue(PairingPayloadParser.parse(code("relay" to null), now) is PairingPayloadParser.Result.Ok)
    }

    @Test
    fun pairingIdNeedsThePrefix() {
        assertEquals(PairingPayloadParser.Reason.BAD_FIELD, reason(code("pid" to G1.b64url(ByteArray(32)))))
    }

    @Test
    fun refusesRepeatedFieldsAndOtherCodes() {
        assertEquals(PairingPayloadParser.Reason.BAD_FIELD, reason(code() + "&v=1"))
        assertEquals(PairingPayloadParser.Reason.NOT_A_GIRRU_CODE, reason("https://example.com"))
        assertEquals(PairingPayloadParser.Reason.UNSUPPORTED_VERSION, reason(code("v" to "2")))
        assertEquals(PairingPayloadParser.Reason.TOO_LONG, reason(code("name" to "x".repeat(1100))))
    }

    @Test
    fun localAddressesAreLocalOnly() {
        assertTrue(PairingPayloadParser.isLocalAddress("10.0.0.5:1"))
        assertTrue(PairingPayloadParser.isLocalAddress("172.31.255.1:65535"))
        assertTrue(PairingPayloadParser.isLocalAddress("169.254.10.10:80"))
        assertTrue(PairingPayloadParser.isLocalAddress("my-mac.local:41521"))
        assertFalse(PairingPayloadParser.isLocalAddress("8.8.8.8:53"))
        assertFalse(PairingPayloadParser.isLocalAddress("172.32.0.1:80"))
        assertFalse(PairingPayloadParser.isLocalAddress("192.168.1.1"))
        assertFalse(PairingPayloadParser.isLocalAddress("192.168.01.1:80"))
        assertFalse(PairingPayloadParser.isLocalAddress("example.com:443"))
        assertFalse(PairingPayloadParser.isLocalAddress("10.0.0.5:0"))
    }
}
