package dev.girru.app.pairing

import dev.girru.app.crypto.FlatJson
import dev.girru.app.crypto.G1
import dev.girru.app.crypto.G1Exception
import dev.girru.app.crypto.Signer
import dev.girru.app.crypto.utf8

/** Pairing key, check code, request and welcome (PROTOCOL.md "Pairing"). */
object PairingMessages {
    /** HKDF-SHA-256(secret, salt = the pairing id text with `p_`, info = "girru/v1/pair", 32 bytes). */
    fun pairingKey(secret: ByteArray, pairingId: String): ByteArray =
        G1.hkdf(secret, pairingId.utf8, "girru/v1/pair".utf8, 32)

    /** SHA-256("girru/v1/check\n" ‖ secret ‖ computer SPKI ‖ phone SPKI), first 4 bytes big-endian, mod 10^6. */
    fun checkCode(secret: ByteArray, computerSpki: ByteArray, phoneSpki: ByteArray): String {
        val h = G1.sha256("girru/v1/check\n".utf8, secret, computerSpki, phoneSpki)
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

    class Welcome(val notifyKey: ByteArray, val lifetime: PairingLifetime, val computerName: String?)

    /**
     * Checks a `g1.pwel`: signature first (against the QR code's key), then
     * decrypts, then the ids, the key length and the lifetime.
     */
    fun openWelcome(
        envelope: String,
        computerSpki: ByteArray,
        computerId: String,
        phoneId: String,
        pairingId: String,
        pairingKey: ByteArray,
    ): Welcome {
        val parts = envelope.split('.')
        if (parts.size != 4 || parts[0] != G1.SUITE || parts[1] != "pwel") throw G1Exception("bad_format")
        val payload = parts[2]
        val sig = G1.fromB64url(parts[3]) ?: throw G1Exception("bad_signature")
        if (!G1.verify(computerSpki, "girru/v1/pwel\n$payload".utf8, sig)) throw G1Exception("bad_signature")
        val sealed = G1.fromB64url(payload) ?: throw G1Exception("bad_format")
        if (sealed.size < 12 + 16) throw G1Exception("bad_format")
        val plain = G1.aesGcmOpen(
            pairingKey,
            sealed.copyOfRange(0, 12),
            "girru/v1/pwel\n$pairingId".utf8,
            sealed.copyOfRange(12, sealed.size),
        ) ?: throw G1Exception("bad_tag")
        val w = FlatJson.read(String(plain, Charsets.UTF_8)) ?: throw G1Exception("bad_format")
        if (w["computer"] != computerId || w["phone"] != phoneId) throw G1Exception("wrong_target")
        val notifyKey = (w["notifyKey"] as? String)?.let { G1.fromB64url(it) } ?: throw G1Exception("bad_format")
        if (notifyKey.size != 32) throw G1Exception("bad_format")
        val lifetime = when (val days = w["lifetimeDays"]) {
            null -> PairingLifetime.NEVER
            is Long -> PairingLifetime.entries.firstOrNull { it.days?.toLong() == days } ?: throw G1Exception("bad_lifetime")
            else -> throw G1Exception("bad_lifetime")
        }
        val name = (w["name"] as? String)?.takeIf { it.isNotBlank() && it.length <= 64 && it.none(Char::isISOControl) }
        return Welcome(notifyKey, lifetime, name)
    }

    private val WISH_DAYS = setOf(30, 60, 90, 120)
}
