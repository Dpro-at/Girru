package dev.girru.app.link

import dev.girru.app.crypto.FlatJson

/**
 * What the phone says inside a session and how it reads the answers
 * (PROTOCOL.md "Inside a session: requests and answers"). Pure Kotlin.
 *
 * Every command body below is signed with [dev.girru.app.crypto.SignedCommand]
 * and sealed in a `g1.msg`; only [approvalPendingQuery] travels unsigned. No
 * body carries a `ref`, so the computer answers with the command's `nonce` as
 * `ref`, also for refusals made before the body was read; the connector
 * matches answers to commands by that nonce.
 */
object PhoneCommands {
    /** Approval ids as the computer accepts them (UUIDs). */
    val APPROVAL_ID = Regex("^[0-9a-fA-F-]{36}$")
    val PARAMS_HASH = Regex("^[0-9a-f]{64}$")
    val CONVERSATION_ID = Regex("^[A-Za-z0-9_.:-]{1,128}$")
    val MESSAGE_ID = Regex("^[A-Za-z0-9_.:-]{1,128}$")
    val RUN_ID = Regex("^[A-Za-z0-9_.:-]{8,128}$")
    private val AGENT_ID = Regex("^[A-Za-z0-9_.:-]{1,120}$")
    private val MODEL = Regex("^[A-Za-z0-9_.:/@+-]{1,160}$")
    const val MESSAGE_CHARS = 100_000

    fun chatList(): String = body("chat.list")

    fun chatMessages(conversationId: String, before: String? = null): String {
        require(CONVERSATION_ID.matches(conversationId)) { "bad conversation id" }
        require(before == null || MESSAGE_ID.matches(before)) { "bad message id" }
        return body("chat.messages", "id" to conversationId, "before" to before)
    }

    fun chatSend(conversationId: String?, message: String, agentId: String? = null, model: String? = null): String {
        require(message.isNotBlank() && message.length <= MESSAGE_CHARS) { "bad message" }
        require(conversationId == null || CONVERSATION_ID.matches(conversationId)) { "bad conversation id" }
        require(agentId == null || AGENT_ID.matches(agentId)) { "bad agent id" }
        require(model == null || MODEL.matches(model)) { "bad model" }
        return body("chat.send", "id" to conversationId, "message" to message, "agentId" to agentId, "model" to model)
    }

    fun chatStop(runId: String): String {
        require(RUN_ID.matches(runId)) { "bad run id" }
        return body("chat.stop", "runId" to runId)
    }

    /** The pending approvals; the computer marks each one as shown to this phone. */
    fun approvalList(): String = body("approval.pending")

    /** The full, masked parameters of one approval this phone was shown. */
    fun approvalDetail(id: String): String {
        require(APPROVAL_ID.matches(id)) { "bad approval id" }
        return body("approval.detail", "id" to id)
    }

    /**
     * `{"approve":…,"id":…,"paramsHash":…,"type":"approval.decide"}`, keys in
     * sorted order like the iPhone app. [paramsHash] is the hash of exactly
     * what the phone showed; it is required to approve.
     */
    fun approvalDecide(id: String, approve: Boolean, paramsHash: String?): String {
        require(APPROVAL_ID.matches(id)) { "bad approval id" }
        require(paramsHash == null || PARAMS_HASH.matches(paramsHash)) { "bad params hash" }
        require(!approve || paramsHash != null) { "approve needs the params hash" }
        return body("approval.decide", "approve" to approve, "id" to id, "paramsHash" to paramsHash)
    }

    /** The one unsigned query, sent as it is inside the session: a hint for the screen, not a permission. */
    fun approvalPendingQuery(id: String): String {
        require(APPROVAL_ID.matches(id)) { "bad approval id" }
        return FlatJson.write("id" to id, "type" to "approval.pending")
    }

    fun tasksList(place: String? = null): String {
        require(place == null || Regex("^[a-z_]{1,32}$").matches(place)) { "bad place" }
        return body("tasks.list", "place" to place)
    }

    fun schedulesList(): String = body("schedules.list")

    fun teamList(): String = body("team.list")

    /** One file of the computer's chat page (PROTOCOL.md "The computer's pages on the phone"). */
    fun uiGet(path: String, part: Int, ref: String): String =
        Json.compact(sortedMapOf<String, Any?>("type" to "ui.get", "path" to path, "ref" to ref).apply { if (part > 0) put("part", part.toLong()) })

