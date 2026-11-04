package dev.girru.app.link

import dev.girru.app.crypto.G1
import dev.girru.app.crypto.G1Handshake
import dev.girru.app.crypto.G1Session
import dev.girru.app.crypto.PendingHandshake
import dev.girru.app.crypto.SignedCommand
import dev.girru.app.crypto.Signer
import dev.girru.app.pairing.PairedComputer
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/** One event of an `api.stream`, or its end. */
sealed class StreamEvent {
    /** [event] names the event stream's `event:` line (a terminal's `output` / `exit`); null for a run. */
    class Data(val data: Map<String, Any?>, val event: String? = null) : StreamEvent()
    class End(val complete: Boolean) : StreamEvent()
}

/**
 * The end-to-end session with the paired computer over the relay (the
 * iPhone's SessionLink, same rules): one relay connection that allows only the
 * computer, a fresh signed hs1 for every session (never resent), then sealed
 * `g1.msg` envelopes both ways. Replies are matched by `ref` (the body's `ref`,
 * else the command's nonce). A closed connection fails what waits; the next
 * call connects again with a new handshake.
 *
 * [identity] gives the identity key's SPKI and signer; it works only shortly
 * after an unlock, so calls start after the app is unlocked. Callbacks run on
 * OkHttp's thread; the screens post them to the main thread.
 */
