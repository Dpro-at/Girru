package dev.girru.app

import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import dev.girru.app.crypto.SignedCommand
import dev.girru.app.link.ApprovalReview
import dev.girru.app.link.CommandReply
import dev.girru.app.link.PhoneCommands
import dev.girru.app.link.ReplyOutcome
import dev.girru.app.lock.Authenticator
import dev.girru.app.lock.SecureWindow
import dev.girru.app.pairing.PairedComputer
import dev.girru.app.push.ApprovalDecision
import dev.girru.app.push.Notifier
import java.security.GeneralSecurityException
import java.security.ProviderException

/**
 * Approve / Deny from a notification. It acts only on an approval id that
 * arrived in a verified notice (PairingRepository.verifiedApproval); the
 * intent extras only point at it. Every step asks for the unlock first: the
 * commands are signed with the unlock-bound identity key. Not exported.
 *
 * Approve never signs blind (PROTOCOL.md "Approvals from the phone"): after
 * the unlock it fetches the approval from the computer's list and, for a
 * cut-short preview, its full view (`approval.detail`), shows those
 * parameters, and only after a second unlock signs `approval.decide` with
 * the `paramsHash` of what was shown. When the computer says the full view is
 * needed but cannot be given (`full_view_required`, `full_view_unavailable`,
 * `too_large`) or asks for a second factor, the owner decides on the computer.
 */