    /** One request of the chat page; [jsonBody] is its parsed JSON, null for none. */
    fun apiCall(method: String, path: String, jsonBody: Any?, ref: String): String =
        Json.compact(sortedMapOf<String, Any?>("type" to "api.call", "method" to method, "path" to path, "ref" to ref).apply { if (jsonBody != null) put("body", jsonBody) })

    fun apiStream(path: String, ref: String): String =
        Json.compact(sortedMapOf<String, Any?>("type" to "api.stream", "path" to path, "ref" to ref))

    /** A body with its `type`; fields with a null value are left out; keys sorted. */
    private fun body(type: String, vararg fields: Pair<String, Any?>): String {
        val present = fields.mapNotNull { (k, v) -> v?.let { k to it } } + ("type" to type)
        return FlatJson.write(*present.sortedBy { it.first }.toTypedArray())
    }
}

/** One message from the computer inside the session. */
sealed class PhoneFrame {
    /** `{type:"reply", ref, ok:true, data}` or `{type:"reply", ref, ok:false, error}`. */
    class Reply(val ref: String?, val ok: Boolean, val data: Any?, val error: String?) : PhoneFrame()

    /** `{type:"run", ref, runId, seq, frame}`: one event of a started chat turn. */
    class Run(val ref: String?, val runId: String, val seq: Long, val frame: Map<String, Any?>) : PhoneFrame()

    /** `{type:"run", ref, ok:false, error, runId?}`: a run frame the computer could not send (too large). */
    class RunFailed(val ref: String?, val runId: String?, val error: String) : PhoneFrame()

    /** `{type:"run.end", ref, runId, status, code?}`. */
    class RunEnd(val ref: String?, val runId: String, val status: String, val code: String?) : PhoneFrame() {
        /** The computer stopped streaming because the link was backed up; read the rest with chat.messages. */
        val droppedForSlowLink: Boolean get() = status == "dropped" && code == "slow_link"
    }

    /** `{type:"approval.pending", id, pending}`: the answer to the unsigned query. */
    class PendingAnswer(val id: String, val pending: Boolean) : PhoneFrame()

    /** `{type:"stream", ref, data}`: one event of an `api.stream`, as the chat page reads it. */
    class Stream(val ref: String?, val data: Map<String, Any?>, val event: String? = null) : PhoneFrame()

    /** `{type:"stream.end", ref, status}`: `complete`, or `dropped` (the page re-attaches with `after`). */
    class StreamEnd(val ref: String?, val complete: Boolean) : PhoneFrame()

    companion object {
        private val CODE = Regex("^[a-z][a-z0-9_]{0,63}$")
        private val REF = Regex("^[A-Za-z0-9_-]{1,64}$")
        private val FRAME_RUN_ID = Regex("^[A-Za-z0-9_.:-]{1,128}$")

        /** Null for anything that is not one of the frames above. */
        fun parse(text: String): PhoneFrame? {
            val m = Json.readObject(text) ?: return null
            val ref = (m["ref"] as? String)?.takeIf { REF.matches(it) }
            return when (m["type"]) {
                "reply" -> when (m["ok"]) {
                    true -> Reply(ref, true, m["data"], null)
                    false -> Reply(ref, false, null, code(m["error"]))
                    else -> null
                }
                "run" -> {
                    val runId = (m["runId"] as? String)?.takeIf { FRAME_RUN_ID.matches(it) }
                    if (m["ok"] == false) {
                        RunFailed(ref, runId, code(m["error"]))
                    } else {
                        val seq = m["seq"] as? Long ?: return null
                        @Suppress("UNCHECKED_CAST")
                        val frame = m["frame"] as? Map<String, Any?> ?: return null
                        if (runId == null || seq < 1) null else Run(ref, runId, seq, frame)
                    }
                }
                "run.end" -> {
                    val runId = (m["runId"] as? String)?.takeIf { FRAME_RUN_ID.matches(it) } ?: return null
                    val status = (m["status"] as? String)?.takeIf { CODE.matches(it) } ?: return null
                    RunEnd(ref, runId, status, (m["code"] as? String)?.takeIf { CODE.matches(it) })
                }
                "stream" -> {
                    @Suppress("UNCHECKED_CAST")
                    val data = m["data"] as? Map<String, Any?> ?: return null
                    Stream(ref, data, (m["event"] as? String)?.takeIf { CODE.matches(it) })
                }
                "stream.end" -> StreamEnd(ref, (m["status"] as? String ?: return null) == "complete")
                "approval.pending" -> {
                    val id = (m["id"] as? String)?.takeIf { PhoneCommands.APPROVAL_ID.matches(it) } ?: return null
                    val pending = m["pending"] as? Boolean ?: return null
                    PendingAnswer(id, pending)
                }
                else -> null
            }
        }

        /** A reply's error code; anything unexpected reads as internal_error. */
        private fun code(value: Any?): String = (value as? String)?.takeIf { CODE.matches(it) } ?: "internal_error"
    }
}

