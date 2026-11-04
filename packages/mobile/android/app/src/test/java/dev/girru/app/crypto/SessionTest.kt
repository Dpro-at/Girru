package dev.girru.app.crypto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SessionTest {
    private val phone = TestIdentity()
    private val computer = TestIdentity()
    private val now = 1_800_000_000_000L

    private fun pair(): Pair<G1Session, G1Session> {
        val pending = G1Handshake.start(phone.id, phone.signer, computer.id, now)
        val (hs2, computerSession) = G1Handshake.answer(computer.id, computer.signer, phone.spki, pending.hello, now)
        val phoneSession = G1Handshake.finish(pending, computer.spki, hs2, now)
        return phoneSession to computerSession
    }

    private fun refused(reason: String, block: () -> Unit) {
        try {
            block()
            fail("expected $reason")
        } catch (e: G1Exception) {
            assertEquals(reason, e.reason)
        }
    }

    @Test
    fun handshakeGivesMatchingSessions() {
        val (p, c) = pair()
        assertEquals(p.id, c.id)
        assertEquals("hi computer", String(c.open(p.seal("hi computer".utf8))))
        assertEquals("hi phone", String(p.open(c.seal("hi phone".utf8))))
        assertTrue(p.seal("x".utf8).startsWith("g1.msg."))
    }

    @Test
    fun replayAndTamperAreRefused() {
        val (p, c) = pair()
        val first = p.seal("one".utf8)
        val second = p.seal("two".utf8)
        c.open(second)
        refused("replay") { c.open(first) }
        refused("replay") { c.open(second) }
        val third = p.seal("three".utf8)
        val parts = third.split('.')
        val body = G1.fromB64url(parts[3])!!
        body[0] = (body[0].toInt() xor 1).toByte()
        refused("bad_tag") { c.open("g1.msg.${parts[2]}.${G1.b64url(body)}") }
        // The counter did not move on the broken one.
        assertEquals("three", String(c.open(third)))
    }

    @Test
    fun handshakeRefusesWrongKeyStaleAndForged() {
        val pending = G1Handshake.start(phone.id, phone.signer, computer.id, now)
        val stranger = TestIdentity()
        refused("bad_signature") { G1Handshake.answer(computer.id, computer.signer, stranger.spki, pending.hello, now) }
        refused("stale") { G1Handshake.answer(computer.id, computer.signer, phone.spki, pending.hello, now + 3 * 60_000) }
        val (hs2, _) = G1Handshake.answer(computer.id, computer.signer, phone.spki, pending.hello, now)
        refused("bad_signature") { G1Handshake.finish(pending, stranger.spki, hs2, now) }
        refused("bad_format") { G1Handshake.finish(pending, computer.spki, "g1.hs2.x", now) }
    }

    @Test
    fun signedCommandVerifiesWithPhoneKey() {
        val command = SignedCommand.create(phone.id, computer.id, 5, "{\"type\":\"x\"}", now, phone.signer)
        val text = SignedCommand.signedText(command.device, command.to, command.ctr, command.ts, command.nonce, command.body)
        assertTrue(G1.verify(phone.spki, text, G1.fromB64url(command.sig)!!))
        assertEquals(22, command.nonce.length)
        val json = FlatJson.read(command.toJson())!!
        assertEquals(5L, json["ctr"])
        assertEquals(computer.id, json["to"])
    }

    @Test
    fun outgoingCounterSavesBeforeUse() {
        var saved = 0L
        val counter = OutgoingCounter(object : CounterStore {
            override fun load() = saved
            override fun save(value: Long) {
                saved = value
            }
        })
        assertEquals(1L, counter.next())
        assertEquals(2L, counter.next())
        assertEquals(2L, saved)
    }
}
