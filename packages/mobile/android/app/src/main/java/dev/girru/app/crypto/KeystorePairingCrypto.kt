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

/**
 * Identity key in Android Keystore: ECDSA P-256 (suite g1), StrongBox when the
 * phone has it, never exportable, usable only for [AUTH_VALIDITY_SECONDS]
 * after the owner unlocks with a strong biometric or the phone's passcode.
 * Creating a key like this needs a secure lock screen; the app refuses to run
 * without one.
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

    override fun ensureIdentity(): ByteArray {
        identityPublicKey()?.let { return it }
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

    private fun generate(strongBox: Boolean) {
        val builder = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
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