/** The answer to one signed command, as the screens see it. */
sealed class CommandReply {
    class Ok(val data: Any?) : CommandReply()
    class Failed(val code: String) : CommandReply() {
        val outcome: ReplyOutcome get() = ReplyOutcome.of(code)
    }

    /** Not delivered (no session, no route, or no answer in time). */
    object NotDelivered : CommandReply()

    companion object {
        fun of(reply: PhoneFrame.Reply): CommandReply =
            if (reply.ok) Ok(reply.data) else Failed(reply.error ?: "internal_error")
    }
}

/** What a refusal means for the owner. */
enum class ReplyOutcome {
    /** Decide this on the computer: a full view is needed but cannot be shown here, or a second factor is asked. */
    DECIDE_ON_COMPUTER,

    /** The approval is no longer pending (decided, expired, withdrawn) or unknown. */
    NOT_PENDING,

    /** The computer no longer knows this phone: the pairing ends. */
    PAIRING_ENDED,

    /** Something failed on the computer or on the way (internal_error, stale, replay, too_large frame…): try again. */
    TRY_AGAIN,

    /** Refused for a reason the owner cannot change from the phone. */
    REFUSED;

    companion object {
        fun of(code: String): ReplyOutcome = when (code) {
            "full_view_required", "full_view_unavailable", "too_large", "verification_required", "params_hash_required" ->
                DECIDE_ON_COMPUTER
            "not_pending", "not_found" -> NOT_PENDING
            "expired", "unknown_device" -> PAIRING_ENDED
            "internal_error", "stale", "replay", "busy", "rate_limited" -> TRY_AGAIN
            else -> REFUSED
        }
    }
}

/**
 * Follows one started chat turn (`chat.send` → reply with `runId`, then run
 * frames and one `run.end`). Frames come in `seq` order; a repeated or older
 * `seq` is ignored. When the computer gives up streaming (`dropped` /
 * `slow_link`, an unknown run, or a frame too large to send), the phone reads
 * the conversation again with `chat.messages` instead of guessing.
 */
class RunStream(val conversationId: String, val runId: String) {
    sealed class Step {
        /** Show this run event. */
        class Show(val seq: Long, val frame: Map<String, Any?>) : Step()

        /** Not for this run, or already seen. */
        object Ignore : Step()

        /**
         * The run is over. [reread] is the signed body to send next
         * (`chat.messages {id}`) when the stream did not carry everything;
         * [problem] says what to tell the owner, if anything.
         */
        class Ended(val status: String, val reread: String?, val problem: ReplyOutcome?) : Step()
    }

    var lastSeq: Long = 0
        private set
    var ended: Boolean = false
        private set

    fun onFrame(frame: PhoneFrame): Step {
        if (ended) return Step.Ignore
        return when (frame) {
            is PhoneFrame.Run -> {
                if (frame.runId != runId || frame.seq <= lastSeq) {
                    Step.Ignore
                } else {
                    lastSeq = frame.seq
                    Step.Show(frame.seq, frame.frame)
                }
            }
            is PhoneFrame.RunFailed -> {
                if (frame.runId != null && frame.runId != runId) return Step.Ignore
                // One event could not be sent; the rest is read from the saved conversation.
                ended = true
                Step.Ended("dropped", PhoneCommands.chatMessages(conversationId), null)
            }
            is PhoneFrame.RunEnd -> {
                if (frame.runId != runId) return Step.Ignore
                ended = true
                when {
                    frame.droppedForSlowLink || frame.status == "dropped" || frame.status == "unknown" ->
                        Step.Ended(frame.status, PhoneCommands.chatMessages(conversationId), null)
                    frame.code == "internal_error" ->
                        Step.Ended(frame.status, PhoneCommands.chatMessages(conversationId), ReplyOutcome.TRY_AGAIN)
                    else -> Step.Ended(frame.status, null, null)
                }
            }
            else -> Step.Ignore
        }
    }
}
