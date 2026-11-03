package dev.girru.app.push

import dev.girru.app.link.PhoneCommands

/**
 * The command body for answering an approval (PROTOCOL.md "Approvals from the
 * phone"). Approve carries the `paramsHash` of exactly what the phone showed
 * (see dev.girru.app.link.ApprovalReview); deny needs none.
 */
object ApprovalDecision {
    /** Ids the computer accepts for approval commands. */
    fun isValidId(id: String?): Boolean = id != null && PhoneCommands.APPROVAL_ID.matches(id)

    fun body(approvalId: String, approve: Boolean, paramsHash: String?): String =
        PhoneCommands.approvalDecide(approvalId, approve, paramsHash)
}
