package dev.girru.app.pairing

import dev.girru.app.crypto.FlatJson
import dev.girru.app.crypto.G1
import dev.girru.app.crypto.G1Exception
import dev.girru.app.crypto.KeyAgreer
import dev.girru.app.crypto.TestIdentity
import dev.girru.app.crypto.utf8
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PairingMessagesTest {
    private val phone = TestIdentity()
    private val computer = TestIdentity()
    private val pid = "p_" + G1.b64url(ByteArray(32) { 3 })
    private val secret = ByteArray(32) { 5 }
    private val key = PairingMessages.pairingKey(secret, pid)

    @Test
    fun pairingKeyUsesThePairingIdTextAsSalt() {
        assertArrayEquals(G1.hkdf(secret, pid.utf8, "girru/v1/pair".utf8, 32), key)
        assertFalse(key.contentEquals(PairingMessages.pairingKey(secret, "p_" + G1.b64url(ByteArray(32) { 4 }))))
    }

    @Test
    fun checkCodeIsSixDigitsAndDependsOnBothKeysAndTheChallenge() {
        val challenge = ByteArray(32) { 11 }
        val code = PairingMessages.checkCode(secret, computer.spki, phone.spki, challenge)
        assertTrue(Regex("^[0-9]{6}$").matches(code))
        assertEquals(code, PairingMessages.checkCode(secret, computer.spki, phone.spki, challenge))
        assertNotEquals(code, PairingMessages.checkCode(secret, computer.spki, TestIdentity().spki, challenge))
        assertNotEquals(code, PairingMessages.checkCode(secret, computer.spki, phone.spki, ByteArray(32) { 12 }))
    }

    @Test
    fun requestOpensWithThePairingKeyAndCarriesAPhoneSignature() {
        val env = PairingMessages.buildRequest(pid, key, phone.spki, phone.signer, "Pixel", null, 60)
        val parts = env.split('.')
        assertEquals(listOf("g1", "preq"), parts.take(2))
        val nonce = parts[2]
        val plain = G1.aesGcmOpen(key, G1.fromB64url(nonce)!!, "girru/v1/preq\n$pid".utf8, G1.fromB64url(parts[3])!!)!!
        val req = FlatJson.read(String(plain))!!
        assertEquals(G1.b64url(phone.spki), req["key"])
        assertEquals("android", req["platform"])
        assertEquals(60L, req["lifetimeDays"])
        assertFalse(req.containsKey("push"))
        val sig = G1.fromB64url(req["sig"] as String)!!
        assertTrue(G1.verify(phone.spki, PairingMessages.requestSignedText(pid, phone.spki, nonce), sig))
        assertTrue(
            String(PairingMessages.requestSignedText(pid, phone.spki, nonce))
                .startsWith("girru/v1/preq-sig\n$pid\n${phone.id}\n"),
        )
    }

    private val phoneAgreer = KeyAgreer { peer -> G1.ecdh(phone.keyPair.private, peer)!! }

    /** The computer's side of the wrapped notification key (PROTOCOL.md "Wrapped notification key"). */
    private fun wrap(raw: ByteArray, phoneId: String = phone.id): String {
        val shared = G1.ecdh(computer.keyPair.private, phone.spki)!!
        val nonce = G1.randomBytes(12)
        val box = G1.aesGcmSeal(PairingMessages.notifyWrapKey(shared, key), nonce, PairingMessages.notifyKeyAad(computer.id, phoneId), raw)
        return G1.b64url(nonce + box)
    }

    private fun sealed(kind: String, fields: String, signer: TestIdentity = computer, aadPid: String = pid): String {
        val nonce = G1.randomBytes(12)
        val box = G1.aesGcmSeal(key, nonce, "girru/v1/$kind\n$aadPid".utf8, fields.utf8)
        val payload = G1.b64url(nonce + box)
        val sig = G1.b64url(signer.signer.sign("girru/v1/$kind\n$payload".utf8))
        return "g1.$kind.$payload.$sig"
    }

    private fun welcome(fields: String, signer: TestIdentity = computer, aadPid: String = pid) = sealed("pwel", fields, signer, aadPid)

    private fun open(env: String) = PairingMessages.openWelcome(env, computer.spki, computer.id, phone.id, pid, key, phoneAgreer)

    private fun refused(env: String) {
        try {
            open(env)
            fail("expected refusal")
        } catch (e: G1Exception) {
            // expected
        }
    }

    @Test
    fun welcomeGivesTheFinalLifetimeAndNotifyKey() {
        val raw = ByteArray(32) { 1 }
        val nk = wrap(raw)
        val w = open(welcome("""{"computer":"${computer.id}","phone":"${phone.id}","notifyKey":"$nk","lifetimeDays":120,"name":"Desk"}"""))
        assertEquals(PairingLifetime.DAYS_120, w.lifetime)
        assertArrayEquals(raw, w.notifyKey)
        assertEquals("Desk", w.computerName)
        val never = open(welcome("""{"computer":"${computer.id}","phone":"${phone.id}","notifyKey":"$nk","lifetimeDays":null}"""))
        assertEquals(PairingLifetime.NEVER, never.lifetime)
    }

    @Test
    fun welcomeIsRefusedWhenAnythingIsWrong() {
        val nk = wrap(ByteArray(32) { 1 })
        val good = """{"computer":"${computer.id}","phone":"${phone.id}","notifyKey":"$nk","lifetimeDays":90}"""
        refused(welcome(good, signer = TestIdentity()))
        refused(welcome(good, aadPid = "p_" + G1.b64url(ByteArray(32))))
        refused(welcome(good.replace(phone.id, TestIdentity().id)))
        refused(welcome(good.replace("\"lifetimeDays\":90", "\"lifetimeDays\":45")))
        // The old, unwrapped 32-byte key is no longer accepted.
        refused(welcome(good.replace(nk, G1.b64url(ByteArray(32)))))
        // Wrapped for another phone id: the AAD does not match.
        refused(welcome(good.replace(nk, wrap(ByteArray(32) { 1 }, phoneId = TestIdentity().id))))
        refused("g1.pwel.x")
    }

    @Test
    fun challengeIsCheckedBeforeAnyCode() {
        val c = G1.b64url(ByteArray(32) { 4 })
        val good = """{"computer":"${computer.id}","phone":"${phone.id}","challenge":"$c"}"""
        val challenge = PairingMessages.openChallenge(sealed("pchal", good), computer.spki, computer.id, phone.id, pid, key)
        assertArrayEquals(ByteArray(32) { 4 }, challenge)
        for (env in listOf(
            sealed("pchal", good, signer = TestIdentity()),
            sealed("pchal", good, aadPid = "p_" + G1.b64url(ByteArray(32))),
            sealed("pchal", good.replace(phone.id, TestIdentity().id)),
            sealed("pchal", good.replace(c, G1.b64url(ByteArray(16)))),
            sealed("pwel", good),
        )) {
            try {
                PairingMessages.openChallenge(env, computer.spki, computer.id, phone.id, pid, key)
                fail("expected refusal")
            } catch (e: G1Exception) {
                // expected
            }
        }
    }
}
