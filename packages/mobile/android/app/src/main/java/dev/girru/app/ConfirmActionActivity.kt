package dev.girru.app

import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import dev.girru.app.crypto.SignedCommand
import dev.girru.app.link.CommandSender
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
 * intent extras only point at it. Both answers ask for the unlock first: the
 * answer is a command signed with the unlock-bound identity key. Not exported.
 */
class ConfirmActionActivity : AppCompatActivity() {
    private lateinit var auth: Authenticator

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SecureWindow.apply(this)
        auth = Authenticator(this)
        if (savedInstanceState != null) {
            finish()
            return
        }
        val app = application as GirruApplication
        val approvalId = intent.getStringExtra(EXTRA_APPROVAL_ID)?.takeIf { ApprovalDecision.isValidId(it) }
        val kind = approvalId?.let { app.pairing.verifiedApproval(it) }
        val approve = intent.getBooleanExtra(EXTRA_APPROVE, false)
        val notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0)
        if (approvalId == null || kind == null) {
            finish()
            return
        }
        val computer = app.pairing.load()?.takeIf { it.state == PairedComputer.State.PAIRED }
        val deviceId = app.crypto.deviceId()
        if (computer == null || deviceId == null || computer.isExpired(System.currentTimeMillis())) {
            toast(R.string.not_paired)
            finish()
            return
        }
        if (auth.availability() != Authenticator.Availability.READY) {
            toast(R.string.confirm_failed)
            finish()
            return
        }
        // Every answer (sensitive or not) needs the unlock, because the identity key does.
        val prompt = getString(if (approve) R.string.confirm_approve else R.string.confirm_deny)
        auth.authenticate(prompt, getString(R.string.confirm_subtitle)) { ok ->
            if (ok) send(app, computer, deviceId, approvalId, approve, notificationId) else finish()
        }
    }

    private fun send(
        app: GirruApplication,
        computer: PairedComputer,
        deviceId: String,
        approvalId: String,
        approve: Boolean,
        notificationId: Int,
    ) {
        val command = try {
            SignedCommand.create(
                deviceId = deviceId,
                to = computer.computerId,
                counter = app.crypto.nextCounter(),
                body = ApprovalDecision.body(approvalId, approve),
                nowMs = System.currentTimeMillis(),
                signer = app.crypto.signer,
            )
        } catch (e: GeneralSecurityException) {
            return fail()
        } catch (e: ProviderException) {
            return fail()
        } catch (e: IllegalStateException) {
            return fail()
        }
        app.commands.send(command) { result ->
            when (result) {
                CommandSender.Result.Accepted -> {
                    app.pairing.markUsed(System.currentTimeMillis())
                    app.pairing.forgetApproval(approvalId)
                    Notifier.cancel(this, notificationId)
                }
                is CommandSender.Result.Refused -> {
                    app.pairing.onRefusedByComputer(result.reason)
                    toast(R.string.removed_on_computer)
                }
                CommandSender.Result.NotDelivered -> toast(R.string.not_sent_yet)
            }
            finish()
        }
    }

    private fun fail() {
        toast(R.string.confirm_failed)
        finish()
    }

    private fun toast(text: Int) = Toast.makeText(applicationContext, text, Toast.LENGTH_SHORT).show()

    companion object {
        const val EXTRA_APPROVAL_ID = "dev.girru.app.extra.APPROVAL_ID"
        const val EXTRA_APPROVE = "dev.girru.app.extra.APPROVE"
        const val EXTRA_NOTIFICATION_ID = "dev.girru.app.extra.NOTIFICATION_ID"
    }
}
