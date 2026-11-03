package dev.girru.app.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class G1Test {
    @Test
    fun hkdfMatchesRfc5869TestCase1() {
        val okm = G1.hkdf(
            ikm = hex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"),
            salt = hex("000102030405060708090a0b0c"),
            info = hex("f0f1f2f3f4f5f6f7f8f9"),
            length = 42,
        )
        assertArrayEquals(
            hex("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"),
            okm,
        )
    }

    @Test
    fun base64urlIsStrict() {
        val bytes = byteArrayOf(-1, 0, 1, 2)
        val text = G1.b64url(bytes)
        assertArrayEquals(bytes, G1.fromB64url(text))
        assertNull(G1.fromB64url("$text="))
        assertNull(G1.fromB64url("ab+/"))
        // Non-canonical trailing bits are refused, like the relay's decoder.
        assertNull(G1.fromB64url("AB"))
    }

    @Test
    fun aesGcmRoundTripAndTamper() {
        val key = G1.randomBytes(32)
        val nonce = G1.randomBytes(12)
        val box = G1.aesGcmSeal(key, nonce, "aad".utf8, "hello".utf8)
        assertEquals("hello", String(G1.aesGcmOpen(key, nonce, "aad".utf8, box)!!))
        assertNull(G1.aesGcmOpen(key, nonce, "other".utf8, box))
        box[0] = (box[0].toInt() xor 1).toByte()
        assertNull(G1.aesGcmOpen(key, nonce, "aad".utf8, box))
    }

    @Test
    fun deviceIdIsHashOfSpkiAndKeysAreChecked() {
        val identity = TestIdentity()
        assertEquals(43, identity.id.length)
        assertTrue(G1.isDeviceId(identity.id))
        assertNotNull(G1.p256PublicKey(identity.spki))
        assertNull(G1.p256PublicKey(byteArrayOf(1, 2, 3)))
    }

    @Test
    fun signAndVerify() {
        val identity = TestIdentity()
        val sig = identity.signer.sign("data".utf8)
        assertTrue(G1.verify(identity.spki, "data".utf8, sig))
        assertFalse(G1.verify(identity.spki, "other".utf8, sig))
        assertFalse(G1.verify(TestIdentity().spki, "data".utf8, sig))
        assertFalse(G1.verify(identity.spki, "data".utf8, byteArrayOf(0x30, 0x00)))
    }
}
