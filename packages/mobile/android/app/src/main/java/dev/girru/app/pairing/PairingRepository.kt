package dev.girru.app.pairing

import dev.girru.app.crypto.G1Exception
import dev.girru.app.push.PushNotice
import dev.girru.app.push.VerifiedApprovals
import dev.girru.app.storage.SecureStore

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
     * The computer's signed welcome (`g1.pwel`), delivered by the connector.
     * Returns false and changes nothing when it does not check out.
     */
    fun onWelcome(envelope: String, phoneId: String, nowMs: Long): Boolean {
        val computer = load() ?: return false
        val pending = computer.pending ?: return false
        if (computer.state != PairedComputer.State.WAITING_FOR_APPROVAL || computer.isRequestStale(nowMs)) return false
        val welcome = try {
            PairingMessages.openWelcome(
                envelope, computer.computerKey, computer.computerId, phoneId, pending.pairingId, pending.pairingKey,
            )
        } catch (e: G1Exception) {
            return false
        }
        save(computer.welcomed(welcome, nowMs))
        return true
    }

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
