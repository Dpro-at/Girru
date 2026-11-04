package dev.girru.app.link

/**
 * Approving from the phone (PROTOCOL.md "Approvals from the phone"): the phone
 * approves exactly the parameters it showed. Pure Kotlin.
 *
 *   1. `approval.pending` (signed) lists the pending approvals with a preview
 *      and its `paramsHash`; the computer marks each one as shown to this phone.
 *   2. A preview that left something out (`truncated` / `fullViewRequired`,
 *      or a nested value shown as `[object]`) needs `approval.detail {id}`:
 *      the full, masked parameters and the hash of that full view.
 *   3. The owner sees those parameters, unlocks, and the phone signs
 *      `approval.decide` with the hash of what was shown.
 *
 * `full_view_required`, `full_view_unavailable`, `too_large` and
 * `verification_required` send the owner to the computer
 * ([ReplyOutcome.DECIDE_ON_COMPUTER]). Deny needs no hash and no full view.
 */
object ApprovalReview {
    /** One entry of the `approval.pending` list. */
    class Listing(
        val id: String,
        val toolName: String,
        val category: String?,
        val preview: Any?,
        val needsFullView: Boolean,
        val paramsHash: String,
    )

    /** The answer to `approval.detail`. */
    class FullView(
        val id: String,
        val toolName: String,
        val category: String?,
        val agentId: String?,
        val params: Any?,
        val maskedFields: List<String>,
        val paramsHash: String,
    )

    sealed class Step {
        /** Ask for `approval.detail {id}` next (signed body in [body]). */
        class FetchFullView(val listing: Listing, val body: String) : Step()

        /**
         * Show these parameters; approving signs `approval.decide` with
         * [paramsHash]. [text] is ready to show; [masked] lists hidden secrets.
         */
        class Show(val id: String, val toolName: String, val text: String, val masked: List<String>, val paramsHash: String) : Step()

        /** Not in the list (decided, expired or never given to this phone). */
        object NotPending : Step()

        /** Decide on the computer; [code] is the computer's reason when there was one. */
        class DecideOnComputer(val code: String?) : Step()

        /** Not answered, or a refusal; [outcome] says what to tell the owner. */
        class Failed(val outcome: ReplyOutcome?) : Step()
    }

    /** The largest parameter text the phone shows; the computer caps a full view at 256 KiB. */
    const val MAX_SHOWN_CHARS = 256 * 1024

    /** After the `approval.pending` list. */
    fun afterList(reply: CommandReply, id: String): Step = when (reply) {
        is CommandReply.Ok -> {
            val listing = findInList(reply.data, id)
            when {
                listing == null -> Step.NotPending
                listing.needsFullView -> Step.FetchFullView(listing, PhoneCommands.approvalDetail(id))
                else -> show(listing.id, listing.toolName, listing.preview, emptyList(), listing.paramsHash)
            }
        }
        is CommandReply.Failed -> failed(reply)
        CommandReply.NotDelivered -> Step.Failed(null)
    }

    /** After `approval.detail`. */
    fun afterDetail(reply: CommandReply, id: String): Step = when (reply) {
        is CommandReply.Ok -> {
            val view = fullView(reply.data, id)
            if (view == null) {
                Step.DecideOnComputer("full_view_unavailable")
            } else {
                show(view.id, view.toolName, view.params, view.maskedFields, view.paramsHash)
            }
        }
        is CommandReply.Failed -> failed(reply)
        CommandReply.NotDelivered -> Step.Failed(null)
    }

    /** After `approval.decide`: null when the computer took the decision, else what to tell the owner. */
    fun decided(reply: CommandReply): Step? = when (reply) {
        is CommandReply.Ok -> null
        is CommandReply.Failed -> failed(reply)
        CommandReply.NotDelivered -> Step.Failed(null)
    }

    fun findInList(data: Any?, id: String): Listing? {
        val list = (data as? Map<*, *>)?.get("approvals") as? List<*> ?: return null
        for (item in list) {
            val a = item as? Map<*, *> ?: continue
            if (a["id"] != id) continue
            val hash = (a["paramsHash"] as? String)?.takeIf { PhoneCommands.PARAMS_HASH.matches(it) } ?: return null
            val tool = (a["toolName"] as? String)?.takeIf { it.isNotBlank() } ?: return null
            val preview = a["paramsPreview"]
            val needsFull = a["fullViewRequired"] == true || a["truncated"] == true ||
                Json.compact(preview).contains("[object]")
            return Listing(id, tool, a["category"] as? String, preview, needsFull, hash)
        }
        return null
    }

    fun fullView(data: Any?, id: String): FullView? {
        val d = data as? Map<*, *> ?: return null
        if (d["id"] != id) return null
        val hash = (d["paramsHash"] as? String)?.takeIf { PhoneCommands.PARAMS_HASH.matches(it) } ?: return null
        val tool = (d["toolName"] as? String)?.takeIf { it.isNotBlank() } ?: return null
        if (!d.containsKey("params") || d["params"] == null) return null
        val masked = (d["maskedFields"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
        return FullView(id, tool, d["category"] as? String, d["agentId"] as? String, d["params"], masked, hash)
    }

    private fun show(id: String, tool: String, params: Any?, masked: List<String>, hash: String): Step {
        val text = Json.pretty(params)
        // Never sign for something the owner could not see in full.
        if (text.length > MAX_SHOWN_CHARS) return Step.DecideOnComputer("too_large")
        return Step.Show(id, tool, text, masked, hash)
    }

    private fun failed(reply: CommandReply.Failed): Step = when (reply.outcome) {
        ReplyOutcome.DECIDE_ON_COMPUTER -> Step.DecideOnComputer(reply.code)
        ReplyOutcome.NOT_PENDING -> Step.NotPending
        else -> Step.Failed(reply.outcome)
    }
}
