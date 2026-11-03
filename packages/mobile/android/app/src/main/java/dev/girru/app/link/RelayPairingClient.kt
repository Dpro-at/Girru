package dev.girru.app.link

import dev.girru.app.crypto.G1
import dev.girru.app.crypto.G1Exception
import dev.girru.app.crypto.Signer
import dev.girru.app.pairing.PairingPayload
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/** The relay frames of PROTOCOL.md "Relay wire protocol", phone side. Pure, so the hello rules are tested without a network. */
object RelayFrames {
    const val VERSION = 1L

    /**
     * The signed `hello` for one relay `challenge`. Refused when the challenge
     * names any relay but [configured] (byte for byte) or its nonce is not 32
     * bytes: a hello is good for one relay and one connection only.
     */
    fun hello(challenge: Map<String, Any?>, configured: String, spki: ByteArray, signer: Signer, allow: List<String>): String {
        val nonce = challenge["nonce"] as? String
        if (challenge["t"] != "challenge" || challenge["v"] != VERSION || nonce == null || G1.fromB64url(nonce)?.size != 32) {
            throw G1Exception("bad_format")
        }
        if (challenge["relay"] != configured) throw G1Exception("wrong_relay")
        val sig = signer.sign("girru/relay/v1/hello\n$configured\n$nonce".toByteArray(Charsets.UTF_8))
        return Json.compact(
            linkedMapOf("t" to "hello", "v" to VERSION, "key" to G1.b64url(spki), "sig" to G1.b64url(sig), "allow" to allow, "pairing" to emptyList<String>()),
        )
    }

    fun sendToPairing(pairingId: String, env: String): String = Json.compact(linkedMapOf("t" to "send", "pairing" to pairingId, "env" to env))
}

/**
 * Pairing steps 3–6 over the relay (MOB-LINK-01): one connection that lists
 * only the computer (`cid`) on its allow list, proves this phone's id with a
 * hello signed by the identity key, sends the sealed `g1.preq` to the pairing
 * id, then hands the computer's `g1.pchal` and `g1.pwel` to [PairingClient.Events].
 *
 * The hello is signed right after the unlock that also signed the request (the
 * identity key is bound to a recent unlock). Events are given to [post], which
 * the app sets to the main thread. A new request closes any earlier connection.
 * Opening and checking the challenge and the welcome stays in PairingRepository.
 */
class RelayPairingClient(
    private val identity: () -> Pair<ByteArray, Signer>?,
    private val post: (Runnable) -> Unit,
    private val http: OkHttpClient = defaultHttp,
) : PairingClient {
    private var socket: WebSocket? = null

    @Synchronized
    override fun sendRequest(payload: PairingPayload, request: String, events: PairingClient.Events) {
        socket?.close(NORMAL, null)
        socket = null
        // The "Only on this Wi-Fi" path is not built in the apps yet.
        val relay = payload.relayUrl ?: return post { events.delivered(false) }
        val (spki, signer) = identity() ?: return post { events.delivered(false) }
        socket = http.newWebSocket(Request.Builder().url(relay).build(), Listener(relay, payload, request, spki, signer, events))
    }

    private inner class Listener(
        private val relay: String,
        private val payload: PairingPayload,
        private val request: String,
        private val spki: ByteArray,
        private val signer: Signer,
        private val events: PairingClient.Events,
    ) : WebSocketListener() {
        private var ready = false
        private var welcomed = false
        private var ended = false

        override fun onMessage(webSocket: WebSocket, text: String) {
            val frame = Json.readObject(text) ?: return
            when (frame["t"]) {
                "challenge" -> if (!ready) {
                    val hello = try {
                        RelayFrames.hello(frame, relay, spki, signer, listOf(payload.computerId))
                    } catch (e: Exception) {
                        // A wrong relay, a bad nonce or a locked key: nothing is sent.
                        return fail(webSocket)
                    }
                    webSocket.send(hello)
                }
                "ready" -> {
                    if (ready || frame["id"] != G1.deviceIdOf(spki)) return fail(webSocket)
                    ready = true
                    webSocket.send(RelayFrames.sendToPairing(payload.pairingId, request))
                    post { events.delivered(true) }
                }
                "msg" -> {
                    val env = frame["env"] as? String ?: return
                    if (!ready || frame["from"] != payload.computerId) return
                    when {
                        env.startsWith("g1.pchal.") -> post { events.challenge(env) }
                        env.startsWith("g1.pwel.") && !welcomed -> {
                            welcomed = true
                            post { events.welcome(env) }
                            // Pairing is over; the session uses its own connection.
                            webSocket.close(NORMAL, null)
                        }
                    }
                }
                // `offline`: the computer is not connected (or not listening for this pairing id).
                "drop" -> if (frame["reason"] == "offline") fail(webSocket)
                "error" -> fail(webSocket)
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = end()

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = end()

        private fun fail(webSocket: WebSocket) {
            webSocket.close(NORMAL, null)
            end()
        }

        /** A link that ends before the welcome reports the request as not delivered. */
        private fun end() {
            if (ended) return
            ended = true
            if (!welcomed) post { events.delivered(false) }
        }
    }

    private companion object {
        const val NORMAL = 1000
        val defaultHttp: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                // The relay drops peers that miss its pings; OkHttp answers them. This keeps idle links alive too.
                .pingInterval(30, TimeUnit.SECONDS)
                .build()
        }
    }
}
