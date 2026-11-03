package dev.girru.app.storage

import android.content.Context
import android.content.pm.PackageManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.AtomicFile
import dev.girru.app.pairing.StoreCodec
import java.io.File
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.ProviderException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Small key/value store, encrypted with an AES-256-GCM key that lives in
 * Android Keystore (StrongBox when present). Holds the pairing record,
 * counters, the push token and the re-lock choice. Never plain
 * SharedPreferences, never the cache folder: the file sits in
 * noBackupFilesDir and backups are off for the whole app.
 *
 * This key is not bound to an unlock on purpose: the push service must read
 * the pairing (to check and decrypt a notification) while the app is locked.
 * The identity key that signs commands is unlock-bound (KeystorePairingCrypto).
 *
 * A file that cannot be decrypted is treated as empty, so the phone pairs again
 * rather than trusting damaged data.
 */
class SecureStore(context: Context) {
    private val appContext = context.applicationContext
    private val file = AtomicFile(File(appContext.noBackupFilesDir, FILE_NAME))
    private var cache: Map<String, String>? = null

    @Synchronized
    fun get(key: String): String? = load()[key]

    @Synchronized
    fun snapshot(): Map<String, String> = load()

    @Synchronized
    fun edit(block: (MutableMap<String, String>) -> Unit) {
        val next = LinkedHashMap(load())
        block(next)
        write(next)
        cache = next
    }

    @Synchronized
    fun clear() {
        file.delete()
        cache = emptyMap()
    }

    private fun load(): Map<String, String> {
        cache?.let { return it }
        val read = read()
        cache = read
        return read
    }

    private fun read(): Map<String, String> {
        val bytes = try {
            file.readFully()
        } catch (e: IOException) {
            return emptyMap()
        }
        if (bytes.size < 1 + IV_SIZE + TAG_SIZE || bytes[0] != FORMAT_VERSION) return emptyMap()
        val iv = bytes.copyOfRange(1, 1 + IV_SIZE)
        val body = bytes.copyOfRange(1 + IV_SIZE, bytes.size)
        val plain = try {
            Cipher.getInstance(TRANSFORMATION).run {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_SIZE * 8, iv))
                updateAAD(AAD)
                doFinal(body)
            }
        } catch (e: GeneralSecurityException) {
            return emptyMap()
        }
        return StoreCodec.decode(plain) ?: emptyMap()
    }

    private fun write(fields: Map<String, String>) {
        // Keystore picks a fresh random IV for every encryption.
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(AAD)
        val body = cipher.doFinal(StoreCodec.encode(fields))
        val iv = cipher.iv
        check(iv.size == IV_SIZE) { "unexpected IV size" }
        val out = file.startWrite()
        try {
            out.write(byteArrayOf(FORMAT_VERSION))
            out.write(iv)
            out.write(body)
            file.finishWrite(out)
        } catch (e: IOException) {
            file.failWrite(out)
            throw e
        }
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val strongBox = appContext.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
        return try {
            generateKey(strongBox)
        } catch (e: StrongBoxUnavailableException) {
            generateKey(false)
        } catch (e: ProviderException) {
            if (strongBox) generateKey(false) else throw e
        }
    }

    private fun generateKey(strongBox: Boolean): SecretKey {
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .apply { if (strongBox) setIsStrongBoxBacked(true) }
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).run {
            init(spec)
            generateKey()
        }
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "girru.store.v1"
        private const val FILE_NAME = "girru-store.bin"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val FORMAT_VERSION: Byte = 1
        private const val IV_SIZE = 12
        private const val TAG_SIZE = 16
        private val AAD = "girru/android/store/v1".toByteArray(Charsets.UTF_8)
    }
}
