package dev.girru.app.pairing

import dev.girru.app.crypto.G1
import dev.girru.app.crypto.utf8

/**
 * The one computer this phone is paired with (or is pairing with). Kept only
 * in the encrypted store.
 *
 * While WAITING_FOR_APPROVAL it also holds the one-time pairing id, the
 * pairing key and the QR expiry, needed to open the computer's welcome; they
 * are dropped as soon as the welcome is accepted or the QR code expires.
 */
class PairedComputer(
    val computerId: String,
    val computerKey: ByteArray,
    val name: String,
    val relayUrl: String?,
    val localAddresses: List<String>,
    val lifetime: PairingLifetime,
    val pairedAtMs: Long,
    val lastUsedMs: Long,
    val state: State,
    /** Per-phone notification key from the signed welcome; null until then. */
    val notificationKey: ByteArray?,
    val pending: Pending?,
) {
    enum class State { WAITING_FOR_APPROVAL, PAIRED }

    class Pending(val pairingId: String, val pairingKey: ByteArray, val expiresAtSec: Long)

    fun isExpired(nowMs: Long): Boolean = state == State.PAIRED && PairingExpiry.isExpired(lifetime, lastUsedMs, nowMs)

    /** A request whose QR code has run out can no longer be welcomed. */
    fun isRequestStale(nowMs: Long): Boolean =
        state == State.WAITING_FOR_APPROVAL && (pending == null || nowMs / 1000 > pending.expiresAtSec + REQUEST_GRACE_SEC)

    fun used(nowMs: Long): PairedComputer = copy(lastUsedMs = PairingExpiry.renew(lastUsedMs, nowMs))

    /** The accepted welcome: the computer's lifetime is final; the one-time pairing material is dropped. */
    fun welcomed(welcome: PairingMessages.Welcome, nowMs: Long): PairedComputer = PairedComputer(
        computerId, computerKey, welcome.computerName ?: name, relayUrl, localAddresses,
        welcome.lifetime, pairedAtMs, PairingExpiry.renew(lastUsedMs, nowMs), State.PAIRED, welcome.notifyKey, null,
    )

    fun copy(
        lifetime: PairingLifetime = this.lifetime,
        lastUsedMs: Long = this.lastUsedMs,
        state: State = this.state,
        pending: Pending? = this.pending,
    ) = PairedComputer(
        computerId, computerKey, name, relayUrl, localAddresses,
        lifetime, pairedAtMs, lastUsedMs, state, notificationKey, pending,
    )

    /** Fields as text for the encrypted store; binary values are base64url. */
    fun toFields(): Map<String, String> = buildMap {
        put("c", computerId)
        put("k", G1.b64url(computerKey))
        put("n", name)
        relayUrl?.let { put("r", it) }
        put("l", localAddresses.joinToString(","))
        put("life", lifetime.wire)
        put("at", pairedAtMs.toString())
        put("used", lastUsedMs.toString())
        put("state", state.name)
        notificationKey?.let { put("nk", G1.b64url(it)) }
        pending?.let {
            put("pid", it.pairingId)
            put("pk", G1.b64url(it.pairingKey))
            put("exp", it.expiresAtSec.toString())
        }
    }

    companion object {
        /** The relay keeps a pairing id open for 10 minutes; a little more covers clock difference. */
        const val REQUEST_GRACE_SEC = 60L

        fun fromFields(f: Map<String, String>): PairedComputer? {
            val id = f["c"]?.takeIf { G1.isDeviceId(it) } ?: return null
            val key = f["k"]?.let { G1.fromB64url(it) }?.takeIf { G1.deviceIdOf(it) == id } ?: return null
            val notificationKey = f["nk"]?.let { G1.fromB64url(it)?.takeIf { k -> k.size == 32 } ?: return null }
            val pid = f["pid"]
            val pending = if (pid == null) {
                null
            } else {
                if (!PairingPayloadParser.PAIRING_ID.matches(pid)) return null
                val pk = f["pk"]?.let { G1.fromB64url(it) }?.takeIf { it.size == 32 } ?: return null
                Pending(pid, pk, f["exp"]?.toLongOrNull() ?: return null)
            }
            return PairedComputer(
                computerId = id,
                computerKey = key,
                name = f["n"] ?: PairingPayloadParser.DEFAULT_NAME,
                relayUrl = f["r"],
                localAddresses = f["l"]?.split(',')?.filter { it.isNotEmpty() } ?: emptyList(),
                lifetime = PairingLifetime.fromWire(f["life"]) ?: return null,
                pairedAtMs = f["at"]?.toLongOrNull() ?: return null,
                lastUsedMs = f["used"]?.toLongOrNull() ?: return null,
                state = State.entries.firstOrNull { it.name == f["state"] } ?: return null,
                notificationKey = notificationKey,
                pending = pending,
            )
        }

        /** [wish] is what the owner picked on the phone; the welcome brings the final value. */
        fun waiting(payload: PairingPayload, wish: PairingLifetime, nowMs: Long) = PairedComputer(
            computerId = payload.computerId,
            computerKey = payload.computerKey,
            name = payload.computerName,
            relayUrl = payload.relayUrl,
            localAddresses = payload.localAddresses,
            lifetime = wish,
            pairedAtMs = nowMs,
            lastUsedMs = nowMs,
            state = State.WAITING_FOR_APPROVAL,
            notificationKey = null,
            pending = Pending(
                payload.pairingId,
                PairingMessages.pairingKey(payload.secret, payload.pairingId),
                payload.expiresAtSec,
            ),
        )
    }
}

/** Line codec for the encrypted store: one `key=value` per line, values base64url. */
object StoreCodec {
    private val KEY = Regex("^[a-z0-9._]{1,64}$")

    fun encode(fields: Map<String, String>): ByteArray = fields.entries.joinToString("\n") { (k, v) ->
        require(KEY.matches(k)) { "bad store key" }
        "$k=${G1.b64url(v.utf8)}"
    }.utf8

    fun decode(bytes: ByteArray): Map<String, String>? {
        val out = LinkedHashMap<String, String>()
        val text = String(bytes, Charsets.UTF_8)
        if (text.isEmpty()) return out
        for (line in text.split('\n')) {
            val eq = line.indexOf('=')
            if (eq <= 0) return null
            val key = line.substring(0, eq)
            if (!KEY.matches(key)) return null
            val value = G1.fromB64url(line.substring(eq + 1)) ?: return null
            out[key] = String(value, Charsets.UTF_8)
        }
        return out
    }
}
