package dev.girru.app.link

import dev.girru.app.crypto.SignedCommand
import dev.girru.app.pairing.PairingPayload

/**
 * The connection to the computer (local network, direct, relay), built in
 * MOB-LINK-01. The shell talks to it only through these interfaces, so the
 * screens and the lock do not change when it lands.
 */
interface PairingClient {
    /** What comes back for one pairing request; called on the main thread. */
    interface Events {
        /** True when the request was delivered (relay or local network). */
        fun delivered(reached: Boolean)

        /** A `g1.pchal` addressed to this phone: give it to PairingRepository.onChallenge. */
        fun challenge(envelope: String)

        /** A `g1.pwel` addressed to this phone: give it to PairingRepository.onWelcome. */
        fun welcome(envelope: String)
    }

    /**
     * Sends a sealed `g1.preq` to the pairing id over the local network or the
     * relay (the relay name must equal [PairingPayload.relayUrl] exactly, as
     * sent in its challenge), with the computer's id (`cid`) on the allow
     * list. The computer answers to this phone's device id by the same path:
     * first `g1.pchal`, then, once the owner allowed it, `g1.pwel`.
     */
    fun sendRequest(payload: PairingPayload, request: String, events: Events)
}

/**
 * Commands inside the end-to-end session. Every handshake starts with a fresh
 * hs1 (G1Handshake.start); a hello is never sent twice.
 */
interface CommandSender {
    /**
     * Sends one signed command and calls [done] once with its reply (matched
     * by `ref` = the command's nonce). Run frames that follow a `chat.send`
     * go to [frames] (see [RunStream]) until `run.end`.
     */
    fun request(command: SignedCommand, done: (CommandReply) -> Unit, frames: ((PhoneFrame) -> Unit)? = null)

    /** The unsigned `approval.pending {id}` query; null when not answered. A hint, not a permission. */
    fun isApprovalPending(approvalId: String, done: (Boolean?) -> Unit)
}

/**
 * Serves core-ui to the web host from inside the end-to-end session, so the
 * page and its bridge are never loaded over plain http. Called on a WebView
 * background thread; may block. Returns null for "not available".
 *
 * Interception carries no request bodies, so the page's API calls other than
 * GET go through the bridge (`api.call`, NativeBridge) to the session.
 */
interface ContentSource {
    /** [stream], when set, is read instead of [body] (a run's live events). */
    class Content(val mimeType: String, val status: Int, val reason: String, val body: ByteArray, val stream: java.io.InputStream? = null)

    /** [path] includes the query. */
    fun load(path: String): Content?
}

/** Until MOB-LINK-01: nothing leaves the phone, and the screens say so. */
object NotConnectedYet : PairingClient, CommandSender, ContentSource {
    override fun sendRequest(payload: PairingPayload, request: String, events: PairingClient.Events) =
        events.delivered(false)

    override fun request(command: SignedCommand, done: (CommandReply) -> Unit, frames: ((PhoneFrame) -> Unit)?) =
        done(CommandReply.NotDelivered)

    override fun isApprovalPending(approvalId: String, done: (Boolean?) -> Unit) = done(null)

    // A static page without scripts, served under the paired origin.
    private val waitingPage = """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
        <style>body{font-family:sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box;color:#252528;background:#fff}
        @media (prefers-color-scheme:dark){body{color:#F2F2F5;background:#1C1C1E}}</style></head>
        <body><p>Paired. This version of the app cannot reach your computer yet.</p></body></html>
    """.trimIndent().toByteArray(Charsets.UTF_8)

    override fun load(path: String): ContentSource.Content =
        ContentSource.Content("text/html", 200, "OK", waitingPage)
}
