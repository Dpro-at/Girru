package dev.girru.app.pairing

import dev.girru.app.crypto.FlatJson
import dev.girru.app.crypto.G1
import dev.girru.app.crypto.G1Exception
import dev.girru.app.crypto.KeyAgreer
import dev.girru.app.crypto.Signer
import dev.girru.app.crypto.utf8

/**
 * Pairing key, request, check challenge, check code and welcome
 * (PROTOCOL.md "Pairing"), byte for byte as the computer's pairing.ts.
 */
object PairingMessages {
    const val CHALLENGE_BYTES = 32

    /** The wrapped notification key in the welcome: 12-byte nonce, 32-byte key, 16-byte tag. */
    const val WRAPPED_NOTIFY_KEY_BYTES = 12 + 32 + 16

    /** HKDF-SHA-256(secret, salt = the pairing id text with `p_`, info = "girru/v1/pair", 32 bytes). */
    fun pairingKey(secret: ByteArray, pairingId: String): ByteArray =
        G1.hkdf(secret, pairingId.utf8, "girru/v1/pair".utf8, 32)

    /**
     * SHA-256("girru/v1/check\n" ‖ secret ‖ computer SPKI ‖ phone SPKI ‖ challenge),
     * first 4 bytes big-endian, mod 10^6, 6 digits. [challenge] is the 32 bytes
     * from the computer's `g1.pchal`: there is no code without it.
     */
    fun checkCode(secret: ByteArray, computerSpki: ByteArray, phoneSpki: ByteArray, challenge: ByteArray): String {
        if (challenge.size != CHALLENGE_BYTES) throw G1Exception("bad_format")
        val h = G1.sha256("girru/v1/check\n".utf8, secret, computerSpki, phoneSpki, challenge)
        val n = ((h[0].toLong() and 0xff) shl 24) or ((h[1].toLong() and 0xff) shl 16) or
            ((h[2].toLong() and 0xff) shl 8) or (h[3].toLong() and 0xff)
        return (n % 1_000_000).toString().padStart(6, '0')
    }

    /** The text the phone's identity key signs inside the request. */
    fun requestSignedText(pairingId: String, phoneSpki: ByteArray, nonce: String): ByteArray =
        "girru/v1/preq-sig\n$pairingId\n${G1.deviceIdOf(phoneSpki)}\n$nonce".utf8

    /**
     * `g1.preq.<nonce>.<box>`: the request JSON sealed under the pairing key,
     * AAD "girru/v1/preq\n" + pairing id. [signer] uses the unlock-bound
     * identity key, so call this right after the unlock prompt.
     * [lifetimeDays] is only a wish (30/60/90/120); null sends none.
     */
    fun buildRequest(
        pairingId: String,
        pairingKey: ByteArray,
        phoneSpki: ByteArray,
        signer: Signer,
        phoneName: String,
        pushToken: String?,
        lifetimeDays: Int?,
    ): String {
        require(PairingPayloadParser.PAIRING_ID.matches(pairingId)) { "bad pairing id" }
        require(lifetimeDays == null || lifetimeDays in WISH_DAYS) { "bad lifetime" }
        val nonceBytes = G1.randomBytes(12)
        val nonce = G1.b64url(nonceBytes)
        val sig = G1.b64url(signer.sign(requestSignedText(pairingId, phoneSpki, nonce)))
        val fields = mutableListOf<Pair<String, Any>>(
            "key" to G1.b64url(phoneSpki),
            "name" to phoneName.take(64),
            "platform" to "android",
        )
        if (pushToken != null) fields += "push" to pushToken
        if (lifetimeDays != null) fields += "lifetimeDays" to lifetimeDays
        fields += "sig" to sig
        val json = FlatJson.write(*fields.toTypedArray())
        val box = G1.aesGcmSeal(pairingKey, nonceBytes, "girru/v1/preq\n$pairingId".utf8, json.utf8)
        return "${G1.SUITE}.preq.$nonce.${G1.b64url(box)}"
    }

    /**
     * Checks a `g1.pchal` and returns its 32 challenge bytes: the computer's
     * signature first (against the QR code's `ck`), then the box under the
     * pairing key (AAD "girru/v1/pchal\n" + pairing id), then both ids and the
     * challenge length. Any failure throws, and the phone shows no code.
     */
    fun openChallenge(
        envelope: String,
        computerSpki: ByteArray,
        computerId: String,
        phoneId: String,
        pairingId: String,
        pairingKey: ByteArray,
    ): ByteArray {
        val c = openSigned(envelope, "pchal", computerSpki, pairingId, pairingKey)
        if (c["computer"] != computerId || c["phone"] != phoneId) throw G1Exception("wrong_key")
        val challenge = (c["challenge"] as? String)?.let { G1.fromB64url(it) } ?: throw G1Exception("bad_format")
        if (challenge.size != CHALLENGE_BYTES) throw G1Exception("bad_format")
        return challenge
    }

    class Welcome(val notifyKey: ByteArray, val lifetime: PairingLifetime, val computerName: String?)