class ConfirmActionActivity : AppCompatActivity() {
    private lateinit var auth: Authenticator
    private val app get() = application as GirruApplication
    private lateinit var approvalId: String
    private lateinit var computer: PairedComputer
    private lateinit var deviceId: String
    private var notificationId = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SecureWindow.apply(this)
        auth = Authenticator(this)
        if (savedInstanceState != null) {
            finish()
            return
        }
        val id = intent.getStringExtra(EXTRA_APPROVAL_ID)?.takeIf { ApprovalDecision.isValidId(it) }
        val kind = id?.let { app.pairing.verifiedApproval(it) }
        val approve = intent.getBooleanExtra(EXTRA_APPROVE, false)
        notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0)
        // From the Approvals screen the id came from the computer over the session, not from a notice.
        val fromList = intent.getBooleanExtra(EXTRA_FROM_LIST, false)
        if (id == null || (kind == null && !fromList)) {
            finish()
            return
        }
        val paired = app.pairing.load()?.takeIf { it.state == PairedComputer.State.PAIRED }
        val device = app.crypto.deviceId()
        if (paired == null || device == null || paired.isExpired(System.currentTimeMillis())) {
            toast(R.string.not_paired)
            finish()
            return
        }
        if (auth.availability() != Authenticator.Availability.READY) {
            toast(R.string.confirm_failed)
            finish()
            return
        }
        approvalId = id
        computer = paired
        deviceId = device
        if (approve) {
            // First unlock: fetch what is to be approved. The decision itself asks again.
            auth.authenticate(getString(R.string.confirm_review), getString(R.string.confirm_subtitle)) { ok ->
                if (ok) fetchReview() else finish()
            }
        } else {
            auth.authenticate(getString(R.string.confirm_deny), getString(R.string.confirm_subtitle)) { ok ->
                if (ok) decide(approve = false, paramsHash = null) else finish()
            }
        }
    }

    private fun fetchReview() {
        val list = sign(PhoneCommands.approvalList()) ?: return fail()
        app.commands.request(list, { reply ->
            gateAccepted(reply)
            onStep(ApprovalReview.afterList(reply, approvalId))
        })
    }

    private fun onStep(step: ApprovalReview.Step) {
        when (step) {
            is ApprovalReview.Step.FetchFullView -> {
                val detail = sign(step.body) ?: return fail()
                app.commands.request(detail, { reply ->
                    gateAccepted(reply)
                    onStep(ApprovalReview.afterDetail(reply, approvalId))
                })
            }
            is ApprovalReview.Step.Show -> showParams(step)
            ApprovalReview.Step.NotPending -> alreadyDecided()
            is ApprovalReview.Step.DecideOnComputer -> done(R.string.decide_on_computer)
            is ApprovalReview.Step.Failed -> failed(step.outcome)
        }
    }

    /** The parameters exactly as they will be approved; Approve asks for a fresh unlock. */
    private fun showParams(step: ApprovalReview.Step.Show) {
        if (isFinishing) return
        val text = buildString {
            append(step.text)
            if (step.masked.isNotEmpty()) {
                append("\n\n")
                append(getString(R.string.approval_masked, step.masked.joinToString(", ")))
            }
        }
        AlertDialog.Builder(this)
            .setTitle(step.toolName)
            .setMessage(text)
            .setPositiveButton(R.string.action_approve) { _, _ ->
                auth.authenticate(getString(R.string.confirm_approve), step.toolName) { ok ->
                    if (ok) decide(approve = true, paramsHash = step.paramsHash) else finish()
                }
            }
            .setNegativeButton(android.R.string.cancel) { _, _ -> finish() }
            .setOnCancelListener { finish() }
            .show()
    }

    private fun decide(approve: Boolean, paramsHash: String?) {
        val command = sign(ApprovalDecision.body(approvalId, approve, paramsHash)) ?: return fail()
        app.commands.request(command, { reply ->
            gateAccepted(reply)
            when (val problem = ApprovalReview.decided(reply)) {
                null -> {
                    app.pairing.forgetApproval(approvalId)
                    Notifier.cancel(this, notificationId)
                    finish()
                }
                else -> onStep(problem)
            }
        })
    }

    /** A reply that passed the computer's command gate renews the pairing. */
    private fun gateAccepted(reply: CommandReply) {
        val passed = when (reply) {
            is CommandReply.Ok -> true
            is CommandReply.Failed -> reply.outcome == ReplyOutcome.NOT_PENDING || reply.outcome == ReplyOutcome.DECIDE_ON_COMPUTER
            CommandReply.NotDelivered -> false
        }
        if (passed) app.pairing.markUsed(System.currentTimeMillis())
    }

    private fun alreadyDecided() {
        app.pairing.forgetApproval(approvalId)
        Notifier.cancel(this, notificationId)
        done(R.string.approval_not_pending)
    }

    private fun failed(outcome: ReplyOutcome?) = when (outcome) {
        null -> done(R.string.not_sent_yet)
        ReplyOutcome.PAIRING_ENDED -> {
            app.pairing.onRefusedByComputer("unknown_device")
            done(R.string.removed_on_computer)
        }
        ReplyOutcome.TRY_AGAIN -> done(R.string.computer_try_again)
        else -> done(R.string.decide_on_computer)
    }

    /** Signs right after an unlock prompt; null when the key refuses (for example the unlock is too old). */
    private fun sign(body: String): SignedCommand? = try {
        SignedCommand.create(
            deviceId = deviceId,
            to = computer.computerId,
            counter = app.crypto.nextCounter(),
            body = body,
            nowMs = System.currentTimeMillis(),
            signer = app.crypto.signer,
        )
    } catch (e: GeneralSecurityException) {
        null
    } catch (e: ProviderException) {
        null
    } catch (e: IllegalStateException) {
        null
    }

    private fun fail() = done(R.string.confirm_failed)

    private fun done(text: Int) {
        toast(text)
        finish()
    }

    private fun toast(text: Int) = Toast.makeText(applicationContext, text, Toast.LENGTH_SHORT).show()

    companion object {
        const val EXTRA_APPROVAL_ID = "dev.girru.app.extra.APPROVAL_ID"
        const val EXTRA_APPROVE = "dev.girru.app.extra.APPROVE"
        const val EXTRA_NOTIFICATION_ID = "dev.girru.app.extra.NOTIFICATION_ID"
        /** Set only by the app's own Approvals screen (the activity is not exported). */
        const val EXTRA_FROM_LIST = "dev.girru.app.extra.FROM_LIST"
    }
}
