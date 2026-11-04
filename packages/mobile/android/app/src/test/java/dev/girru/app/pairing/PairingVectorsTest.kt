package dev.girru.app.pairing

import dev.girru.app.crypto.G1
import dev.girru.app.crypto.G1Exception
import dev.girru.app.crypto.KeyAgreer
import dev.girru.app.crypto.ReferenceVectors as V
import dev.girru.app.crypto.hex
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.GeneralSecurityException

/** The phone's pairing code against bytes made by the computer's reference TypeScript. */
class PairingVectorsTest {
    private val computerSpki = V.bytes(V.COMPUTER_SPKI)
    private val phoneSpki = V.bytes(V.PHONE_SPKI)
    private val secret = V.bytes(V.SECRET)
    private val key = PairingMessages.pairingKey(secret, V.PAIRING_ID)
    private val phoneAgreer = V.agreer(V.PHONE_PKCS8)

    private fun refused(reason: String, block: () -> Unit) {
        try {
            block()
            fail("expected $reason")
        } catch (e: G1Exception) {
            assertEquals(reason, e.reason)
        }
    }

    private fun tamperSig(env: String): String {
        val parts = env.split('.')
        return listOf(parts[0], parts[1], parts[2], V.bytes(parts[3]).also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() }.let(G1::b64url)).joinToString(".")
    }

    @Test
    fun idsAndPairingKeyMatchTheReference() {
        assertEquals(V.COMPUTER_ID, G1.deviceIdOf(computerSpki))
        assertEquals(V.PHONE_ID, G1.deviceIdOf(phoneSpki))
        assertArrayEquals(hex(V.PAIRING_KEY_HEX), key)
    }

    @Test
    fun challengeOpensToTheReferenceBytes() {
        val challenge = PairingMessages.openChallenge(V.PCHAL, computerSpki, V.COMPUTER_ID, V.PHONE_ID, V.PAIRING_ID, key)
        assertArrayEquals(V.bytes(V.CHALLENGE), challenge)
    }

    @Test
    fun challengeIsRefusedWhenAnythingIsWrong() {
        // Addressed to another phone's id: the real phone refuses it and shows no code.
        refused("wrong_key") {
            PairingMessages.openChallenge(V.PCHAL_FOR_OTHER_PHONE, computerSpki, V.COMPUTER_ID, V.PHONE_ID, V.PAIRING_ID, key)
        }
        refused("bad_signature") {
            PairingMessages.openChallenge(V.PCHAL, V.bytes(V.OTHER_SPKI), V.COMPUTER_ID, V.PHONE_ID, V.PAIRING_ID, key)
        }
        refused("bad_signature") {
            PairingMessages.openChallenge(tamperSig(V.PCHAL), computerSpki, V.COMPUTER_ID, V.PHONE_ID, V.PAIRING_ID, key)
        }
        val otherPid = "p_" + G1.b64url(ByteArray(32) { 1 })
        refused("bad_tag") {
            PairingMessages.openChallenge(V.PCHAL, computerSpki, V.COMPUTER_ID, V.PHONE_ID, otherPid, key)
        }
        refused("bad_format") {
            PairingMessages.openChallenge(V.PWEL, computerSpki, V.COMPUTER_ID, V.PHONE_ID, V.PAIRING_ID, key)
        }
    }

    @Test
    fun checkCodeMatchesTheReference() {
        val challenge = V.bytes(V.CHALLENGE)
        assertArrayEquals(
            hex(V.CHECK_DIGEST_HEX),
            G1.sha256("girru/v1/check\n".toByteArray(), secret, computerSpki, phoneSpki, challenge),
        )
        assertEquals(V.CHECK_CODE, PairingMessages.checkCode(secret, computerSpki, phoneSpki, challenge))
        refused("bad_format") { PairingMessages.checkCode(secret, computerSpki, phoneSpki, ByteArray(31)) }
    }

    @Test
    fun notificationKeyWrapMatchesTheReference() {
        val shared = phoneAgreer.agree(computerSpki)
        assertArrayEquals(hex(V.NKEY_SHARED_HEX), shared)
        assertArrayEquals(hex(V.NKEY_WRAP_HEX), PairingMessages.notifyWrapKey(shared, key))
    }

    @Test
    fun welcomeOpensAndUnwrapsTheNotificationKey() {
        val w = PairingMessages.openWelcome(V.PWEL, computerSpki, V.COMPUTER_ID, V.PHONE_ID, V.PAIRING_ID, key, phoneAgreer)
        assertArrayEquals(V.bytes(V.NOTIFY_KEY), w.notifyKey)
        assertEquals(PairingLifetime.DAYS_60, w.lifetime)
        assertEquals("Desk", w.computerName)
        val never = PairingMessages.openWelcome(V.PWEL_NEVER, computerSpki, V.COMPUTER_ID, V.PHONE_ID, V.PAIRING_ID, key, phoneAgreer)
        assertEquals(PairingLifetime.NEVER, never.lifetime)
        assertNull(never.computerName)
    }

    @Test
    fun theQrCodeAloneCannotOpenTheNotificationKey() {
        // Someone with the pairing key (a photo of the QR code) but another identity key.
        refused("bad_tag") {
            PairingMessages.openWelcome(V.PWEL, computerSpki, V.COMPUTER_ID, V.PHONE_ID, V.PAIRING_ID, key, V.agreer(V.OTHER_PKCS8))
        }
        refused("wrong_key") {
            PairingMessages.openWelcome(V.PWEL, computerSpki, V.COMPUTER_ID, V.OTHER_ID, V.PAIRING_ID, key, phoneAgreer)
        }
        refused("bad_signature") {
            PairingMessages.openWelcome(tamperSig(V.PWEL), computerSpki, V.COMPUTER_ID, V.PHONE_ID, V.PAIRING_ID, key, phoneAgreer)
        }
    }

    @Test
    fun keyNeedingAnUnlockIsReportedOnlyAfterEveryOtherCheck() {
        val locked = KeyAgreer { throw GeneralSecurityException("user not authenticated") }
        try {
            PairingMessages.openWelcome(V.PWEL, computerSpki, V.COMPUTER_ID, V.PHONE_ID, V.PAIRING_ID, key, locked)
            fail("expected the key to refuse")
        } catch (e: GeneralSecurityException) {
            // expected: the welcome itself checked out
        }
        // A forged welcome is refused before the key is ever asked.
        refused("bad_signature") {
            PairingMessages.openWelcome(tamperSig(V.PWEL), computerSpki, V.COMPUTER_ID, V.PHONE_ID, V.PAIRING_ID, key, locked)
        }
    }

    private fun payload() = PairingPayload(
        computerId = V.COMPUTER_ID,
        computerKey = computerSpki,
        pairingId = V.PAIRING_ID,
        secret = secret,
        relayUrl = "wss://relay.example.net/v1",
        localAddresses = emptyList(),
        expiresAtSec = V.TS / 1000 + 120,
        computerName = "Desk",
    )

    @Test
    fun fullPairingFlowNoCodeBeforeTheChallenge() {
        val waiting = PairedComputer.waiting(payload(), PairingLifetime.DAYS_90, V.TS)
        assertNull(waiting.checkCode(phoneSpki))
        refused("no_challenge") { waiting.withWelcome(V.PWEL, V.PHONE_ID, phoneAgreer, V.TS) }
        refused("wrong_key") { waiting.withChallenge(V.PCHAL_FOR_OTHER_PHONE, phoneSpki) }

        val challenged = waiting.withChallenge(V.PCHAL, phoneSpki)
        assertEquals(V.CHECK_CODE, challenged.checkCode(phoneSpki))
        // The same challenge again changes nothing.
        assertSame(challenged, challenged.withChallenge(V.PCHAL, phoneSpki))
        // It survives the encrypted store.
        val stored = PairedComputer.fromFields(StoreCodec.decode(StoreCodec.encode(challenged.toFields()))!!)!!
        assertEquals(V.CHECK_CODE, stored.checkCode(phoneSpki))

        val paired = stored.withWelcome(V.PWEL, V.PHONE_ID, phoneAgreer, V.TS + 60_000)
        assertEquals(PairedComputer.State.PAIRED, paired.state)
        assertEquals(PairingLifetime.DAYS_60, paired.lifetime)
        assertArrayEquals(V.bytes(V.NOTIFY_KEY), paired.notificationKey)
        assertNull(paired.pending)
        assertTrue(paired.toFields().keys.none { it in setOf("ps", "pid", "ch", "wel") })
    }

    @Test
    fun heldWelcomeWaitsForTheUnlock() {
        val challenged = PairedComputer.waiting(payload(), PairingLifetime.DAYS_90, V.TS).withChallenge(V.PCHAL, phoneSpki)
        val held = challenged.holdingWelcome(V.PWEL)
        val stored = PairedComputer.fromFields(StoreCodec.decode(StoreCodec.encode(held.toFields()))!!)!!
        assertNotNull(stored.pending?.welcome)
        val paired = stored.withWelcome(stored.pending!!.welcome!!, V.PHONE_ID, phoneAgreer, V.TS)
        assertArrayEquals(V.bytes(V.NOTIFY_KEY), paired.notificationKey)
    }

    @Test
    fun theWaitCountsFromTheSendNotFromTheRenewingCode() {
        // The code on screen renews every 2 minutes; a request already sent keeps going for up to 10.
        val waiting = PairedComputer.waiting(payload(), PairingLifetime.DAYS_90, V.TS)
        assertTrue(!waiting.isRequestStale(V.TS + 5 * 60_000))
        assertTrue(waiting.isRequestStale(V.TS + 12 * 60_000))
    }
}
