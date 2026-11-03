package dev.girru.app.web

import dev.girru.app.link.CommandReply
import dev.girru.app.link.ContentSource
import dev.girru.app.link.Json
import dev.girru.app.link.PhoneCommands
import dev.girru.app.link.RelaySessionClient
import dev.girru.app.link.StreamEvent
import java.io.InputStream
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The computer's chat page through the session (PROTOCOL.md "The computer's
 * pages on the phone"): page files with `ui.get`, GET requests with
 * `api.call`, a run's live events with `api.stream`; other requests come from
 * the bridge ([apiCall]). Nothing goes to the network and no token is sent;
 * while the app is locked nothing can be signed, so nothing loads.
 */
class SessionContentSource(
    private val client: RelaySessionClient,
    /** Asks for the fingerprint / screen-lock check on the main thread; the answer may come on any thread. */
    private val confirm: (reason: String, done: (Boolean) -> Unit) -> Unit,
) : ContentSource {
    /** Terminals this phone opened or joined after a check (the owner's decision: the terminal opens behind the fingerprint). */
    val terminal = TerminalGate()

    override fun load(path: String): ContentSource.Content = when (val r = PageBridge.classify("GET", path)) {
        is PageBridge.Request.Refuse -> content(PageBridge.Answer(r.status, "text/plain", ByteArray(0)))
        is PageBridge.Request.File -> content(file(r.path))
        is PageBridge.Request.Api -> if (terminalAllowedBlocking("GET", r.path)) content(blockingApi("GET", r.path, null)) else content(PageBridge.json(403, mapOf("code" to "forbidden")))
        is PageBridge.Request.Stream -> if (terminalAllowedBlocking("GET", r.path)) stream(r.path) else content(PageBridge.json(403, mapOf("code" to "forbidden")))
    }

    /** A request with a body, from the page through the bridge. */
    fun apiCall(method: String, path: String, bodyText: String?, done: (PageBridge.Answer) -> Unit) {
        val r = PageBridge.classify(method, path)
        if (r !is PageBridge.Request.Api) return done(PageBridge.json(400, mapOf("code" to "bad_format")))
        if (bodyText != null && bodyText.toByteArray(Charsets.UTF_8).size > PageBridge.MAX_BODY) return done(PageBridge.json(413, mapOf("code" to "too_large")))
        val body = if (bodyText.isNullOrEmpty()) null else (Json.parse(bodyText) ?: return done(PageBridge.json(400, mapOf("code" to "bad_format"))))
        terminalAllowed(r.method, r.path) { ok ->
            if (!ok) return@terminalAllowed done(PageBridge.json(403, mapOf("code" to "forbidden")))
            client.call(client.signer(PhoneCommands.apiCall(r.method, r.path, body, ref())), { reply ->
                // A terminal this phone just opened may be used without asking again.
                if (PageBridge.terminalUse(r.method, r.path) == PageBridge.TerminalUse.Open && reply is CommandReply.Ok) {
                    (((reply.data as? Map<*, *>)?.get("body") as? Map<*, *>)?.get("id") as? String)?.let(terminal::add)
                }
                done(answer(reply))
            })
        }
    }

    private fun terminalAllowed(method: String, path: String, done: (Boolean) -> Unit) {
        when (val use = PageBridge.terminalUse(method, path)) {
            PageBridge.TerminalUse.None -> done(true)
            PageBridge.TerminalUse.Open -> if (terminal.takeFresh()) done(true) else confirm(REASON, done)
            is PageBridge.TerminalUse.Session -> if (terminal.knows(use.id) || terminal.takeFresh()) { terminal.add(use.id); done(true) }
                else confirm(REASON) { ok -> if (ok) terminal.add(use.id); done(ok) }
        }
    }

    /** For WebView threads: waits for the check (the prompt runs on the main thread). */
    private fun terminalAllowedBlocking(method: String, path: String): Boolean {
        val latch = CountDownLatch(1)
        var ok = false
        terminalAllowed(method, path) { ok = it; latch.countDown() }
        return latch.await(120, TimeUnit.SECONDS) && ok
    }

    private fun answer(reply: CommandReply): PageBridge.Answer = when (reply) {
        is CommandReply.Ok -> PageBridge.apiAnswer(true, reply.data, null)
        is CommandReply.Failed -> PageBridge.apiAnswer(false, null, reply.code)
        CommandReply.NotDelivered -> PageBridge.apiAnswer(false, null, "internal_error")
    }

    private fun blockingApi(method: String, path: String, body: Any?): PageBridge.Answer =
        await(PhoneCommands.apiCall(method, path, body, ref()))?.let(::answer) ?: PageBridge.apiAnswer(false, null, "internal_error")

    /** Every part of one file, of one build. */
    private fun file(path: String): PageBridge.Answer {
        val parts = ArrayList<PageBridge.FilePart>()
        do {
            val reply = await(PhoneCommands.uiGet(path, parts.size, ref())) ?: return PageBridge.apiAnswer(false, null, "internal_error")
            if (reply !is CommandReply.Ok) return answer(reply)
            val part = try { PageBridge.filePart(reply.data) } catch (e: PageBridge.BadAnswer) { return PageBridge.json(502, null) }
            parts.add(part)
            if (part.status != 200) break
        } while (parts.size < parts[0].parts)
        return try { PageBridge.assemble(parts) } catch (e: PageBridge.BadAnswer) { PageBridge.json(502, null) }
    }

    /** The events go into a queue the web view reads as the response body, until the stream ends. */
    private fun stream(path: String): ContentSource.Content {
        val body = EventBody()
        val started = CountDownLatch(1)
        var first: CommandReply? = null
        client.call(client.signer(PhoneCommands.apiStream(path, ref())), { reply -> first = reply; started.countDown() }, stream = { event ->
            when (event) {
                is StreamEvent.Data -> body.add(PageBridge.sse(event.data, event.event))
                // A dropped stream just ends; the page re-attaches with after=<last seq>.
                is StreamEvent.End -> body.end()
            }
        })
        if (!started.await(TIMEOUT_S, TimeUnit.SECONDS) || first !is CommandReply.Ok) {
            body.end()
            return content(first?.let(::answer) ?: PageBridge.apiAnswer(false, null, "internal_error"))
        }
        return ContentSource.Content(PageBridge.EVENTS, 200, "OK", ByteArray(0), body)
    }

    /** A response body fed from another thread; read() waits for the next event. */
    private class EventBody : InputStream() {
        private val queue = LinkedBlockingQueue<ByteArray>()
        private var current = ByteArray(0)
        private var at = 0
        @Volatile private var ended = false

        fun add(bytes: ByteArray) { if (!ended && queue.size < 4096) queue.put(bytes) }
        fun end() { if (!ended) { ended = true; queue.put(END) } }

        override fun read(): Int {
            val b = ByteArray(1)
            return if (read(b, 0, 1) < 0) -1 else b[0].toInt() and 0xFF
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (len == 0) return 0
            while (at >= current.size) {
                val next = queue.take()
                if (next === END) { queue.put(END); return -1 }
                current = next
                at = 0
            }
            val n = minOf(len, current.size - at)
            System.arraycopy(current, at, b, off, n)
            at += n
            return n
        }

        override fun close() = end()

        private companion object { val END = ByteArray(0) }
    }

    private fun await(body: String): CommandReply? {
        val latch = CountDownLatch(1)
        var out: CommandReply? = null
        client.call(client.signer(body), { out = it; latch.countDown() })
        return if (latch.await(TIMEOUT_S, TimeUnit.SECONDS)) out else null
    }

    private fun content(a: PageBridge.Answer) = ContentSource.Content(a.mimeType, a.status, reason(a.status), a.body)

    private fun reason(status: Int) = when (status) { 200 -> "OK"; 201 -> "Created"; 202 -> "Accepted"; 404 -> "Not Found"; else -> "Status" }

    private fun ref() = "p" + UUID.randomUUID().toString().replace("-", "").take(20)

    private companion object {
        const val TIMEOUT_S = 20L
        const val REASON = "Open the terminal"
    }
}

/**
 * Which terminals this phone may use without asking again: those opened or
 * joined after a check, and anything asked for shortly after the terminal
 * button's own check. Memory only; locking the app forgets them all.
 */
class TerminalGate {
    private val ids = HashSet<String>()
    private var freshUntil = 0L

    @Synchronized fun checked(now: Long = System.currentTimeMillis()) { freshUntil = now + 30_000 }
    @Synchronized fun takeFresh(now: Long = System.currentTimeMillis()) = now < freshUntil
    @Synchronized fun knows(id: String) = id in ids
    @Synchronized fun add(id: String) { if (ids.size < 32) ids.add(id) }
    @Synchronized fun forget() { ids.clear(); freshUntil = 0L }
}
