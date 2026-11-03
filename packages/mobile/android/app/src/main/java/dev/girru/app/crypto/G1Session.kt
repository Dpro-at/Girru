package dev.girru.app.crypto

import java.nio.ByteBuffer
import java.security.KeyPair

/**
 * One end-to-end session (PROTOCOL.md "Envelope"): `g1.msg.<header>.<body>`,
 * AES-256-GCM with the header text as additional data and a nonce made from
 * the per-direction sequence number. Incoming `seq` must grow; it moves only
 * after the tag checks.
 */
class G1Session internal constructor(
    val id: String,
    val selfId: String,
    val peerId: String,
    private val sendKey: ByteArray,
    private val recvKey: ByteArray,
) {
    var sendSeq: Long = 0
        private set
    var recvSeq: Long = 0
        private set

    fun seal(plaintext: ByteArray): String {
        if (sendSeq >= MAX_SAFE_INTEGER) throw G1Exception("session_exhausted")
        val seq = ++sendSeq
        val header = G1.b64url(FlatJson.write("sid" to id, "seq" to seq, "from" to selfId, "to" to peerId).utf8)
        val body = G1.aesGcmSeal(sendKey, nonceFor(seq), header.utf8, plaintext)
        return "${G1.SUITE}.msg.$header.${G1.b64url(body)}"
    }

    fun open(envelope: String): ByteArray {
        val (header, bodyText) = G1Handshake.split(envelope, "msg")
        val h = G1Handshake.readJson(header)
        if (h["sid"] != id || h["from"] != peerId || h["to"] != selfId) throw G1Exception("wrong_session")
        val seq = h["seq"] as? Long ?: throw G1Exception("bad_format")
        if (seq < 1 || seq > MAX_SAFE_INTEGER) throw G1Exception("bad_format")
        if (seq <= recvSeq) throw G1Exception("replay")
        val body = G1.fromB64url(bodyText) ?: throw G1Exception("bad_format")
        if (body.size < 16) throw G1Exception("bad_format")
        val plaintext = G1.aesGcmOpen(recvKey, nonceFor(seq), header.utf8, body) ?: throw G1Exception("bad_tag")
        recvSeq = seq
        return plaintext
    }

    companion object {
        // Matches JavaScript's Number.MAX_SAFE_INTEGER so both sides agree on limits.
        const val MAX_SAFE_INTEGER = 9007199254740991L

        fun nonceFor(seq: Long): ByteArray = ByteBuffer.allocate(12).putInt(0).putLong(seq).array()
    }
}

/** The side that opened a handshake and waits for hs2. The ephemeral key lives only in memory. */
class PendingHandshake internal constructor(
    val selfId: String,
    val peerId: String,
    internal val ephemeral: KeyPair,
    val hello: String,
)

/** PROTOCOL.md "Session handshake" (hs1 → hs2), both roles. */
object G1Handshake {
    /** Step 1: a signed hello with a fresh ephemeral key. */
    fun start(selfId: String, signer: Signer, peerId: String, nowMs: Long): PendingHandshake {
        if (!G1.isDeviceId(peerId)) throw G1Exception("bad_format")
        val eph = G1.newEphemeral()
        val payload = G1.b64url(
            FlatJson.write(
                "from" to selfId,
                "to" to peerId,
                "eph" to G1.b64url(eph.public.encoded),
                "ts" to nowMs,
                "nonce" to G1.b64url(G1.randomBytes(16)),
            ).utf8,
        )
        val sig = G1.b64url(signer.sign("girru/v1/hs1\n$payload".utf8))
        return PendingHandshake(selfId, peerId, eph, "${G1.SUITE}.hs1.$payload.$sig")
    }

