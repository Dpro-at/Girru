package dev.girru.app.link

import dev.girru.app.crypto.G1
import dev.girru.app.crypto.KeyAgreer
import dev.girru.app.crypto.TestIdentity
import dev.girru.app.pairing.PairingLifetime
import dev.girru.app.pairing.PairingMessages
import dev.girru.app.pairing.PairingPayloadParser
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * The Android pairing code against a real computer and relay
 * (packages/mobile/tools/pair-harness.mjs, through android-pair-check.sh). Skipped
 * unless GIRRU_PAIR_QR is set. Same code the app uses (parser, PairingMessages,
 * RelayPairingClient); only the identity is a software key (no Keystore on a JVM).
 */
class PairCheckTest {
    @Test
    fun pairsWithARealComputer() {
        val qr = System.getenv("GIRRU_PAIR_QR")
        assumeTrue("run through packages/mobile/tools/android-pair-check.sh", qr != null)
        val out = File(System.getenv("GIRRU_PAIR_OUT")!!)
        fun say(line: String) = out.appendText("$line\n")

        val phone = TestIdentity()
        val p = (PairingPayloadParser.parse(qr!!, System.currentTimeMillis() / 1000) as PairingPayloadParser.Result.Ok).payload
        val pairingKey = PairingMessages.pairingKey(p.secret, p.pairingId)
        say("id=${phone.id}")
        val request = PairingMessages.buildRequest(
            pairingId = p.pairingId, pairingKey = pairingKey, phoneSpki = phone.spki, signer = phone.signer,
            phoneName = "PairCheck Android", pushToken = null, lifetimeDays = 30,
        )

        val events = LinkedBlockingQueue<Pair<String, String>>()
        val client = RelayPairingClient(identity = { phone.spki to phone.signer }, post = Runnable::run, http = trustingTestCertificate())
        client.sendRequest(p, request, object : PairingClient.Events {
            override fun delivered(reached: Boolean) { events.put("delivered" to reached.toString()) }
            override fun challenge(envelope: String) { events.put("challenge" to envelope) }
            override fun welcome(envelope: String) { events.put("welcome" to envelope) }
        })

        fun next(kind: String): String {
            while (true) {
                val (k, v) = events.poll(60, TimeUnit.SECONDS) ?: error("no $kind")
                if (k == kind) return v
                if (k == "delivered" && v == "false") error("not delivered before $kind")
            }
        }
        assertEquals("true", next("delivered"))
        val challenge = PairingMessages.openChallenge(next("challenge"), p.computerKey, p.computerId, phone.id, p.pairingId, pairingKey)
        say("code=${PairingMessages.checkCode(p.secret, p.computerKey, phone.spki, challenge)}")
        val agreer = KeyAgreer { peer -> G1.ecdh(phone.keyPair.private, peer)!! }
        val welcome = PairingMessages.openWelcome(next("welcome"), p.computerKey, p.computerId, phone.id, p.pairingId, pairingKey, agreer)
        assertEquals(PairingLifetime.entries.first { it.days == 30 }, welcome.lifetime)
        assertTrue(welcome.notifyKey.size == 32)
        say("paired")
    }

    /** Trusts exactly the harness's throwaway localhost certificate. */
    private fun trustingTestCertificate(): OkHttpClient {
        val cert = File(System.getenv("GIRRU_TEST_CA")!!).inputStream().use { CertificateFactory.getInstance("X.509").generateCertificate(it) }
        val keys = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("harness", cert) }
        val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(keys) }.trustManagers[0] as X509TrustManager
        val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        return OkHttpClient.Builder().sslSocketFactory(tls.socketFactory, trust).build()
    }
}
