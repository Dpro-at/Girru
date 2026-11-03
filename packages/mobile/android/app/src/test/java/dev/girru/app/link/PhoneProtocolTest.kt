package dev.girru.app.link

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PhoneProtocolTest {
    private val id = "0b6c4c1e-3a7e-4c1b-9d0e-2f1a3b4c5d6e"
    private val hash = "b".repeat(64)
    private val runId = "phone-3f2a9c1e-0000-4000-8000-000000000001"

    @Test
    fun bodiesHaveSortedKeysAndLeaveOutEmptyFields() {
        assertEquals("""{"type":"chat.list"}""", PhoneCommands.chatList())
        assertEquals("""{"id":"c1","type":"chat.messages"}""", PhoneCommands.chatMessages("c1"))
        assertEquals("""{"before":"m9","id":"c1","type":"chat.messages"}""", PhoneCommands.chatMessages("c1", "m9"))
        assertEquals("""{"id":"$id","type":"approval.detail"}""", PhoneCommands.approvalDetail(id))
        assertEquals("""{"approve":false,"id":"$id","type":"approval.decide"}""", PhoneCommands.approvalDecide(id, false, null))
        assertEquals("""{"id":"$id","type":"approval.pending"}""", PhoneCommands.approvalPendingQuery(id))
        assertEquals("""{"type":"approval.pending"}""", PhoneCommands.approvalList())
    }

    @Test
    fun approveAlwaysCarriesTheHash() {
        try {
            PhoneCommands.approvalDecide(id, true, null)
            fail("approve without a hash")
        } catch (e: IllegalArgumentException) {
            // expected
        }
        try {
            PhoneCommands.approvalDetail("ap_1")
            fail("not an approval id the computer accepts")
        } catch (e: IllegalArgumentException) {
            // expected
        }
    }

    @Test
    fun readsTheComputersFrames() {
        val ok = PhoneFrame.parse("""{"type":"reply","ref":"n1","ok":true,"data":{"a":[1,2.5,{"b":null}]}}""") as PhoneFrame.Reply
        assertTrue(ok.ok)
        assertEquals("n1", ok.ref)
        assertEquals(listOf(1L, 2.5, mapOf("b" to null)), (ok.data as Map<*, *>)["a"])

        val bad = PhoneFrame.parse("""{"type":"reply","ref":"n1","ok":false,"error":"internal_error"}""") as PhoneFrame.Reply
        assertEquals("internal_error", bad.error)
        assertEquals(ReplyOutcome.TRY_AGAIN, (CommandReply.of(bad) as CommandReply.Failed).outcome)
        // An unexpected error text never reaches a screen as it is.
        val odd = PhoneFrame.parse("""{"type":"reply","ref":null,"ok":false,"error":"Error: at /x"}""") as PhoneFrame.Reply
        assertEquals("internal_error", odd.error)

        val end = PhoneFrame.parse("""{"type":"run.end","ref":"n2","runId":"$runId","status":"dropped","code":"slow_link"}""") as PhoneFrame.RunEnd
        assertTrue(end.droppedForSlowLink)

        val pending = PhoneFrame.parse("""{"type":"approval.pending","id":"$id","pending":true}""") as PhoneFrame.PendingAnswer
        assertTrue(pending.pending)

        assertNull(PhoneFrame.parse("""{"type":"reply"}"""))
        assertNull(PhoneFrame.parse("""{"type":"reply","ok":true,"ok":false}"""))
        assertNull(PhoneFrame.parse("not json"))
    }

    @Test
    fun outcomesSendTheOwnerToTheComputerWhenThePhoneCannotShowEverything() {
        for (code in listOf("full_view_required", "full_view_unavailable", "too_large", "verification_required")) {
            assertEquals(code, ReplyOutcome.DECIDE_ON_COMPUTER, ReplyOutcome.of(code))
        }
        assertEquals(ReplyOutcome.NOT_PENDING, ReplyOutcome.of("not_pending"))
        assertEquals(ReplyOutcome.PAIRING_ENDED, ReplyOutcome.of("unknown_device"))
        assertEquals(ReplyOutcome.PAIRING_ENDED, ReplyOutcome.of("expired"))
        assertEquals(ReplyOutcome.TRY_AGAIN, ReplyOutcome.of("internal_error"))
        assertEquals(ReplyOutcome.REFUSED, ReplyOutcome.of("owner_changed"))
    }

    private fun run(seq: Long) =
        PhoneFrame.parse("""{"type":"run","ref":"n","runId":"$runId","seq":$seq,"frame":{"type":"delta","text":"hi"}}""")!!

    @Test
    fun runStreamShowsInOrderAndRereadsAfterASlowLink() {
        val stream = RunStream("conv-1", runId)
        assertTrue(stream.onFrame(run(1)) is RunStream.Step.Show)
        assertTrue(stream.onFrame(run(1)) is RunStream.Step.Ignore)
        assertTrue(stream.onFrame(run(3)) is RunStream.Step.Show)
        assertTrue(stream.onFrame(run(2)) is RunStream.Step.Ignore)
        val end = stream.onFrame(
            PhoneFrame.parse("""{"type":"run.end","ref":"n","runId":"$runId","status":"dropped","code":"slow_link"}""")!!,
        ) as RunStream.Step.Ended
        assertEquals("""{"id":"conv-1","type":"chat.messages"}""", end.reread)
        assertNull(end.problem)
        assertTrue(stream.ended)
        assertTrue(stream.onFrame(run(4)) is RunStream.Step.Ignore)
    }

    @Test
    fun runStreamEndings() {
        fun end(json: String) = RunStream("conv-1", runId).onFrame(PhoneFrame.parse(json)!!)
        val complete = end("""{"type":"run.end","runId":"$runId","status":"complete"}""") as RunStream.Step.Ended
        assertNull(complete.reread)
        val failed = end("""{"type":"run.end","runId":"$runId","status":"error","code":"internal_error"}""") as RunStream.Step.Ended
        assertEquals(ReplyOutcome.TRY_AGAIN, failed.problem)
        assertTrue(failed.reread != null)
        val unknown = end("""{"type":"run.end","runId":"$runId","status":"unknown"}""") as RunStream.Step.Ended
        assertTrue(unknown.reread != null)
        val tooLarge = end("""{"type":"run","ref":"n","ok":false,"error":"too_large","runId":"$runId"}""") as RunStream.Step.Ended
        assertTrue(tooLarge.reread != null)
        assertTrue(end("""{"type":"run.end","runId":"other-run-id","status":"complete"}""") is RunStream.Step.Ignore)
    }

    private fun list(vararg entries: String) = CommandReply.Ok(Json.parse("""{"approvals":[${entries.joinToString(",")}]}"""))

    private fun entry(truncated: Boolean, fullView: Boolean, preview: String = """{"path":"/tmp/a"}""") =
        """{"id":"$id","toolName":"write_file","category":"files","paramsPreview":$preview,"truncated":$truncated,"fullViewRequired":$fullView,"paramsHash":"$hash"}"""

    @Test
    fun aShortPreviewIsShownWithItsHash() {
        val step = ApprovalReview.afterList(list(entry(truncated = false, fullView = false)), id) as ApprovalReview.Step.Show
        assertEquals(hash, step.paramsHash)
        assertTrue(step.text.contains("/tmp/a"))
    }

    @Test
    fun aCutShortPreviewNeedsTheFullViewFirst() {
        assertTrue(ApprovalReview.afterList(list(entry(truncated = true, fullView = true)), id) is ApprovalReview.Step.FetchFullView)
        // Even when the flags are missing, a nested value shown as [object] needs the full view.
        val nested = entry(truncated = false, fullView = false, preview = """{"opts":"[object]"}""")
        val fetch = ApprovalReview.afterList(list(nested), id) as ApprovalReview.Step.FetchFullView
        assertEquals("""{"id":"$id","type":"approval.detail"}""", fetch.body)

        val fullHash = "c".repeat(64)
        val detail = CommandReply.Ok(
            Json.parse(
                """{"id":"$id","toolName":"write_file","category":"files","agentId":"a1","sessionId":"s1",""" +
                    """"params":{"path":"/tmp/a","opts":{"mode":"0644","token":"***"}},"maskedFields":["opts.token"],""" +
                    """"runScope":null,"requestedAt":1,"paramsHash":"$fullHash"}""",
            ),
        )
        val show = ApprovalReview.afterDetail(detail, id) as ApprovalReview.Step.Show
        // Approve signs the hash of the full view, not of the preview.
        assertEquals(fullHash, show.paramsHash)
        assertTrue(show.text.contains("\"mode\": \"0644\""))
        assertEquals(listOf("opts.token"), show.masked)
    }

    @Test
    fun fullViewRefusalsSendTheOwnerToTheComputer() {
        for (code in listOf("full_view_required", "full_view_unavailable", "too_large", "verification_required")) {
            val step = ApprovalReview.afterDetail(CommandReply.Failed(code), id)
            assertTrue(code, step is ApprovalReview.Step.DecideOnComputer)
            assertTrue(code, ApprovalReview.decided(CommandReply.Failed(code)) is ApprovalReview.Step.DecideOnComputer)
        }
        // A detail for another approval, or without a hash, is never shown.
        val wrong = CommandReply.Ok(Json.parse("""{"id":"other","toolName":"x","params":{},"paramsHash":"$hash"}"""))
        assertTrue(ApprovalReview.afterDetail(wrong, id) is ApprovalReview.Step.DecideOnComputer)
        assertTrue(ApprovalReview.afterList(list(), id) is ApprovalReview.Step.NotPending)
        assertTrue(ApprovalReview.afterList(CommandReply.NotDelivered, id) is ApprovalReview.Step.Failed)
        assertNull(ApprovalReview.decided(CommandReply.Ok(null)))
        assertTrue(ApprovalReview.decided(CommandReply.Failed("not_pending")) is ApprovalReview.Step.NotPending)
    }

    @Test
    fun jsonReadsNestedValuesAndRefusesBadText() {
        assertEquals(mapOf("a" to listOf(true, false, null), "b" to "é\n"), Json.parse("""{"a":[true,false,null],"b":"é\n"}"""))
        assertEquals(-12L, Json.parse("-12"))
        assertEquals(1.5e3, Json.parse("1.5e3"))
        assertNull(Json.readObject("""{"a":1,"a":2}"""))
        assertNull(Json.readObject("""{"a":01}"""))
        assertNull(Json.readObject("""{"a":1} x"""))
        assertNull(Json.parse("[".repeat(100) + "]".repeat(100)))
        assertFalse(Json.compact(mapOf("x" to "a\"b")).contains("a\"b"))
        assertEquals("{\n  \"a\": [\n    1\n  ]\n}", Json.pretty(mapOf("a" to listOf(1L))))
    }
}
