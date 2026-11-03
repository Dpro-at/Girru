package dev.girru.app.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WebTest {
    @Test
    fun originMatchesOnlyItself() {
        val o = WebOrigin.COMPUTER
        assertEquals("https://computer.girru.invalid", o.rule())
        assertTrue(o.matches("https://computer.girru.invalid/chat?x=1"))
        assertTrue(o.matches("https://computer.girru.invalid:443/"))
        assertFalse(o.matches("http://computer.girru.invalid/"))
        assertFalse(o.matches("https://computer.girru.invalid.evil.com/"))
        assertFalse(o.matches("https://computer.girru.invalid:8443/"))
        assertFalse(o.matches("javascript:alert(1)"))
        assertFalse(o.matches(null))
    }

    @Test
    fun originRefusesPlainHttpAndUserInfo() {
        assertNull(WebOrigin.parse("http://127.0.0.1:41522/"))
        assertNull(WebOrigin.parse("https://user@example.com/"))
        assertEquals("https://example.com:8443", WebOrigin.parse("https://example.com:8443/x")!!.rule())
    }

    @Test
    fun bridgeAcceptsOnlyKnownCallsWithCheckedArguments() {
        assertTrue(BridgeCall.parse("lock.state", "1", emptyMap()) is BridgeCall.LockState)
        assertEquals(BridgeCall.SetRelock("a", 15), BridgeCall.parse("lock.setRelockSeconds", "a", mapOf("seconds" to 15)))
        assertEquals(BridgeCall.SetRelock("a", 30), BridgeCall.parse("lock.setRelockSeconds", "a", mapOf("seconds" to 30.0)))
        assertNull(BridgeCall.parse("lock.setRelockSeconds", "a", mapOf("seconds" to 120)))
        assertNull(BridgeCall.parse("lock.setRelockSeconds", "a", mapOf("seconds" to 15, "off" to true)))
        assertEquals(BridgeCall.ConfirmSensitive("b", "Open terminal"), BridgeCall.parse("auth.confirm", "b", mapOf("reason" to " Open terminal ")))
        assertNull(BridgeCall.parse("auth.confirm", "b", mapOf("reason" to "x".repeat(121))))
        assertNull(BridgeCall.parse("auth.confirm", "b", mapOf("reason" to "a\nb")))
        assertTrue(BridgeCall.parse("pair.remove", "c", emptyMap()) is BridgeCall.RemovePairing)
        assertNull(BridgeCall.parse("lock.disable", "c", emptyMap()))
        assertNull(BridgeCall.parse("lock.state", "bad id!", emptyMap()))
        assertNull(BridgeCall.parse("lock.state", null, emptyMap()))
        assertNull(BridgeCall.parse("lock.state", "1", mapOf("x" to 1)))
    }
}
