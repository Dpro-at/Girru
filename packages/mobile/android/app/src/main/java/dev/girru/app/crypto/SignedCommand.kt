package dev.girru.app.crypto

/**
 * A phone → computer command (PROTOCOL.md "Signed commands"). The computer
 * checks device, target, signature, pairing expiry, time window, counter and
 * nonce; the phone only has to make it correctly.
 */
class SignedCommand(
    val device: String,
    val to: String,
    val ctr: Long,
    val ts: Long,
    val nonce: String,
    val body: String,
    val sig: String,
) {
    fun toJson(): String = FlatJson.write(
        "device" to device,
        "to" to to,
        "ctr" to ctr,
        "ts" to ts,
        "nonce" to nonce,
        "body" to body,
        "sig" to sig,
    )

    companion object {
        fun signedText(device: String, to: String, ctr: Long, ts: Long, nonce: String, body: String): ByteArray =
            "girru/v1/cmd\n$device\n$to\n$ctr\n$ts\n$nonce\n${G1.b64url(G1.sha256(body.utf8))}".utf8

        fun create(deviceId: String, to: String, counter: Long, body: String, nowMs: Long, signer: Signer): SignedCommand {
            require(G1.isDeviceId(deviceId) && G1.isDeviceId(to)) { "bad device id" }
            require(counter >= 1) { "counter starts at 1" }
            val nonce = G1.b64url(G1.randomBytes(16))
            val sig = G1.b64url(signer.sign(signedText(deviceId, to, counter, nowMs, nonce, body)))
            return SignedCommand(deviceId, to, counter, nowMs, nonce, body, sig)
        }
    }
}

/** Where the outgoing command counter is kept; `save` must be durable before it returns. */
interface CounterStore {
    fun load(): Long
    fun save(value: Long)
}

/** Hands out each counter value once, saving it before use so a crash never repeats one. */
class OutgoingCounter(private val store: CounterStore) {
    @Synchronized
    fun next(): Long {
        val value = store.load() + 1
        store.save(value)
        return value
    }
}
