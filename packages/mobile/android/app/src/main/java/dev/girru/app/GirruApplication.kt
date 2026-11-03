package dev.girru.app

import android.app.Application
import android.os.SystemClock
import dev.girru.app.crypto.KeystorePairingCrypto
import dev.girru.app.link.CommandSender
import dev.girru.app.link.ContentSource
import dev.girru.app.link.NotConnectedYet
import dev.girru.app.link.PairingClient
import dev.girru.app.lock.LockPolicy
import dev.girru.app.pairing.NoQrScanner
import dev.girru.app.pairing.PairingRepository
import dev.girru.app.pairing.QrScanner
import dev.girru.app.push.Notifier
import dev.girru.app.storage.SecureStore

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

    // Replaced by the real connector in MOB-LINK-01.
    val pairingClient: PairingClient = NotConnectedYet
    val commands: CommandSender = NotConnectedYet
    val content: ContentSource = NotConnectedYet
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
