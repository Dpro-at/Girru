package dev.girru.app.crypto

import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/** A software P-256 identity standing in for the Keystore key in JVM tests. */
class TestIdentity {
    val keyPair: KeyPair = KeyPairGenerator.getInstance("EC").run {
        initialize(ECGenParameterSpec("secp256r1"))
        generateKeyPair()
    }
    val spki: ByteArray = keyPair.public.encoded
    val id: String = G1.deviceIdOf(spki)
    val signer = Signer { data ->
        Signature.getInstance("SHA256withECDSA").run {
            initSign(keyPair.private)
            update(data)
            sign()
        }
    }
}

fun hex(text: String): ByteArray = text.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
