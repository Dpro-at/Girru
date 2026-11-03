package dev.girru.app.web

import dev.girru.app.link.Json
import java.util.Base64

/**
 * The computer's chat page inside the app (PROTOCOL.md "The computer's pages on
 * the phone"), same rules as the iPhone's PageBridge: the web view's requests
 * become `ui.get`, `api.call` and `api.stream`, and their answers become what
 * the page reads. Pure Kotlin, so it runs in JVM tests.
 */
object PageBridge {
    sealed class Request {
        data class File(val path: String) : Request()
        data class Api(val method: String, val path: String) : Request()
        data class Stream(val path: String) : Request()
        data class Refuse(val status: Int) : Request()
    }

    class Answer(val status: Int, val mimeType: String, val body: ByteArray)

    class FilePart(val status: Int, val type: String, val parts: Int, val part: Int, val size: Int, val build: String, val body: ByteArray)

    class BadAnswer : Exception()

    private val METHODS = setOf("GET", "POST", "PUT", "PATCH", "DELETE")
    const val MAX_BODY = 256 * 1024
    private const val MAX_PARTS = 70
    const val JSON = "application/json"
    const val EVENTS = "text/event-stream"

    fun classify(method: String, path: String): Request {
        val m = method.uppercase()
        if (m !in METHODS || !path.startsWith("/") || path.toByteArray(Charsets.UTF_8).size > 2048) return Request.Refuse(400)
        if (path.startsWith("/api/")) return if (m == "GET" && isEvents(path)) Request.Stream(path) else Request.Api(m, path)
        if (m != "GET") return Request.Refuse(405)
        // Query strings never name a page file.
        return Request.File(path.substringBefore('?'))
    }

    /** `/api/chat/runs/<runId>/events[?after=N]` */
    fun isEvents(path: String): Boolean {
        val parts = path.substringBefore('?').split('/')
        return parts.size == 6 && parts[1] == "api" && parts[2] == "chat" && parts[3] == "runs" && parts[4].isNotEmpty() && parts[5] == "events"
    }

    fun status(code: String): Int = when (code) {
        "not_allowed" -> 403
        "not_found" -> 404
        "rate_limited" -> 429
        "too_large" -> 413
        "bad_format" -> 400
        "expired", "unknown_device", "revoked", "owner_changed" -> 401
        else -> 503
    }

    /** The answer of `api.call` (`{status, body}`) as the page reads it; a refusal as `{code}`. */
    fun apiAnswer(ok: Boolean, data: Any?, error: String?): Answer {
        if (!ok) return json(status(error ?: "internal_error"), mapOf("code" to (error ?: "internal_error")))
        val d = data as? Map<*, *>
        val status = (d?.get("status") as? Long)?.toInt()
        if (status == null || status !in 100..599) return json(502, null)
        return json(status, d["body"])
    }

    fun json(status: Int, value: Any?) = Answer(status, JSON, Json.compact(value).toByteArray(Charsets.UTF_8))

    fun filePart(data: Any?): FilePart {
        val d = data as? Map<*, *> ?: throw BadAnswer()
        val status = (d["status"] as? Long)?.toInt() ?: throw BadAnswer()
        val build = d["build"] as? String ?: ""
        if (status != 200) return FilePart(status, "", 0, 0, 0, build, ByteArray(0))
        val type = d["type"] as? String ?: throw BadAnswer()
        val parts = (d["parts"] as? Long)?.toInt() ?: throw BadAnswer()
        val part = (d["part"] as? Long)?.toInt() ?: throw BadAnswer()
        val size = (d["size"] as? Long)?.toInt() ?: throw BadAnswer()
        val body = try { Base64.getDecoder().decode(d["body"] as? String ?: throw BadAnswer()) } catch (e: IllegalArgumentException) { throw BadAnswer() }
        if (parts !in 1..MAX_PARTS || part !in 0 until parts || build.isEmpty()) throw BadAnswer()
        return FilePart(200, type, parts, part, size, build, body)
    }

    /** A file's parts put together: complete, in order, of one build and of the stated size. */
    fun assemble(parts: List<FilePart>): Answer {
        val first = parts.firstOrNull() ?: throw BadAnswer()
        if (first.status != 200) return Answer(first.status, "text/plain", ByteArray(0))
        if (parts.size != first.parts) throw BadAnswer()
        val out = java.io.ByteArrayOutputStream(first.size)
        parts.forEachIndexed { i, p ->
            if (p.part != i || p.build != first.build || p.parts != first.parts || p.type != first.type || p.size != first.size) throw BadAnswer()
            out.write(p.body)
        }
        if (out.size() != first.size) throw BadAnswer()
        // WebResourceResponse takes the charset apart from the type.
        return Answer(200, first.type.substringBefore(';').trim(), out.toByteArray())
    }

    /** Which page requests touch a terminal (it opens only after the phone's biometric check). */
    sealed class TerminalUse {
        object None : TerminalUse()
        object Open : TerminalUse()
        data class Session(val id: String) : TerminalUse()
    }

    fun terminalUse(method: String, path: String): TerminalUse {
        val base = path.substringBefore('?')
        if (!base.startsWith("/api/terminal/sessions")) return TerminalUse.None
        val rest = base.removePrefix("/api/terminal/sessions")
        if (rest.isEmpty()) return if (method.uppercase() == "POST") TerminalUse.Open else TerminalUse.None
        val id = rest.trimStart('/').substringBefore('/')
        return if (id.isEmpty()) TerminalUse.None else TerminalUse.Session(id)
    }

    /** One stream event as the page's event stream reads it. */
    fun sse(data: Map<String, Any?>, event: String? = null): ByteArray {
        val seq = data["seq"] as? Long
        val sorted = sortedMapOf<String, Any?>().apply { putAll(data) }
        return ((if (event != null) "event: $event\n" else "") + (if (event == null && seq != null && seq > 0) "id: $seq\n" else "") +
            "data: ${Json.compact(sorted)}\n\n").toByteArray(Charsets.UTF_8)
    }
}
