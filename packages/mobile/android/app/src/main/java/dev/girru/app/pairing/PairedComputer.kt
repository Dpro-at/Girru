package dev.girru.app.pairing

import dev.girru.app.crypto.G1
import dev.girru.app.crypto.G1Exception
import dev.girru.app.crypto.KeyAgreer
import dev.girru.app.crypto.utf8

/**
 * The one computer this phone is paired with (or is pairing with). Kept only
 * in the encrypted store.
 *
 * While WAITING_FOR_APPROVAL it also holds the one-time pairing id and
 * secret (the check code needs the secret itself, PROTOCOL.md "Check code"),
 * the computer's check challenge once it arrived, and a verified welcome
 * that still waits for an unlock to unwrap its key. All of it is dropped as
 * soon as the welcome is accepted, the pairing is cancelled or it runs out.
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

    class Pending(
        val pairingId: String,
        val secret: ByteArray,
        /** The QR code's `exp`; the request was sent before it. */
        val expiresAtSec: Long,
        /** When the request was sent; the wait for the computer counts from here. */
        val sentAtMs: Long,
        /** The 32 bytes from a verified `g1.pchal`; null until it arrived (no check code before). */
        val challenge: ByteArray? = null,
        /** A verified `g1.pwel` whose key could not be unwrapped yet because the identity key needs an unlock. */
        val welcome: String? = null,
    ) {
        val pairingKey: ByteArray get() = PairingMessages.pairingKey(secret, pairingId)
    }

    fun isExpired(nowMs: Long): Boolean = state == State.PAIRED && PairingExpiry.isExpired(lifetime, lastUsedMs, nowMs)

    /**
     * The computer keeps a pairing screen open for at most 10 minutes and
     * finishes a pairing whose request it took even after the code on screen
     * renewed (every 2 minutes). So the wait counts from the send, not from
     * the QR code's `exp`.
     */
    fun isRequestStale(nowMs: Long): Boolean =
        state == State.WAITING_FOR_APPROVAL && (pending == null || nowMs > pending.sentAtMs + MAX_WAIT_MS + REQUEST_GRACE_MS)

    /** The 6-digit check code, only once a verified challenge is held. */
    fun checkCode(phoneSpki: ByteArray): String? {
        val p = pending ?: return null
        val challenge = p.challenge ?: return null
        return PairingMessages.checkCode(p.secret, computerKey, phoneSpki, challenge)
    }

    /**
     * Takes the computer's `g1.pchal`. The same challenge again changes
     * nothing; a different one after the first is refused, so the code on
     * screen never changes under the owner's eyes.
     */
    fun withChallenge(envelope: String, phoneSpki: ByteArray): PairedComputer {
        val p = pending
        if (state != State.WAITING_FOR_APPROVAL || p == null) throw G1Exception("not_pairing")
        val challenge = PairingMessages.openChallenge(
            envelope, computerKey, computerId, G1.deviceIdOf(phoneSpki), p.pairingId, p.pairingKey,
        )
        p.challenge?.let { held ->
            if (held.contentEquals(challenge)) return this
            throw G1Exception("second_challenge")
        }
        return copy(pending = Pending(p.pairingId, p.secret, p.expiresAtSec, p.sentAtMs, challenge, p.welcome))
    }

    /**
     * Takes the computer's `g1.pwel` (only after a challenge: the owner saw the
     * code on this phone first). Throws G1Exception when it is refused. A
     * GeneralSecurityException means it checked out but the identity key needs
     * an unlock to unwrap the notification key: keep it with [holdingWelcome]
     * and call this again after the unlock.
     */
    fun withWelcome(envelope: String, phoneId: String, agreer: KeyAgreer, nowMs: Long): PairedComputer {
        val p = pending
        if (state != State.WAITING_FOR_APPROVAL || p == null) throw G1Exception("not_pairing")
        if (p.challenge == null) throw G1Exception("no_challenge")
        val welcome = PairingMessages.openWelcome(envelope, computerKey, computerId, phoneId, p.pairingId, p.pairingKey, agreer)
        return welcomed(welcome, nowMs)
    }

    /** Keeps a welcome that checked out but still needs the unlock (see [withWelcome]). */
    fun holdingWelcome(envelope: String): PairedComputer {
        val p = pending ?: throw G1Exception("not_pairing")
        return copy(pending = Pending(p.pairingId, p.secret, p.expiresAtSec, p.sentAtMs, p.challenge, envelope))
    }

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
            put("ps", G1.b64url(it.secret))
            put("exp", it.expiresAtSec.toString())
            put("sent", it.sentAtMs.toString())
            it.challenge?.let { c -> put("ch", G1.b64url(c)) }
            it.welcome?.let { w -> put("wel", w) }
        }
    }

    companion object {
        /** A pairing screen on the computer lasts at most 10 minutes in all. */
        const val MAX_WAIT_MS = 10 * 60 * 1000L

        /** A little more covers clock difference and a slow link. */
        const val REQUEST_GRACE_MS = 60 * 1000L

        fun fromFields(f: Map<String, String>): PairedComputer? {
            val id = f["c"]?.takeIf { G1.isDeviceId(it) } ?: return null
            val key = f["k"]?.let { G1.fromB64url(it) }?.takeIf { G1.deviceIdOf(it) == id } ?: return null
            val notificationKey = f["nk"]?.let { G1.fromB64url(it)?.takeIf { k -> k.size == 32 } ?: return null }
            val pid = f["pid"]
            val pending = if (pid == null) {
                null
            } else {
                if (!PairingPayloadParser.PAIRING_ID.matches(pid)) return null
                val secret = f["ps"]?.let { G1.fromB64url(it) }?.takeIf { it.size == 32 } ?: return null
                val challenge = f["ch"]?.let {
                    G1.fromB64url(it)?.takeIf { c -> c.size == PairingMessages.CHALLENGE_BYTES } ?: return null
                }
                Pending(
                    pid,
                    secret,
                    f["exp"]?.toLongOrNull() ?: return null,
                    f["sent"]?.toLongOrNull() ?: return null,
                    challenge,
                    f["wel"]?.takeIf { it.startsWith("${G1.SUITE}.pwel.") },
                )
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

        /** Made when the request is sent. [wish] is what the owner picked on the phone; the welcome brings the final value. */
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
            pending = Pending(payload.pairingId, payload.secret.copyOf(), payload.expiresAtSec, nowMs),
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
