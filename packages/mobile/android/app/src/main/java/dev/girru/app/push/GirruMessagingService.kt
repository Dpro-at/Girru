package dev.girru.app.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.girru.app.GirruApplication
import dev.girru.app.crypto.G1Exception
import dev.girru.app.pairing.PairedComputer

/**
 * Receives data-only pushes carrying one `g1.ntf` and shows its content only
 * after NoticeEnvelope's checks and the replay window pass. A notice that
 * fails shows only a neutral line. Approval ids from verified notices are
 * remembered (encrypted store) so Approve / Deny can act on them, and on
 * nothing else.
 */
class GirruMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        // A visible "notification" block would be shown by the system in clear text; the
        // relay never sends one, and such a message is ignored here.
        if (message.notification != null) return
        val app = application as GirruApplication
        val now = System.currentTimeMillis()
        val computer = app.pairing.load() ?: return
        if (computer.state != PairedComputer.State.PAIRED || computer.isExpired(now)) return
        val notifyKey = computer.notificationKey ?: return
        val phoneId = app.crypto.deviceId() ?: return
        val envelope = message.data[DATA_KEY] ?: return Notifier.showNeutral(this)
        val opened = try {
            NoticeEnvelope.open(envelope, computer.computerKey, computer.computerId, phoneId, notifyKey, now)
        } catch (e: G1Exception) {
            return Notifier.showNeutral(this)
        }
        // Last check, so a forged or broken notice never moves the window. A replay was shown already.
        if (!app.crypto.acceptNoticeCounter(opened.counter)) return
        val notice = opened.notice
        notice.approvalId?.let { if (notice.kind.isApproval) app.pairing.rememberApproval(it, notice.kind) }
        Notifier.show(this, notice)
    }

    override fun onNewToken(token: String) {
        // TODO(MOB-PUSH-01): send the new token to the computer inside the E2E session.
        // It never goes to our server on its own; the computer hands it to the relay per push.
        (application as GirruApplication).store.edit { it[PushSetup.K_TOKEN] = token }
    }

    companion object {
        /** The single data field of a push: the `g1.ntf` text. */
        const val DATA_KEY = "g"
    }
}
