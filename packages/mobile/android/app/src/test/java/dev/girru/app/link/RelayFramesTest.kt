package dev.girru.app.link

import dev.girru.app.crypto.G1
import dev.girru.app.crypto.G1Exception
import dev.girru.app.crypto.TestIdentity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.KeyFactory
import java.security.SecureRandom
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

class RelayFramesTest {
    private val phone = TestIdentity()
    private val relay = "wss://relay.girru.net/v1"
    private val nonce = G1.b64url(ByteArray(32).also { SecureRandom().nextBytes(it) })
    private val challenge: Map<String, Any?> = mapOf("t" to "challenge", "v" to 1L, "relay" to relay, "nonce" to nonce)

    @Test
    fun helloSignsTheRelayNameAndTheNonce() {
        val hello = Json.readObject(RelayFrames.hello(challenge, relay, phone.spki, phone.signer, listOf("cid")))!!
        assertEquals("hello", hello["t"])
        assertEquals(1L, hello["v"])
        assertEquals(G1.b64url(phone.spki), hello["key"])
        assertEquals(listOf("cid"), hello["allow"])
        assertEquals(emptyList<String>(), hello["pairing"])
        val ok = Signature.getInstance("SHA256withECDSA").run {
            initVerify(KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(phone.spki)))
            update("girru/relay/v1/hello\n$relay\n$nonce".toByteArray())
            verify(G1.fromB64url(hello["sig"] as String))
        }
        assertTrue(ok)
    }

    @Test
    fun refusesAChallengeFromAnotherRelay() {
        refused("wrong_relay", challenge + ("relay" to "wss://evil.example/v1"))
    }

    @Test
    fun refusesABadChallenge() {
        refused("bad_format", challenge + ("nonce" to "abc"))
        refused("bad_format", challenge + ("v" to 2L))
        refused("bad_format", challenge + ("t" to "ready"))
    }

    @Test
    fun sendsTheRequestToThePairingId() {
        assertEquals("""{"t":"send","pairing":"p_x","env":"g1.preq.a.b"}""", RelayFrames.sendToPairing("p_x", "g1.preq.a.b"))
    }

    private fun refused(reason: String, frame: Map<String, Any?>) {
        try {
            RelayFrames.hello(frame, relay, phone.spki, phone.signer, emptyList())
            fail("accepted $frame")
        } catch (e: G1Exception) {
            assertEquals(reason, e.reason)
        }
    }
}
