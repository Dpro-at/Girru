package dev.girru.app.crypto

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import dev.girru.app.storage.SecureStore
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import javax.crypto.KeyAgreement

/**
 * Identity key in Android Keystore: P-256 (suite g1) for ECDSA signatures and,
 * on Android 12+ (API 31, PURPOSE_AGREE_KEY), for ECDH. StrongBox when the
 * phone has it and the key can be made there, never exportable, usable only
 * for [AUTH_VALIDITY_SECONDS] after the owner unlocks with a strong biometric
 * or the phone's passcode. Creating a key like this needs a secure lock
 * screen; the app refuses to run without one.
 *
 * ECDH is needed once per pairing: the welcome's notification key is wrapped
 * under ECDH(identity keys) (PROTOCOL.md "Wrapped notification key").
 * Android 10 and 11 have no ECDH in the Keystore, and the private key must
 * never leave it, so those phones cannot finish pairing
 * ([supportsKeyAgreement] is false and the pairing screen says so).
 */
class KeystorePairingCrypto(
    private val context: Context,
    private val store: SecureStore,
) : PairingCrypto {
    private val keyStore: KeyStore by lazy { KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) } }

    private val counter = OutgoingCounter(object : CounterStore {
        override fun load(): Long = store.get(K_OUT)?.toLongOrNull() ?: 0L
        override fun save(value: Long) = store.edit { it[K_OUT] = value.toString() }
    })

    private val incoming = ReplayWindow()
    private var incomingLoaded = false

    override val signer = Signer { data ->
        val key = keyStore.getKey(ALIAS, null) as? PrivateKey ?: throw IllegalStateException("no identity key")
        Signature.getInstance("SHA256withECDSA").run {
            initSign(key)
            update(data)
            sign()
        }
    }

    override val agreer = KeyAgreer { peerSpki ->
        val key = keyStore.getKey(ALIAS, null) as? PrivateKey ?: throw G1Exception("no_key")
        val peer = G1.p256PublicKey(peerSpki) ?: throw G1Exception("bad_key")
        KeyAgreement.getInstance("ECDH", ANDROID_KEYSTORE).run {
            init(key)
            doPhase(peer, true)
            generateSecret()
        }
    }

    override fun supportsKeyAgreement(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

    override fun ensureIdentity(): ByteArray {
        identityPublicKey()?.let { existing ->
            if (!supportsKeyAgreement() || keyCanAgree()) return existing
            // Made before ECDH was needed; only called while not paired, so it is safe to replace.
            deleteIdentity()
        }
        val strongBox = context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
        try {
            generate(strongBox)
        } catch (e: StrongBoxUnavailableException) {
            generate(false)
        } catch (e: ProviderException) {
            if (strongBox) generate(false) else throw e
        }
        return identityPublicKey() ?: throw IllegalStateException("identity key was not created")
    }

    override fun identityPublicKey(): ByteArray? = keyStore.getCertificate(ALIAS)?.publicKey?.encoded

    override fun nextCounter(): Long = counter.next()

    @Synchronized
    override fun acceptNoticeCounter(counter: Long): Boolean {
        if (!incomingLoaded) {
            incoming.restore(store.get(K_IN_HIGH)?.toLongOrNull() ?: 0L, store.get(K_IN_BITS)?.toLongOrNull() ?: 0L)
            incomingLoaded = true
        }
        if (!incoming.accept(counter)) return false
        store.edit {
            it[K_IN_HIGH] = incoming.highest.toString()
            it[K_IN_BITS] = incoming.seenBits.toString()
        }
        return true
    }

    @Synchronized
    override fun deleteIdentity() {
        if (keyStore.containsAlias(ALIAS)) keyStore.deleteEntry(ALIAS)
        store.edit {
            it.remove(K_OUT)
            it.remove(K_IN_HIGH)
            it.remove(K_IN_BITS)
        }
        incoming.restore(0, 0)
    }

    /** For the device test checklist: true when the key is in secure hardware. */
    fun isHardwareBacked(): Boolean? {
        val key = keyStore.getKey(ALIAS, null) as? PrivateKey ?: return null
        val info = KeyFactory.getInstance(key.algorithm, ANDROID_KEYSTORE).getKeySpec(key, KeyInfo::class.java)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            info.securityLevel != KeyProperties.SECURITY_LEVEL_SOFTWARE
        } else {
            legacyInsideSecureHardware(info)
        }
    }

    private fun keyCanAgree(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
        val key = keyStore.getKey(ALIAS, null) as? PrivateKey ?: return false
        val info = KeyFactory.getInstance(key.algorithm, ANDROID_KEYSTORE).getKeySpec(key, KeyInfo::class.java)
        return (info.purposes and KeyProperties.PURPOSE_AGREE_KEY) != 0
    }

    private fun purposes(): Int {
        val sign = KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) sign or KeyProperties.PURPOSE_AGREE_KEY else sign
    }

    /**
     * One key for signatures and ECDH. A StrongBox that refuses the combination
     * falls back to the TEE (see [ensureIdentity]); the agreement purpose is
     * never dropped silently, because pairing cannot finish without it.
     */
    private fun generate(strongBox: Boolean) {
        val builder = KeyGenParameterSpec.Builder(ALIAS, purposes())
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setUserAuthenticationParameters(
                AUTH_VALIDITY_SECONDS,
                KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
            )
        } else {
            legacyValidity(builder)
        }
        if (strongBox) builder.setIsStrongBoxBacked(true)
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE).run {
            initialize(builder.build())
            generateKeyPair()
        }
    }

    @Suppress("DEPRECATION")
    private fun legacyValidity(builder: KeyGenParameterSpec.Builder) {
        builder.setUserAuthenticationValidityDurationSeconds(AUTH_VALIDITY_SECONDS)
    }

    @Suppress("DEPRECATION")
    private fun legacyInsideSecureHardware(info: KeyInfo): Boolean = info.isInsideSecureHardware

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val ALIAS = "girru.identity.v1"

        /** Long enough to sign right after the prompt, short enough to need a fresh unlock for the next action. */
        const val AUTH_VALIDITY_SECONDS = 30

        private const val K_OUT = "crypto.out"
        private const val K_IN_HIGH = "crypto.in.high"
        private const val K_IN_BITS = "crypto.in.bits"
    }
}
