package dev.girru.app.link

import dev.girru.app.crypto.SignedCommand
import dev.girru.app.pairing.PairingPayload

/**
 * The connection to the computer (local network, direct, relay), built in
 * MOB-LINK-01. The shell talks to it only through these interfaces, so the
 * screens and the lock do not change when it lands.
 */
interface PairingClient {
    /**
     * Sends a sealed `g1.preq` to the pairing id over the local network or the
     * relay (the relay name must equal [PairingPayload.relayUrl] exactly, as
     * sent in its challenge). The connector later hands the computer's
     * `g1.pwel` to PairingRepository.onWelcome. [done] gets true when the
     * request was delivered.
     */
    fun sendRequest(payload: PairingPayload, request: String, done: (Boolean) -> Unit)
}

interface CommandSender {
    sealed class Result {
        object Accepted : Result()

        /** The computer refused the phone itself (`expired`, `unknown_device`): the pairing ends. */
        class Refused(val reason: String) : Result()

        /** Not delivered, or refused for a reason that does not end the pairing (e.g. `stale`). */
        object NotDelivered : Result()
    }

    fun send(command: SignedCommand, done: (Result) -> Unit)
}

/**
 * Serves core-ui to the web host from inside the end-to-end session, so the
 * page and its bridge are never loaded over plain http. Called on a WebView
 * background thread; may block. Returns null for "not available".
 *
 * Interception carries no request bodies, so API calls of the page go through
 * the bridge to the session (MOB-LINK-01), not through this.
 */
interface ContentSource {
    class Content(val mimeType: String, val status: Int, val reason: String, val body: ByteArray)

    fun load(path: String): Content?
}

/** Until MOB-LINK-01: nothing leaves the phone, and the screens say so. */
object NotConnectedYet : PairingClient, CommandSender, ContentSource {
    override fun sendRequest(payload: PairingPayload, request: String, done: (Boolean) -> Unit) = done(false)

    override fun send(command: SignedCommand, done: (CommandSender.Result) -> Unit) =
        done(CommandSender.Result.NotDelivered)

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
