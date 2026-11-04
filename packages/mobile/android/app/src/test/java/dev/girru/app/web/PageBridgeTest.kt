package dev.girru.app.web

import dev.girru.app.link.Json
import dev.girru.app.link.PhoneCommands
import dev.girru.app.link.PhoneFrame
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class PageBridgeTest {
    @Test
    fun classifiesThePageRequests() {
        assertEquals(PageBridge.Request.File("/"), PageBridge.classify("GET", "/"))
        assertEquals(PageBridge.Request.File("/assets/app-1.js"), PageBridge.classify("GET", "/assets/app-1.js?v=2"))
        assertEquals(PageBridge.Request.Refuse(405), PageBridge.classify("POST", "/chat"))
        assertEquals(PageBridge.Request.Api("GET", "/api/chat/conversations"), PageBridge.classify("GET", "/api/chat/conversations"))
        assertEquals(PageBridge.Request.Api("POST", "/api/chat/conversations/a1/runs"), PageBridge.classify("post", "/api/chat/conversations/a1/runs"))
        assertEquals(PageBridge.Request.Stream("/api/chat/runs/run-abcdefgh/events?after=4"), PageBridge.classify("GET", "/api/chat/runs/run-abcdefgh/events?after=4"))
        assertEquals(PageBridge.Request.Stream("/api/terminal/sessions/abc/stream?after=7"), PageBridge.classify("GET", "/api/terminal/sessions/abc/stream?after=7"))
        assertEquals(PageBridge.Request.Api("GET", "/api/terminal/sessions"), PageBridge.classify("GET", "/api/terminal/sessions"))
        assertEquals(PageBridge.Request.Refuse(400), PageBridge.classify("TRACE", "/api/auth/me"))
        assertEquals(PageBridge.Request.Refuse(400), PageBridge.classify("GET", "relative"))
    }

    @Test
    fun apiAnswersAndRefusals() {
        val ok = PageBridge.apiAnswer(true, mapOf("status" to 201L, "body" to mapOf("id" to "c1")), null)
        assertEquals(201, ok.status)
        assertEquals("application/json", ok.mimeType)
        assertEquals("""{"id":"c1"}""", String(ok.body))
        assertEquals(403, PageBridge.apiAnswer(false, null, "not_allowed").status)
        assertEquals(429, PageBridge.apiAnswer(false, null, "rate_limited").status)
        assertEquals(503, PageBridge.apiAnswer(false, null, "internal_error").status)
        assertEquals(502, PageBridge.apiAnswer(true, mapOf("status" to 9000L), null).status)
    }

    private fun part(i: Int, of: Int, body: String, build: String = "build-1", size: Int = 11) = PageBridge.filePart(
        mapOf("status" to 200L, "type" to "text/javascript; charset=utf-8", "parts" to of.toLong(), "part" to i.toLong(), "size" to size.toLong(), "build" to build,
            "body" to Base64.getEncoder().encodeToString(body.toByteArray())),
    )

    @Test
    fun putsPartsTogetherOfOneBuild() {
        val whole = PageBridge.assemble(listOf(part(0, 2, "hello "), part(1, 2, "world")))
        assertEquals(200, whole.status)
        assertEquals("text/javascript", whole.mimeType)
        assertArrayEquals("hello world".toByteArray(), whole.body)
        assertFails { PageBridge.assemble(listOf(part(0, 2, "hello "), part(1, 2, "world", build = "build-2"))) }
        assertFails { PageBridge.assemble(listOf(part(0, 2, "hello "))) }
        assertFails { PageBridge.assemble(listOf(part(1, 2, "world"), part(0, 2, "hello "))) }
        assertEquals(404, PageBridge.assemble(listOf(PageBridge.filePart(mapOf("status" to 404L, "build" to "b")))).status)
        assertFails { PageBridge.filePart(mapOf("status" to 200L, "type" to "x", "parts" to 500L, "part" to 0L, "size" to 1L, "build" to "b", "body" to "")) }
    }

    @Test
    fun eventsReadLikeTheDesktopStream() {
        assertEquals("id: 3\ndata: {\"content\":\"Hi\",\"seq\":3,\"type\":\"text\"}\n\n", String(PageBridge.sse(mapOf("type" to "text", "seq" to 3L, "content" to "Hi"))))
        assertFalse(String(PageBridge.sse(mapOf("type" to "preview", "seq" to 0L))).contains("id:"))
    }

    @Test
    fun streamFramesAndPageCommands() {
        val s = PhoneFrame.parse("""{"type":"stream","ref":"s1","data":{"seq":1,"type":"text"}}""") as PhoneFrame.Stream
        assertEquals("s1", s.ref)
        assertEquals("text", s.data["type"])
        assertFalse((PhoneFrame.parse("""{"type":"stream.end","ref":"s1","status":"dropped"}""") as PhoneFrame.StreamEnd).complete)
        assertEquals(null, PhoneFrame.parse("""{"type":"stream","ref":"s1"}"""))
        assertEquals("""{"body":{"title":"x"},"method":"POST","path":"/api/chat/conversations","ref":"p1","type":"api.call"}""",
            PhoneCommands.apiCall("POST", "/api/chat/conversations", Json.parse("""{"title":"x"}"""), "p1"))
        assertEquals("""{"path":"/","ref":"f1","type":"ui.get"}""", PhoneCommands.uiGet("/", 0, "f1"))
        assertEquals("""{"part":2,"path":"/a.js","ref":"f1","type":"ui.get"}""", PhoneCommands.uiGet("/a.js", 2, "f1"))
    }

    @Test
    fun bridgeTakesOnlyPageRequestsWithABody() {
        assertTrue(BridgeCall.parse("api.call", "a1", mapOf("method" to "POST", "path" to "/api/chat/conversations", "body" to "{}")) is BridgeCall.ApiCall)
        assertEquals(null, BridgeCall.parse("api.call", "a1", mapOf("method" to "GET", "path" to "/api/chat/conversations", "body" to "")))
        assertEquals(null, BridgeCall.parse("api.call", "a1", mapOf("method" to "POST", "path" to "/chat", "body" to "")))
        assertEquals(null, BridgeCall.parse("api.call", "a1", mapOf("method" to "POST", "path" to "/api/x", "body" to "", "extra" to 1)))
    }

    @Test
    fun terminalRequestsThatNeedTheFingerprint() {
        assertEquals(PageBridge.TerminalUse.Open, PageBridge.terminalUse("POST", "/api/terminal/sessions"))
        assertEquals(PageBridge.TerminalUse.None, PageBridge.terminalUse("GET", "/api/terminal"))
        assertEquals(PageBridge.TerminalUse.None, PageBridge.terminalUse("GET", "/api/terminal/prefs"))
        assertEquals(PageBridge.TerminalUse.Session("abc"), PageBridge.terminalUse("GET", "/api/terminal/sessions/abc/stream?after=3"))
        assertEquals(PageBridge.TerminalUse.Session("abc"), PageBridge.terminalUse("POST", "/api/terminal/sessions/abc/input"))
        assertEquals(PageBridge.TerminalUse.None, PageBridge.terminalUse("GET", "/api/chat/conversations"))
        assertEquals("event: output\ndata: {\"data\":\"hi\",\"seq\":4}\n\n", String(PageBridge.sse(mapOf("seq" to 4L, "data" to "hi"), "output")))
        val gate = TerminalGate()
        assertFalse(gate.takeFresh(1000))
        gate.checked(1000)
        assertTrue(gate.takeFresh(20_000))
        assertFalse(gate.takeFresh(40_000))
        gate.add("abc")
        assertTrue(gate.knows("abc"))
        gate.forget()
        assertFalse(gate.knows("abc"))
    }

    private fun assertFails(block: () -> Unit) {
        try { block() } catch (e: PageBridge.BadAnswer) { return }
        throw AssertionError("expected BadAnswer")
    }
}