class RelaySessionClient(
    private val computer: () -> PairedComputer?,
    private val identity: () -> Pair<ByteArray, Signer>?,
    private val counter: () -> Long,
    private val now: () -> Long = System::currentTimeMillis,
    private val http: OkHttpClient = defaultHttp,
) : CommandSender {
    private class Waiting(val done: (CommandReply) -> Unit, val frames: ((PhoneFrame) -> Unit)?, val stream: ((StreamEvent) -> Unit)?)

    private var socket: WebSocket? = null
    private var session: G1Session? = null
    private var pending: PendingHandshake? = null
    private var ready = false
    /** Bodies waiting for the session, sealed only once it exists (in order). */
    private val queue = ArrayList<() -> Unit>()
    private val replies = HashMap<String, Waiting>()
    private val runs = HashMap<String, (PhoneFrame) -> Unit>()
    private val streams = HashMap<String, (StreamEvent) -> Unit>()
    private val pendingQueries = HashMap<String, (Boolean?) -> Unit>()

    override fun request(command: SignedCommand, done: (CommandReply) -> Unit, frames: ((PhoneFrame) -> Unit)?) =
        call({ command }, done, frames, null)

    /**
     * Signs with [sign] right before sealing, under this object's lock, so
     * commands leave in the order their counters were taken (the computer
     * refuses a counter that is not above the last one). Use it whenever
     * several commands may be in flight, as the chat page's requests are.
     */
    @Synchronized
    fun call(sign: () -> SignedCommand, done: (CommandReply) -> Unit, frames: ((PhoneFrame) -> Unit)? = null, stream: ((StreamEvent) -> Unit)? = null) {
        val send = send@{
            val command = try { sign() } catch (e: Exception) { return@send done(CommandReply.NotDelivered) }
            val ref = refOf(command)
            replies[ref] = Waiting(done, frames, stream)
            frames?.let { runs[ref] = it }
            stream?.let { streams[ref] = it }
            if (!seal(command.toJson())) fail(ref)
        }
        if (ready && session != null) send() else { queue.add(send); connect() }
    }

    /** Signs a body for the paired computer with the next counter. */
    fun signer(body: String): () -> SignedCommand = {
        val c = computer() ?: throw IllegalStateException("not paired")
        val (spki, signer) = identity() ?: throw IllegalStateException("locked")
        SignedCommand.create(G1.deviceIdOf(spki), c.computerId, counter(), body, now(), signer)
    }

    @Synchronized
    override fun isApprovalPending(approvalId: String, done: (Boolean?) -> Unit) {
        val send = {
            pendingQueries[approvalId] = done
            if (!seal(PhoneCommands.approvalPendingQuery(approvalId))) pendingQueries.remove(approvalId)?.invoke(null)
        }
        if (ready && session != null) send() else { queue.add(send); connect() }
    }

    @Synchronized
    fun close() = drop()

    // ---------- inside ----------

    private fun connect() {
        if (socket != null) return
        val c = computer()
        val relay = c?.relayUrl
        val id = identity()
        if (c == null || relay == null || id == null) return drop()
        socket = http.newWebSocket(Request.Builder().url(relay).build(), Listener(relay, c, id.first, id.second))
    }

    private fun seal(plaintext: String): Boolean {
        val s = session ?: return false
        val c = computer() ?: return false
        val env = try { s.seal(plaintext.toByteArray(Charsets.UTF_8)) } catch (e: Exception) { return false }
        return socket?.send(Json.compact(linkedMapOf("t" to "send", "to" to c.computerId, "env" to env))) == true
    }

    private fun fail(ref: String) {
        runs.remove(ref); streams.remove(ref)
        replies.remove(ref)?.done?.invoke(CommandReply.NotDelivered)
    }

    private inner class Listener(
        private val relay: String,
        private val computer: PairedComputer,
        private val spki: ByteArray,
        private val signer: Signer,
    ) : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) = synchronized(this@RelaySessionClient) {
            if (webSocket !== socket) return@synchronized
            val frame = Json.readObject(text) ?: return@synchronized
            when (frame["t"]) {
                "challenge" -> if (pending == null && !ready) {
                    val hello = try {
                        RelayFrames.hello(frame, relay, spki, signer, listOf(computer.computerId))
                    } catch (e: Exception) {
                        return@synchronized drop()
                    }
                    webSocket.send(hello)
                }
                "ready" -> {
                    if (frame["id"] != G1.deviceIdOf(spki)) return@synchronized drop()
                    // A fresh hs1 for this session; never sent twice.
                    val hs = try { G1Handshake.start(G1.deviceIdOf(spki), signer, computer.computerId, now()) } catch (e: Exception) { return@synchronized drop() }
                    pending = hs
                    webSocket.send(Json.compact(linkedMapOf("t" to "send", "to" to computer.computerId, "env" to hs.hello)))
                }
                "msg" -> {
                    val env = frame["env"] as? String ?: return@synchronized
                    if (frame["from"] != computer.computerId) return@synchronized
                    val hs = pending
                    if (hs != null && env.startsWith("g1.hs2.")) {
                        session = try { G1Handshake.finish(hs, computer.computerKey, env, now()) } catch (e: Exception) { return@synchronized drop() }
                        pending = null
                        ready = true
                        val waiting = ArrayList(queue)
                        queue.clear()
                        waiting.forEach { it() }
                    } else if (env.startsWith("g1.msg.")) {
                        handle(env)
                    }
                }
                // The computer is not on the relay now: what waits fails; the next call tries again.
                "drop" -> if (frame["reason"] == "offline") drop()
                "error" -> drop()
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = synchronized(this@RelaySessionClient) { if (webSocket === socket) drop() }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = synchronized(this@RelaySessionClient) { if (webSocket === socket) drop() }
    }

    private fun handle(env: String) {
        val s = session ?: return
        // A broken, replayed or foreign envelope changes nothing and is dropped.
        val plaintext = try { s.open(env) } catch (e: Exception) { return }
        when (val f = PhoneFrame.parse(String(plaintext, Charsets.UTF_8)) ?: return) {
            is PhoneFrame.Reply -> {
                val ref = f.ref ?: return
                val w = replies.remove(ref) ?: return
                if (!f.ok) { runs.remove(ref); streams.remove(ref) }
                w.done(CommandReply.of(f))
            }
            is PhoneFrame.Run -> f.ref?.let { runs[it]?.invoke(f) }
            is PhoneFrame.RunFailed -> f.ref?.let { runs[it]?.invoke(f) }
            is PhoneFrame.RunEnd -> f.ref?.let { runs.remove(it)?.invoke(f) }
            is PhoneFrame.Stream -> f.ref?.let { streams[it]?.invoke(StreamEvent.Data(f.data, f.event)) }
            is PhoneFrame.StreamEnd -> f.ref?.let { streams.remove(it)?.invoke(StreamEvent.End(f.complete)) }
            is PhoneFrame.PendingAnswer -> pendingQueries.remove(f.id)?.invoke(f.pending)
        }
    }

    private fun drop() {
        socket?.close(NORMAL, null)
        socket = null
        session = null
        pending = null
        ready = false
        val r = HashMap(replies); val q = HashMap(pendingQueries); val st = HashMap(streams); val waiting = ArrayList(queue)
        replies.clear(); runs.clear(); streams.clear(); pendingQueries.clear(); queue.clear()
        r.values.forEach { it.done(CommandReply.NotDelivered) }
        q.values.forEach { it(null) }
        // A page reading a stream re-attaches with `after` once the link is back.
        st.values.forEach { it(StreamEvent.End(false)) }
        // Queued sends that never sealed: their done is not registered yet, so run them to fail.
        waiting.forEach { it() }
    }

    private companion object {
        const val NORMAL = 1000
        private val REF = Regex("^[A-Za-z0-9_-]{1,64}$")

        fun refOf(command: SignedCommand): String =
            ((Json.readObject(command.body)?.get("ref") as? String)?.takeIf { REF.matches(it) }) ?: command.nonce

        val defaultHttp: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .pingInterval(30, TimeUnit.SECONDS)
                .build()
        }
    }
}
