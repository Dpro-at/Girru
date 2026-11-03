package dev.girru.app.pairing

import dev.girru.app.crypto.G1Exception
import dev.girru.app.crypto.KeyAgreer
import dev.girru.app.push.PushNotice
import dev.girru.app.push.VerifiedApprovals
import dev.girru.app.storage.SecureStore
import java.security.GeneralSecurityException
import java.security.ProviderException

/**
 * The phone's pairing, read and written only through the encrypted store.
 * Scan once, stay paired: while the pairing is valid the app never asks to
 * scan again. It ends when it runs out unused, when the computer refuses the
 * phone (expired or removed there), or when the owner removes it.
 */
class PairingRepository(private val store: SecureStore) {
    enum class Notice { EXPIRED, REMOVED_ON_COMPUTER, CODE_EXPIRED }

    sealed class Status {
        /** Not paired; [notice] says why when a pairing just ended. */
        class NotPaired(val notice: Notice?) : Status()
        class Waiting(val computer: PairedComputer) : Status()
        class Paired(val computer: PairedComputer) : Status()
    }

    fun status(nowMs: Long): Status {
        val computer = load() ?: return Status.NotPaired(notice())
        if (computer.isExpired(nowMs)) {
            end(Notice.EXPIRED)
            return Status.NotPaired(Notice.EXPIRED)
        }
        if (computer.isRequestStale(nowMs)) {
            end(Notice.CODE_EXPIRED)
            return Status.NotPaired(Notice.CODE_EXPIRED)
        }
        return when (computer.state) {
            PairedComputer.State.WAITING_FOR_APPROVAL -> Status.Waiting(computer)
            PairedComputer.State.PAIRED -> Status.Paired(computer)
        }
    }

    fun load(): PairedComputer? {
        val fields = store.snapshot()
            .filterKeys { it.startsWith(PREFIX) }
            .mapKeys { it.key.removePrefix(PREFIX) }
        return if (fields.isEmpty()) null else PairedComputer.fromFields(fields)
    }

    fun save(computer: PairedComputer) = store.edit { map ->
        map.keys.removeAll { it.startsWith(PREFIX) || it == NOTICE }
        computer.toFields().forEach { (k, v) -> map[PREFIX + k] = v }
    }

    /**
     * The computer's check challenge (`g1.pchal`), delivered by the connector.
     * Only after it does the phone show a check code. Returns false and
     * changes nothing when it does not check out.
     */
    fun onChallenge(envelope: String, phoneSpki: ByteArray, nowMs: Long): Boolean {
        val computer = waiting(nowMs) ?: return false
        val next = try {
            computer.withChallenge(envelope, phoneSpki)
        } catch (e: G1Exception) {
            return false
        }
        if (next !== computer) save(next)
        return true
    }

    enum class WelcomeResult { ACCEPTED, NEEDS_UNLOCK, REFUSED }

    /**
     * The computer's signed welcome (`g1.pwel`), delivered by the connector.
     * REFUSED changes nothing. NEEDS_UNLOCK: it checked out, but the identity
     * key needs a fresh unlock to unwrap the notification key; it is kept, and
     * [finishWelcome] completes it after the unlock.
     */
    fun onWelcome(envelope: String, phoneId: String, agreer: KeyAgreer, nowMs: Long): WelcomeResult {
        val computer = waiting(nowMs) ?: return WelcomeResult.REFUSED
        return try {
            save(computer.withWelcome(envelope, phoneId, agreer, nowMs))
            WelcomeResult.ACCEPTED
        } catch (e: G1Exception) {
            WelcomeResult.REFUSED
        } catch (e: GeneralSecurityException) {
            save(computer.holdingWelcome(envelope))
            WelcomeResult.NEEDS_UNLOCK
        } catch (e: ProviderException) {
            // Keystore reports some key failures this way; the welcome is kept for another try.
            save(computer.holdingWelcome(envelope))
            WelcomeResult.NEEDS_UNLOCK
        }
    }

    /** True while a verified welcome waits for the unlock. */
    fun hasHeldWelcome(nowMs: Long): Boolean = waiting(nowMs)?.pending?.welcome != null

    /** Call right after a successful unlock prompt. */
    fun finishWelcome(phoneId: String, agreer: KeyAgreer, nowMs: Long): WelcomeResult {
        val envelope = waiting(nowMs)?.pending?.welcome ?: return WelcomeResult.REFUSED
        return onWelcome(envelope, phoneId, agreer, nowMs)
    }

    private fun waiting(nowMs: Long): PairedComputer? =
        load()?.takeIf { it.state == PairedComputer.State.WAITING_FOR_APPROVAL && !it.isRequestStale(nowMs) }

    /** Call after each authenticated use (accepted command or finished handshake); renews the lifetime. */
    fun markUsed(nowMs: Long) {
        val computer = load()?.takeIf { it.state == PairedComputer.State.PAIRED } ?: return
        save(computer.used(nowMs))
    }

    /** The computer refused this phone as expired or unknown: forget it and say why on the pairing screen. */
    fun onRefusedByComputer(reason: String) {
        end(if (reason == "expired") Notice.EXPIRED else Notice.REMOVED_ON_COMPUTER)
    }

    /** The owner removed the pairing on this phone. */
    fun remove() = store.edit { map -> map.keys.removeAll { it.startsWith(PREFIX) || it == NOTICE || it == APPROVALS } }

    fun clearNotice() = store.edit { it.remove(NOTICE) }

    // ---------- approvals seen in verified notices ----------

    fun rememberApproval(id: String, kind: PushNotice.Kind) = store.edit { map ->
        val entries = VerifiedApprovals.decode(map[APPROVALS])
        VerifiedApprovals.add(entries, id, kind)
        map[APPROVALS] = VerifiedApprovals.encode(entries)
    }

    /** The kind of a verified approval, or null when this id never came in a verified notice. */
    fun verifiedApproval(id: String): PushNotice.Kind? = VerifiedApprovals.decode(store.get(APPROVALS))[id]

    fun forgetApproval(id: String) = store.edit { map ->
        val entries = VerifiedApprovals.decode(map[APPROVALS])
        entries.remove(id)
        map[APPROVALS] = VerifiedApprovals.encode(entries)
    }

    private fun end(notice: Notice) = store.edit { map ->
        map.keys.removeAll { it.startsWith(PREFIX) || it == APPROVALS }
        map[NOTICE] = notice.name
    }

    private fun notice(): Notice? = Notice.entries.firstOrNull { it.name == store.get(NOTICE) }

    private companion object {
        const val PREFIX = "pair."
        const val NOTICE = "pairing.notice"
        const val APPROVALS = "ntf.approvals"
    }
}
