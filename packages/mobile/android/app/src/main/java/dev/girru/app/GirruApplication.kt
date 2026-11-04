package dev.girru.app

import android.app.Application
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import dev.girru.app.crypto.KeystorePairingCrypto
import dev.girru.app.crypto.SignedCommand
import dev.girru.app.link.CommandReply
import dev.girru.app.link.CommandSender
import dev.girru.app.link.PhoneFrame
import dev.girru.app.link.PairingClient
import dev.girru.app.link.RelayPairingClient
import dev.girru.app.link.RelaySessionClient
import dev.girru.app.lock.LockPolicy
import dev.girru.app.pairing.NoQrScanner
import dev.girru.app.pairing.PairedComputer
import dev.girru.app.pairing.PairingRepository
import dev.girru.app.pairing.QrScanner
import dev.girru.app.push.Notifier
import dev.girru.app.storage.SecureStore
import dev.girru.app.web.SessionContentSource

/**
 * Process-wide state. The lock lives in memory only, so a new process always
 * starts locked.
 */
class GirruApplication : Application() {
    lateinit var store: SecureStore
        private set
    lateinit var pairing: PairingRepository
        private set
    lateinit var crypto: KeystorePairingCrypto
        private set
    lateinit var lock: LockPolicy
        private set

    /** Pairing over the relay (MOB-LINK-01); the hello is signed by the identity key. */
    val pairingClient: PairingClient by lazy {
        val main = Handler(Looper.getMainLooper())
        RelayPairingClient(
            identity = { crypto.identityPublicKey()?.let { it to crypto.signer } },
            post = { main.post(it) },
        )
    }

    /** The end-to-end session with the paired computer over the relay. */
    val session: RelaySessionClient by lazy {
        RelaySessionClient(
            computer = { pairing.load()?.takeIf { it.state == PairedComputer.State.PAIRED } },
            identity = { crypto.identityPublicKey()?.let { it to crypto.signer } },
            counter = { crypto.nextCounter() },
        )
    }
    private val mainThread by lazy { Handler(Looper.getMainLooper()) }

    /** For screens: the same session, with every answer given on the main thread. */
    val commands: CommandSender by lazy {
        object : CommandSender {
            override fun request(command: SignedCommand, done: (CommandReply) -> Unit, frames: ((PhoneFrame) -> Unit)?) =
                session.request(command, { r -> mainThread.post { done(r) } }, frames?.let { f -> { fr: PhoneFrame -> mainThread.post { f(fr) } } })

            override fun isApprovalPending(approvalId: String, done: (Boolean?) -> Unit) =
                session.isApprovalPending(approvalId) { v -> mainThread.post { done(v) } }
        }
    }

    /** The computer's chat page, through the session. The activity sets [terminalCheck] while it is shown. */
    var terminalCheck: ((String, (Boolean) -> Unit) -> Unit)? = null
    val content: SessionContentSource by lazy {
        SessionContentSource(session) { reason, done ->
            mainThread.post { terminalCheck?.invoke(reason, done) ?: done(false) }
        }
    }
    val qrScanner: QrScanner = NoQrScanner

    override fun onCreate() {
        super.onCreate()
        store = SecureStore(this)
        pairing = PairingRepository(store)
        crypto = KeystorePairingCrypto(this, store)
        lock = LockPolicy(store.get(K_RELOCK)?.toLongOrNull() ?: LockPolicy.MAX_RELOCK_MS)
        Notifier.createChannels(this)
    }

    /** Monotonic time for the lock. */
    fun now(): Long = SystemClock.elapsedRealtime()

    /** The owner may shorten the re-lock time; the lock itself stays on. */
    fun setRelock(ms: Long): Long {
        val used = lock.setRelockAfter(ms)
        store.edit { it[K_RELOCK] = used.toString() }
        return used
    }

    private companion object {
        const val K_RELOCK = "lock.relock.ms"
    }
}
