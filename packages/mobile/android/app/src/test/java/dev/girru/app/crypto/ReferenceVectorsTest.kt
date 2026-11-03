package dev.girru.app.crypto

import dev.girru.app.crypto.ReferenceVectors as V
import dev.girru.app.link.PhoneCommands
import dev.girru.app.push.NoticeEnvelope
import dev.girru.app.push.PushNotice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Handshake, envelopes, notices and commands against the computer's reference TypeScript. */
class ReferenceVectorsTest {
    private val computerSpki = V.bytes(V.COMPUTER_SPKI)
    private val phoneSpki = V.bytes(V.PHONE_SPKI)

    private fun refused(reason: String, block: () -> Unit) {
        try {
            block()
            fail("expected $reason")
        } catch (e: G1Exception) {
            assertEquals(reason, e.reason)
        }
    }

    /** The phone's side of the reference handshake, rebuilt from its exported ephemeral key. */
    private fun pending() = PendingHandshake(V.PHONE_ID, V.COMPUTER_ID, V.keyPair(V.EPH_SPKI, V.EPH_PKCS8), V.HS1)

    @Test
    fun finishesTheReferenceHandshakeAndSpeaksTheSameEnvelopes() {
        val session = G1Handshake.finish(pending(), computerSpki, V.HS2, V.TS + 100)
        assertEquals(V.SESSION_ID, session.id)
        assertEquals(V.COMPUTER_MESSAGE, String(session.open(V.MSG_FROM_COMPUTER), Charsets.UTF_8))
        // Same key, same seq 1, same header text: the sealed bytes are identical.
        assertEquals(V.MSG_FROM_PHONE, session.seal(V.PHONE_MESSAGE.utf8))
    }

    @Test
    fun answersAReferenceHelloLikeTheComputerDoes() {
        // The phone's answering code accepts the reference hs1 (signature over the exact text sent).
        val (_, session) = G1Handshake.answer(V.COMPUTER_ID, V.signer(V.COMPUTER_PKCS8), phoneSpki, V.HS1, V.TS + 50)
        assertEquals(V.PHONE_ID, session.peerId)
    }

    @Test
    fun aHandshakeIsUsedOnceAndEveryHelloIsFresh() {
        val pending = pending()
        G1Handshake.finish(pending, computerSpki, V.HS2, V.TS + 100)
        assertTrue(pending.isUsed)
        refused("used") { G1Handshake.finish(pending, computerSpki, V.HS2, V.TS + 100) }

        val phone = V.signer(V.PHONE_PKCS8)
        val a = G1Handshake.start(V.PHONE_ID, phone, V.COMPUTER_ID, V.TS)
        val b = G1Handshake.start(V.PHONE_ID, phone, V.COMPUTER_ID, V.TS)
        assertNotEquals(a.hello, b.hello)
        val ha = G1Handshake.readJson(a.hello.split('.')[2])
        val hb = G1Handshake.readJson(b.hello.split('.')[2])
        assertNotEquals(ha["eph"], hb["eph"])
        assertNotEquals(ha["nonce"], hb["nonce"])
        assertFalse(a.isUsed)
    }

    @Test
    fun aForgedReplyDoesNotUseUpTheHandshake() {
        val pending = pending()
        refused("bad_signature") { G1Handshake.finish(pending, V.bytes(V.OTHER_SPKI), V.HS2, V.TS + 100) }
        assertFalse(pending.isUsed)
        G1Handshake.finish(pending, computerSpki, V.HS2, V.TS + 100)
    }

    @Test
    fun opensTheReferenceNotice() {
        val opened = NoticeEnvelope.open(V.NTF, computerSpki, V.COMPUTER_ID, V.PHONE_ID, V.bytes(V.NOTIFY_KEY), V.TS)
        assertEquals(7L, opened.counter)
        assertEquals(PushNotice.Kind.APPROVAL, opened.notice.kind)
        assertEquals("Run a command", opened.notice.title)
        assertEquals("ls -la", opened.notice.body)
        assertEquals(V.APPROVAL_ID, opened.notice.approvalId)
    }

    @Test
    fun approvalDecideBodyAndSignedTextMatchTheReference() {
        assertEquals(V.DECIDE_BODY, PhoneCommands.approvalDecide(V.APPROVAL_ID, true, "a".repeat(64)))
        val text = SignedCommand.signedText(V.PHONE_ID, V.COMPUTER_ID, V.CMD_CTR, V.TS, V.CMD_NONCE, V.DECIDE_BODY)
        assertTrue(G1.verify(phoneSpki, text, V.bytes(V.CMD_SIG)))
    }
}