    /** Step 2 (answering side): checks hs1 against the paired key; returns hs2 and the session. */
    fun answer(
        selfId: String,
        signer: Signer,
        peerSpki: ByteArray,
        envelope: String,
        nowMs: Long,
        windowMs: Long = G1.WINDOW_MS,
    ): Pair<String, G1Session> {
        val (payload, sig) = split(envelope, "hs1")
        checkSigned("hs1", payload, sig, peerSpki)
        val hello = readJson(payload)
        val peerId = G1.deviceIdOf(peerSpki)
        val peerEph = hello["eph"] as? String
        if (hello["from"] != peerId || hello["to"] != selfId || peerEph == null) throw G1Exception("bad_format")
        checkTime(hello["ts"], nowMs, windowMs)
        val peerEphBytes = G1.fromB64url(peerEph) ?: throw G1Exception("bad_format")
        val eph = G1.newEphemeral()
        val reply = G1.b64url(
            FlatJson.write(
                "from" to selfId,
                "to" to peerId,
                "eph" to G1.b64url(eph.public.encoded),
                "ts" to nowMs,
                "h1" to G1.b64url(G1.sha256(envelope.utf8)),
            ).utf8,
        )
        val shared = G1.ecdh(eph.private, peerEphBytes) ?: throw G1Exception("bad_format")
        val session = derive(selfId, peerId, initiator = false, shared, transcript(envelope, reply))
        val replySig = G1.b64url(signer.sign("girru/v1/hs2\n$reply".utf8))
        return "${G1.SUITE}.hs2.$reply.$replySig" to session
    }

    /** Step 3 (opener): checks hs2 and derives the same session. */
    fun finish(
        pending: PendingHandshake,
        peerSpki: ByteArray,
        envelope: String,
        nowMs: Long,
        windowMs: Long = G1.WINDOW_MS,
    ): G1Session {
        val (payload, sig) = split(envelope, "hs2")
        checkSigned("hs2", payload, sig, peerSpki)
        if (G1.deviceIdOf(peerSpki) != pending.peerId) throw G1Exception("wrong_key")
        val reply = readJson(payload)
        val peerEph = reply["eph"] as? String
        if (reply["from"] != pending.peerId || reply["to"] != pending.selfId || peerEph == null) {
            throw G1Exception("bad_format")
        }
        if (reply["h1"] != G1.b64url(G1.sha256(pending.hello.utf8))) throw G1Exception("bad_format")
        checkTime(reply["ts"], nowMs, windowMs)
        val peerEphBytes = G1.fromB64url(peerEph) ?: throw G1Exception("bad_format")
        val shared = G1.ecdh(pending.ephemeral.private, peerEphBytes) ?: throw G1Exception("bad_format")
        return derive(pending.selfId, pending.peerId, initiator = true, shared, transcript(pending.hello, payload))
    }

    internal fun split(envelope: String, kind: String): Pair<String, String> {
        val parts = envelope.split('.')
        if (parts.size != 4 || parts[0] != G1.SUITE || parts[1] != kind) throw G1Exception("bad_format")
        return parts[2] to parts[3]
    }

    internal fun readJson(part: String): Map<String, Any?> {
        val bytes = G1.fromB64url(part) ?: throw G1Exception("bad_format")
        return FlatJson.read(String(bytes, Charsets.UTF_8)) ?: throw G1Exception("bad_format")
    }

    private fun checkSigned(context: String, payload: String, sig: String, peerSpki: ByteArray) {
        val sigBytes = G1.fromB64url(sig) ?: throw G1Exception("bad_signature")
        if (!G1.verify(peerSpki, "girru/v1/$context\n$payload".utf8, sigBytes)) throw G1Exception("bad_signature")
    }

    private fun checkTime(ts: Any?, nowMs: Long, windowMs: Long) {
        val t = ts as? Long ?: throw G1Exception("bad_format")
        if (kotlin.math.abs(nowMs - t) > windowMs) throw G1Exception("stale")
    }

    private fun transcript(hello: String, replyPayload: String): ByteArray =
        G1.sha256("$hello\n$replyPayload".utf8)

    private fun derive(selfId: String, peerId: String, initiator: Boolean, shared: ByteArray, transcript: ByteArray): G1Session {
        val okm = G1.hkdf(shared, transcript, "girru/v1/session".utf8, 64)
        val i2r = okm.copyOfRange(0, 32)
        val r2i = okm.copyOfRange(32, 64)
        return G1Session(
            id = G1.b64url(transcript.copyOfRange(0, 16)),
            selfId = selfId,
            peerId = peerId,
            sendKey = if (initiator) i2r else r2i,
            recvKey = if (initiator) r2i else i2r,
        )
    }
}
