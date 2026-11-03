package dev.girru.app.push

import dev.girru.app.crypto.FlatJson

/**
 * The command body for answering an approval from a notification.
 * DRAFT body shape until the computer's command list is fixed (MOB-PUSH-01);
 * the signing around it is the protocol's.
 */
object ApprovalDecision {
    private val ID = Regex("^[A-Za-z0-9_-]{1,64}$")

    fun isValidId(id: String?): Boolean = id != null && ID.matches(id)

    fun body(approvalId: String, approve: Boolean): String {
        require(isValidId(approvalId)) { "bad approval id" }
        return FlatJson.write(
            "type" to "approval.decide",
            "approval" to approvalId,
            "decision" to if (approve) "approve" else "deny",
        )
    }
}
