package dev.girru.app.crypto

import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.GeneralSecurityException
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Suite g1 building blocks from packages/relay/PROTOCOL.md: ECDSA P-256 with
 * SHA-256 (DER signatures), ECDH P-256, HKDF-SHA-256, AES-256-GCM, SHA-256.
 * Only the platform's JCA primitives; no Android types, so it runs in JVM tests.
 */
object G1 {
    const val SUITE = "g1"

    /** Accepted clock difference for handshakes and commands. */
    const val WINDOW_MS = 2 * 60 * 1000L

    // Order of the P-256 group; used to refuse keys on any other curve.
    private val P256_ORDER =
        BigInteger("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16)

    private val random = SecureRandom()

    fun b64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    /** Strict decode: only canonical unpadded base64url, like the relay's `fromB64url`. */
    fun fromB64url(text: String): ByteArray? {
        if (!text.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_' }) return null
        val bytes = try {
            Base64.getUrlDecoder().decode(text)
        } catch (e: IllegalArgumentException) {
            return null
        }
        return if (b64url(bytes) == text) bytes else null
    }

    fun sha256(vararg parts: ByteArray): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        parts.forEach { md.update(it) }
        return md.digest()
    }

    fun randomBytes(size: Int): ByteArray = ByteArray(size).also { random.nextBytes(it) }

    /** Device id = base64url(SHA-256(SPKI DER)), 43 characters. */
    fun deviceIdOf(spki: ByteArray): String = b64url(sha256(spki))

    fun isDeviceId(text: String?): Boolean = text != null && ID_PATTERN.matches(text)

    /** Reads a P-256 public key from SPKI DER; null for any other key type or curve. */
    fun p256PublicKey(spki: ByteArray): ECPublicKey? = try {
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spki)) as? ECPublicKey
        key?.takeIf { it.params.order == P256_ORDER && it.params.curve.field.fieldSize == 256 }
    } catch (e: GeneralSecurityException) {
        null
    }

    fun verify(spki: ByteArray, data: ByteArray, derSignature: ByteArray): Boolean {
        val key = p256PublicKey(spki) ?: return false
        return try {
            Signature.getInstance("SHA256withECDSA").run {
                initVerify(key)
                update(data)
                verify(derSignature)
            }
        } catch (e: GeneralSecurityException) {
            false
        }
    }

    /** Fresh software P-256 key pair for one session (forward secrecy; never stored). */
    fun newEphemeral(): KeyPair = KeyPairGenerator.getInstance("EC").run {
        initialize(ECGenParameterSpec("secp256r1"))
        generateKeyPair()
    }

    /** ECDH shared secret (the 32-byte x coordinate, same as Node's `diffieHellman`). */
    fun ecdh(privateKey: PrivateKey, peerSpki: ByteArray): ByteArray? {
        val peer = p256PublicKey(peerSpki) ?: return null
        return try {
            KeyAgreement.getInstance("ECDH").run {
                init(privateKey)
                doPhase(peer, true)
                generateSecret()
            }
        } catch (e: GeneralSecurityException) {
            null
        }
    }

    /** HKDF-SHA-256 (RFC 5869). An empty salt means 32 zero bytes, as in the RFC and Node. */
    fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length in 1..255 * 32) { "bad HKDF length" }
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(if (salt.isEmpty()) ByteArray(32) else salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArrayOutputStream()
        var block = ByteArray(0)
        var counter = 1
        while (out.size() < length) {
            mac.update(block)
            mac.update(info)
            mac.update(counter.toByte())
            block = mac.doFinal()
            out.write(block)
            counter++
        }
        return out.toByteArray().copyOf(length)
    }

    /** AES-256-GCM; returns ciphertext followed by the 16-byte tag. */
    fun aesGcmSeal(key: ByteArray, nonce: ByteArray, aad: ByteArray, plaintext: ByteArray): ByteArray {
        require(key.size == 32 && nonce.size == 12) { "bad key or nonce size" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad)
        return cipher.doFinal(plaintext)
    }

    /** Null when the tag does not check or the input is malformed. */
    fun aesGcmOpen(key: ByteArray, nonce: ByteArray, aad: ByteArray, body: ByteArray): ByteArray? {
        if (key.size != 32 || nonce.size != 12 || body.size < 16) return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
            cipher.updateAAD(aad)
            cipher.doFinal(body)
        } catch (e: GeneralSecurityException) {
            null
        }
    }

    private val ID_PATTERN = Regex("^[A-Za-z0-9_-]{43}$")
}

internal val String.utf8: ByteArray get() = toByteArray(Charsets.UTF_8)

/** A protocol refusal with the same reason words as the reference code. */
class G1Exception(val reason: String) : Exception(reason)

/** Signs with the device identity key (DER ECDSA P-256 / SHA-256). */
fun interface Signer {
    fun sign(data: ByteArray): ByteArray
}