    /**
     * Checks a `g1.pwel`: signature first (against the QR code's key), then
     * decrypts, then the ids, the wrapped key length and the lifetime, and last
     * unwraps the notification key with [agreer] (ECDH with the phone's
     * identity key, see [unwrapNotifyKey]).
     *
     * A G1Exception means the welcome is refused. A GeneralSecurityException
     * can only come from [agreer], so it means everything else checked out and
     * the identity key needs a fresh unlock; open it again after the unlock.
     */
    fun openWelcome(
        envelope: String,
        computerSpki: ByteArray,
        computerId: String,
        phoneId: String,
        pairingId: String,
        pairingKey: ByteArray,
        agreer: KeyAgreer,
    ): Welcome {
        val w = openSigned(envelope, "pwel", computerSpki, pairingId, pairingKey)
        if (w["computer"] != computerId || w["phone"] != phoneId) throw G1Exception("wrong_key")
        val wrapped = (w["notifyKey"] as? String)?.let { G1.fromB64url(it) } ?: throw G1Exception("bad_format")
        if (wrapped.size != WRAPPED_NOTIFY_KEY_BYTES) throw G1Exception("bad_format")
        val lifetime = when (val days = w["lifetimeDays"]) {
            null -> PairingLifetime.NEVER
            is Long -> PairingLifetime.entries.firstOrNull { it.days?.toLong() == days } ?: throw G1Exception("bad_lifetime")
            else -> throw G1Exception("bad_lifetime")
        }
        val name = (w["name"] as? String)?.takeIf { it.isNotBlank() && it.length <= 64 && it.none(Char::isISOControl) }
        val notifyKey = unwrapNotifyKey(wrapped, computerSpki, computerId, phoneId, pairingKey, agreer)
        return Welcome(notifyKey, lifetime, name)
    }

    /**
     * The welcome's notification key is sealed a second time, so the pairing
     * key alone (all a photo of the QR code gives) cannot open it:
     *
     *   shared = ECDH(phone identity private key, computer key), x coordinate
     *   wrap   = HKDF-SHA-256(shared, salt = pairing key, info = "girru/v1/nkey", 32 bytes)
     *   key    = AES-256-GCM-open(wrap, wrapped[0..12], wrapped[12..], AAD = "girru/v1/nkey\n" + computer id + "\n" + phone id)
     */
    fun unwrapNotifyKey(
        wrapped: ByteArray,
        computerSpki: ByteArray,
        computerId: String,
        phoneId: String,
        pairingKey: ByteArray,
        agreer: KeyAgreer,
    ): ByteArray {
        if (wrapped.size != WRAPPED_NOTIFY_KEY_BYTES) throw G1Exception("bad_format")
        val shared = agreer.agree(computerSpki)
        if (shared.size != 32) throw G1Exception("bad_key")
        val wrap = notifyWrapKey(shared, pairingKey)
        val key = G1.aesGcmOpen(wrap, wrapped.copyOfRange(0, 12), notifyKeyAad(computerId, phoneId), wrapped.copyOfRange(12, wrapped.size))
            ?: throw G1Exception("bad_tag")
        if (key.size != 32) throw G1Exception("bad_format")
        return key
    }

    fun notifyWrapKey(shared: ByteArray, pairingKey: ByteArray): ByteArray =
        G1.hkdf(shared, pairingKey, "girru/v1/nkey".utf8, 32)

    fun notifyKeyAad(computerId: String, phoneId: String): ByteArray = "girru/v1/nkey\n$computerId\n$phoneId".utf8

    /**
     * `g1.<kind>.<payload>.<sig>` from the computer: verifies sig over
     * "girru/v1/<kind>\n" + payload, then opens payload = nonce ‖ box under the
     * pairing key with AAD "girru/v1/<kind>\n" + pairing id.
     */
    private fun openSigned(
        envelope: String,
        kind: String,
        computerSpki: ByteArray,
        pairingId: String,
        pairingKey: ByteArray,
    ): Map<String, Any?> {
        val parts = envelope.split('.')
        if (parts.size != 4 || parts[0] != G1.SUITE || parts[1] != kind) throw G1Exception("bad_format")
        val payload = parts[2]
        val sig = G1.fromB64url(parts[3]) ?: throw G1Exception("bad_signature")
        if (!G1.verify(computerSpki, "girru/v1/$kind\n$payload".utf8, sig)) throw G1Exception("bad_signature")
        val sealed = G1.fromB64url(payload) ?: throw G1Exception("bad_format")
        if (sealed.size < 12 + 16) throw G1Exception("bad_format")
        val plain = G1.aesGcmOpen(
            pairingKey,
            sealed.copyOfRange(0, 12),
            "girru/v1/$kind\n$pairingId".utf8,
            sealed.copyOfRange(12, sealed.size),
        ) ?: throw G1Exception("bad_tag")
        return FlatJson.read(String(plain, Charsets.UTF_8)) ?: throw G1Exception("bad_format")
    }

    private val WISH_DAYS = setOf(30, 60, 90, 120)
}
