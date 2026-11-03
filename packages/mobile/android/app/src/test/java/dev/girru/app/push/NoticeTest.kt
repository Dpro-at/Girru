package dev.girru.app.push

import dev.girru.app.crypto.FlatJson
import dev.girru.app.crypto.G1
import dev.girru.app.crypto.G1Exception
import dev.girru.app.crypto.TestIdentity
import dev.girru.app.crypto.utf8
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class NoticeTest {
    private val computer = TestIdentity()
    private val phone = TestIdentity()
    private val notifyKey = G1.randomBytes(32)
    private val now = 1_800_000_000_000L

    private fun seal(
        content: String,
        ctr: Long = 1,
        ts: Long = now,
        to: String = phone.id,
        signer: TestIdentity = computer,
    ): String {
        val nonce = G1.randomBytes(12)
        val box = G1.aesGcmSeal(notifyKey, nonce, NoticeEnvelope.aad(computer.id, to, ctr), content.utf8)
        val payload = G1.b64url(
            FlatJson.write("from" to computer.id, "to" to to, "ctr" to ctr, "ts" to ts, "box" to G1.b64url(nonce + box)).utf8,
        )
        return "g1.ntf.$payload.${G1.b64url(signer.signer.sign("girru/v1/ntf\n$payload".utf8))}"
    }

    private fun open(env: String) = NoticeEnvelope.open(env, computer.spki, computer.id, phone.id, notifyKey, now)

    private fun refused(reason: String, env: String) {
        try {
            open(env)
            fail("expected $reason")
        } catch (e: G1Exception) {
            assertEquals(reason, e.reason)
        }
    }

    private val approval = """{"kind":"approval.sensitive","title":"Sara wants to send an email","body":"Weekly report\nto the sales team","approvalId":"ap_1"}"""

    @Test
    fun opensAValidNotice() {
        val opened = open(seal(approval, ctr = 7))
        assertEquals(7L, opened.counter)
        assertEquals(PushNotice.Kind.APPROVAL_SENSITIVE, opened.notice.kind)
        assertEquals("ap_1", opened.notice.approvalId)
        assertTrue(opened.notice.body.contains('\n'))
    }

    @Test
    fun refusesForgedMisaddressedStaleOrBadContent() {
        refused("bad_signature", seal(approval, signer = TestIdentity()))
        refused("wrong_target", seal(approval, to = TestIdentity().id))
        refused("stale", seal(approval, ts = now - 61 * 60_000))
        refused("bad_content", seal("""{"kind":"approval","title":"x"}"""))
        refused("bad_content", seal("""{"kind":"unknown","title":"x"}"""))
        refused("bad_content", seal("""{"kind":"summary","title":"x","body":"a\u0007b"}"""))
        refused("bad_format", "g1.ntf.only")
    }

    @Test
    fun contentRules() {
        assertNull(PushNotice.from(mapOf("kind" to "summary", "title" to "x".repeat(121))))
        assertNull(PushNotice.from(mapOf("kind" to "summary", "title" to "ok", "body" to "x".repeat(601))))
        assertNull(PushNotice.from(mapOf("kind" to "approval", "title" to "ok", "approvalId" to "bad id")))
        val n = PushNotice.from(mapOf("kind" to "summary", "title" to "3 tasks finished", "group" to "tasks"))!!
        assertEquals("tasks", n.group)
        assertEquals("", n.body)
    }

    @Test
    fun verifiedApprovalsKeepOnlyApprovalsAndTheNewest() {
        val entries = VerifiedApprovals.decode(null)
        for (i in 1..(VerifiedApprovals.MAX + 5)) VerifiedApprovals.add(entries, "a$i", PushNotice.Kind.APPROVAL)
        assertEquals(VerifiedApprovals.MAX, entries.size)
        assertNull(entries["a1"])
        val back = VerifiedApprovals.decode(VerifiedApprovals.encode(entries) + "\nx summary\nbad")
        assertEquals(VerifiedApprovals.MAX, back.size)
        assertEquals(PushNotice.Kind.APPROVAL, back["a${VerifiedApprovals.MAX + 5}"])
        try {
            VerifiedApprovals.add(entries, "s", PushNotice.Kind.SUMMARY)
            fail("only approvals")
        } catch (e: IllegalArgumentException) {
            // expected
        }
    }
}
