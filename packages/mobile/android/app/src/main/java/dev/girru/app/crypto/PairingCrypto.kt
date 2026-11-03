package dev.girru.app.crypto

/**
 * The device side of the phone link, as the rest of the app sees it. The
 * Android implementation keeps the identity key in Android Keystore; the
 * protocol work itself (handshake, envelopes, commands, push) is the pure g1
 * code in this package, so JVM tests can drive it with a software key.
 */
interface PairingCrypto {
    /** Creates the identity key if missing and returns its SPKI DER public key. */
    fun ensureIdentity(): ByteArray

    /** The identity public key (SPKI DER), or null before the first pairing. */
    fun identityPublicKey(): ByteArray?

    /** base64url(SHA-256(SPKI)), or null before the first pairing. */
    fun deviceId(): String? = identityPublicKey()?.let { G1.deviceIdOf(it) }

    /**
     * Signs with the identity key. The key is bound to a recent unlock, so call
     * this right after a successful prompt; otherwise it throws
     * android.security.keystore.UserNotAuthenticatedException (a GeneralSecurityException).
     */
    val signer: Signer

    /** Next command counter; saved before it is returned. */
    fun nextCounter(): Long

    /** Accepts one notice counter at most once (see [ReplayWindow]); call after every other check. */
    fun acceptNoticeCounter(counter: Long): Boolean

    /** Removes the identity key and counters: used when the phone removes itself. */
    fun deleteIdentity()
}
